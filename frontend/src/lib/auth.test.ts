// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, healthApi } from './api';
import { authFetch, authHeaders, endSession, onUnauthorized, setTokenGetter } from './auth';
import { clearPersistedQueries } from './queryPersistence';

vi.mock('./queryPersistence', () => ({ clearPersistedQueries: vi.fn(async () => {}) }));

function answer(status: number, body = '{}') {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return new Headers(init.headers);
}

afterEach(() => {
  setTokenGetter(null);
  vi.unstubAllGlobals();
});

describe('authHeaders', () => {
  it('is empty without a token getter', async () => {
    expect(await authHeaders()).toEqual({});
  });

  it('is empty when the session has no token', async () => {
    setTokenGetter(async () => null);
    expect(await authHeaders()).toEqual({});
  });

  it('carries the session token', async () => {
    setTokenGetter(async () => 'jeton');
    expect(await authHeaders()).toEqual({ Authorization: 'Bearer jeton' });
  });
});

describe('authFetch', () => {
  it('adds the session header next to the caller’s own', async () => {
    const fetchMock = answer(200);
    setTokenGetter(async () => 'jeton');
    await authFetch('/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const headers = sentHeaders(fetchMock);
    expect(headers.get('Authorization')).toBe('Bearer jeton');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('sends nothing extra while sign-in is off', async () => {
    const fetchMock = answer(200);
    await authFetch('/api/x');
    expect(sentHeaders(fetchMock).has('Authorization')).toBe(false);
  });
});

describe('fetchAPI on 401', () => {
  it('throws and reports the lost session when sign-in is on', async () => {
    answer(401, '{"detail":"Session expirée"}');
    setTokenGetter(async () => 'jeton');
    const lost = vi.fn();
    const stop = onUnauthorized(lost);
    try {
      await expect(healthApi.check()).rejects.toMatchObject({ status: 401, detail: 'Session expirée' });
      expect(lost).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('throws without reporting when sign-in is off', async () => {
    answer(401);
    const lost = vi.fn();
    const stop = onUnauthorized(lost);
    try {
      await expect(healthApi.check()).rejects.toBeInstanceOf(ApiError);
      expect(lost).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

describe('endSession', () => {
  function browser() {
    const reload = vi.fn();
    const remove = vi.fn(async () => true);
    vi.stubGlobal('window', { location: { reload } });
    vi.stubGlobal('caches', { delete: remove });
    return { reload, remove };
  }

  it('signs out, resets, drops the API and persisted query caches, then reloads', async () => {
    const { reload, remove } = browser();
    const order: string[] = [];
    const reset = () => {
      order.push('reset');
    };
    remove.mockImplementation(async () => {
      order.push('cache');
      return true;
    });
    reload.mockImplementation(() => order.push('reload'));
    vi.mocked(clearPersistedQueries).mockImplementation(async () => {
      order.push('persisted');
    });
    setTokenGetter(async () => 'jeton');
    const signOut = vi.fn(async (then: () => Promise<void>) => {
      order.push('clerk');
      await then();
    });
    await endSession(signOut, reset);
    expect(order).toEqual(['clerk', 'reset', 'cache', 'persisted', 'reload']);
    expect(remove).toHaveBeenCalledWith('api-cache');
    expect(await authHeaders()).toEqual({});
  });

  it('still cleans up when Clerk had no session to end', async () => {
    const { reload, remove } = browser();
    await endSession(async () => undefined);
    expect(remove).toHaveBeenCalledWith('api-cache');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves everything in place when the sign-out fails', async () => {
    const { reload, remove } = browser();
    await expect(
      endSession(async () => {
        throw new Error('réseau');
      })
    ).rejects.toThrow('réseau');
    expect(remove).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
