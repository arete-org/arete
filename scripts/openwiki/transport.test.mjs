import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransport, LIMITS, retryDelay } from './transport.mjs';

const URL = 'https://openrouter.ai/api/v1/chat/completions';
const INIT = { method: 'POST', body: JSON.stringify({ model: 'openrouter/free', stream: false }) };

function harness(responses, overrides = {}) {
  let clock = Date.UTC(2026, 9, 10);
  const calls = [];
  const waits = [];
  const logs = [];
  const fetch = createTransport({
    limits: { ...LIMITS, ...overrides },
    now: () => clock,
    wait: async (ms, signal) => { signal?.throwIfAborted(); waits.push(ms); clock += ms; },
    random: () => 0,
    log: (line) => logs.push(line),
    fetch: async (url, init) => {
      calls.push({ at: clock, url, init });
      const response = responses[calls.length - 1];
      assert(response, 'Unexpected extra HTTP attempt');
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(init);
      return response;
    },
  });
  return { fetch, calls, waits, logs };
}

test('passes other endpoints through untouched', async () => {
  const response = new Response('other');
  const h = harness([response]);
  assert.equal(await h.fetch('https://example.com', {}), response);
  assert.deepEqual(h.waits, []);
});

test('paces sequential and concurrent callers and preserves request/response data', async () => {
  const h = harness([new Response('one'), new Response('two'), new Response('three')]);
  const responses = await Promise.all([h.fetch(URL, INIT), h.fetch(URL, INIT), h.fetch(URL, INIT)]);
  assert.deepEqual(await Promise.all(responses.map((r) => r.text())), ['one', 'two', 'three']);
  assert.deepEqual(h.calls.map((c) => c.at - h.calls[0].at), [0, 6000, 12000]);
  assert(h.calls.every((c) => c.init.body === INIT.body));
});

test('429 without headers cools down for a minute before retrying', async () => {
  const h = harness([new Response('busy', { status: 429 }), new Response('ok')]);
  assert.equal(await (await h.fetch(URL, INIT)).text(), 'ok');
  assert.deepEqual(h.waits, [60000]);
});

test('honors Retry-After seconds rather than retrying before the server allows', async () => {
  const h = harness([new Response('busy', { status: 429, headers: { 'retry-after': '90' } }), new Response('ok')]);
  await h.fetch(URL, INIT);
  assert.deepEqual(h.waits, [90000]);
});

test('parses HTTP dates, reset epochs, expired and malformed hints', () => {
  const now = Date.UTC(2026, 9, 10);
  assert.equal(retryDelay(new Headers({ 'retry-after': new Date(now + 90000).toUTCString() }), now), 90000);
  assert.equal(retryDelay(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 75) }), now), 75000);
  assert.equal(retryDelay(new Headers({ 'x-ratelimit-reset': String(now + 75000) }), now), 75000);
  assert.equal(retryDelay(new Headers({ 'retry-after': '30', 'x-ratelimit-reset': String(now + 75000) }), now), 75000);
  assert.equal(retryDelay(new Headers({ 'retry-after': 'invalid', 'x-ratelimit-reset': 'invalid' }), now), 0);
  assert.equal(retryDelay(new Headers({ 'retry-after': new Date(now - 1000).toUTCString() }), now), 0);
});

test('does not silently shorten an excessive provider cooldown', async () => {
  const h = harness([new Response('busy', { status: 429, headers: { 'retry-after': '3600' } })]);
  await assert.rejects(h.fetch(URL, INIT), /cooldown exceeds/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.waits, []);
});

test('retries transient HTTP errors and network disconnects with increasing delays', async () => {
  const h = harness([
    new Response('busy', { status: 503 }), new TypeError('fetch failed'),
    new Response('gateway', { status: 502 }), new Response('ok'),
  ]);
  await h.fetch(URL, INIT);
  assert.deepEqual(h.waits, [30000, 60000, 120000]);
});

test('a disconnect while reading the body is retried before tools can run', async () => {
  const broken = new Response(new ReadableStream({ start(c) { c.error(new TypeError('socket closed')); } }));
  const h = harness([broken, new Response('ok')]);
  assert.equal(await (await h.fetch(URL, INIT)).text(), 'ok');
  assert.equal(h.calls.length, 2);
});

test('times out stalled responses and bounds retries', async () => {
  const stall = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const h = harness([stall, new Response('ok')], { requestTimeoutMs: 5 });
  await h.fetch(URL, INIT);
  assert.equal(h.calls.length, 2);
});

test('the timeout includes a stalled body after successful headers', async () => {
  const stall = ({ signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }));
  const h = harness([stall, new Response('ok')], { requestTimeoutMs: 5 });
  assert.equal(await (await h.fetch(URL, INIT)).text(), 'ok');
  assert.equal(h.calls.length, 2);
});

test('aborting during a cooldown does not resend inference', async () => {
  const controller = new AbortController();
  let requests = 0;
  const fetch = createTransport({
    fetch: async () => { requests += 1; return new Response('busy', { status: 429 }); },
    wait: async (_, signal) => { controller.abort(); signal.throwIfAborted(); },
    log: () => {},
  });
  await assert.rejects(fetch(URL, { ...INIT, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('terminal exhaustion cannot be multiplied by SDK retries', async () => {
  const h = harness(Array.from({ length: 4 }, () => new Response('busy', { status: 429 })));
  await assert.rejects(h.fetch(URL, INIT), /persisted after 4 attempts/);
  await assert.rejects(h.fetch(URL, INIT), { name: 'AbortError' });
  assert.equal(h.calls.length, 4);
});

for (const status of [400, 401, 402, 403, 404, 422]) {
  test(`HTTP ${status} stops without spending retries`, async () => {
    const h = harness([new Response('permanent', { status })]);
    await assert.rejects(h.fetch(URL, INIT), new RegExp(`non-retryable HTTP ${status}`));
    await assert.rejects(h.fetch(URL, INIT));
    assert.equal(h.calls.length, 1);
  });
}

test('daily quota exhaustion is terminal, unlike per-minute exhaustion', async () => {
  const h = harness([new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}', { status: 429 })]);
  await assert.rejects(h.fetch(URL, INIT), /daily free-model quota exhausted/);
  assert.equal(h.calls.length, 1);
});

test('preserves OpenWiki retry handling for a transient provider 404', async () => {
  const error = { message: 'Provider returned error', metadata: { raw: '', provider_name: 'test' } };
  const h = harness([Response.json({ error }, { status: 404 }), new Response('ok')]);
  await h.fetch(URL, INIT);
  assert.equal(h.calls.length, 2);
  const missing = harness([Response.json({ error: { message: 'Unknown model' } }, { status: 404 })]);
  await assert.rejects(missing.fetch(URL, INIT), /non-retryable HTTP 404/);
  assert.equal(missing.calls.length, 1);
});

test('request and elapsed-time budgets fail before the next HTTP request', async () => {
  const h = harness([new Response('ok')], { requests: 1 });
  await h.fetch(URL, INIT);
  await assert.rejects(h.fetch(URL, INIT), /request budget exhausted/);
  const timed = harness([new Response('busy', { status: 429 })], { runTimeoutMs: 30000 });
  await assert.rejects(timed.fetch(URL, INIT), /remaining run budget/);
  assert.equal(timed.calls.length, 1);
});

test('an attempt cut off by the run deadline is reported as the deadline, not the network', async () => {
  // Run 39406173635: request 67 started seconds before the run budget ended and
  // was logged as a network failure while the transport stopped on its deadline.
  let clock = 0;
  const logs = [];
  const fetch = createTransport({
    limits: { ...LIMITS, runTimeoutMs: 60000 },
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    random: () => 0,
    log: (line) => logs.push(line),
    fetch: async (_, { signal }) => {
      if (clock === 0) {
        clock = 59995;
        return new Response('ok');
      }
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => { clock = 60000; reject(signal.reason); }, { once: true });
      });
    },
  });
  await fetch(URL, INIT);
  await assert.rejects(fetch(URL, INIT), /run deadline exceeded \(1-minute HTTP budget\)/);
  assert.deepEqual(logs.slice(1), [
    `OpenWiki HTTP 2/${LIMITS.requests}: attempt 1/4, cut off by the run deadline`,
    `OpenWiki transport stopped after 2/${LIMITS.requests} HTTP requests: run deadline exceeded (1-minute HTTP budget)`,
  ]);
});

test('attempt logs distinguish request timeouts from network errors', async () => {
  const stall = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  const h = harness([stall, reset, new Response('ok')], { requestTimeoutMs: 5 });
  await h.fetch(URL, INIT);
  assert.deepEqual(h.logs, [
    `OpenWiki HTTP 1/${LIMITS.requests}: attempt 1/4, no response within 0.005 s`,
    `OpenWiki HTTP 2/${LIMITS.requests}: attempt 2/4, network error (UND_ERR_SOCKET)`,
    `OpenWiki HTTP 3/${LIMITS.requests}: attempt 3/4, 200`,
  ]);
});

test('the stop reason is logged once even when the caller swallows the error', async () => {
  const h = harness([new Response('ok')], { requests: 1 });
  await h.fetch(URL, INIT);
  await h.fetch(URL, INIT).catch(() => {});
  await h.fetch(URL, INIT).catch(() => {});
  assert.deepEqual(h.logs.filter((line) => line.includes('stopped')), [
    'OpenWiki transport stopped after 1/1 HTTP requests: total HTTP request budget exhausted',
  ]);
});

test('cancellation interrupts backoff without retrying', async () => {
  const controller = new AbortController();
  const h = harness([() => { controller.abort(); throw controller.signal.reason; }]);
  await assert.rejects(h.fetch(URL, { ...INIT, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.waits, []);
});

test('queue admission is bounded and aborts already queued work', async () => {
  const h = harness([], { pending: 1 });
  const first = h.fetch(URL, INIT);
  await assert.rejects(h.fetch(URL, INIT), /queue limit/);
  await assert.rejects(first, /queue limit/);
  assert.equal(h.calls.length, 0);
});

test('contract errors do not get retried', async () => {
  const h = harness([]);
  await assert.rejects(h.fetch(URL, { ...INIT, body: '{"model":"paid","stream":false}' }), /Only free routing/);
  assert.equal(h.calls.length, 0);
  const huge = harness([new Response('x'.repeat(2 * 1024 * 1024 + 1))]);
  await assert.rejects(huge.fetch(URL, INIT), /exceeds 2 MiB/);
  assert.equal(huge.calls.length, 1);
});
