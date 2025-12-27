/**
 * @arete-module: PseudonymizationTests
 * @arete-risk: low
 * @arete-ethics: high
 * @arete-scope: test
 *
 * @description: Unit tests to ensure Discord identifiers are namespaced, hashed, and safely
 * shortened for display without leaking raw values.
 *
 * @impact
 * Risk: Test failures may hide regressions in privacy protections.
 * Ethics: Helps prevent raw identifiers from leaking into logs or storage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hmacId,
  pseudonymizeActorId,
  pseudonymizeIncidentPointers,
  shortHash
} from '../src/shared/pseudonymization';

const SECRET_A = 'test-secret-a';
const SECRET_B = 'test-secret-b';

test('hmacId hashes consistently per namespace and secret', () => {
  const userHash = hmacId(SECRET_A, '123', 'user');
  const userHashRepeat = hmacId(SECRET_A, '123', 'user');
  const guildHash = hmacId(SECRET_A, '123', 'guild');
  const userHashOtherSecret = hmacId(SECRET_B, '123', 'user');

  assert.equal(userHash.length, 64, 'HMAC digest should be 64 hex characters');
  assert.equal(userHash, userHashRepeat, 'HMAC should be deterministic for same input');
  assert.notEqual(userHash, guildHash, 'Namespace prevents collisions across ID types');
  assert.notEqual(userHash, userHashOtherSecret, 'Different secrets must produce different hashes');
});

test('shortHash truncates without emptying', () => {
  const hash = hmacId(SECRET_A, '456', 'channel');
  const short = shortHash(hash, 10);
  assert.equal(short.length, 10);
  assert.ok(hash.startsWith(short), 'short hash should be prefix of full digest');
  assert.equal(shortHash(hash, 0).length, 1, 'length is clamped to minimum of 1');
});

test('pseudonymizeIncidentPointers hashes Discord IDs and preserves other fields', () => {
  const pointers = {
    guildId: '123',
    channelId: '456',
    messageId: '789',
    responseId: 'resp-001',
    traceId: 'trace-abc',
    jumpUrl: 'https://discord.com/channels/123/456/789',
    modelVersion: 'gpt-4.1-mini'
  };

  const hashed = pseudonymizeIncidentPointers(pointers, SECRET_A);

  assert.equal(hashed.guildId?.length, 64);
  assert.equal(hashed.channelId?.length, 64);
  assert.equal(hashed.messageId?.length, 64);
  assert.equal(hashed.responseId, pointers.responseId, 'responseId should remain unchanged');
  assert.equal(hashed.traceId, pointers.traceId, 'traceId should remain unchanged');
  assert.equal(hashed.jumpUrl, pointers.jumpUrl, 'jumpUrl should remain unchanged');
  assert.equal(hashed.modelVersion, pointers.modelVersion, 'modelVersion should remain unchanged');

  assert.notEqual(hashed.guildId, pointers.guildId, 'raw guildId should not persist');
});

test('pseudonymizeIncidentPointers handles missing or empty IDs gracefully', () => {
  const hashed = pseudonymizeIncidentPointers(
    { guildId: '', channelId: undefined, messageId: null as unknown as string },
    SECRET_A
  );

  assert.equal(hashed.guildId, '');
  assert.equal(hashed.channelId, undefined);
  assert.equal(hashed.messageId, null);
});

test('pseudonymizeActorId is idempotent and null-safe', () => {
  const raw = '123456789012345678';
  const hashed = pseudonymizeActorId(raw, SECRET_A);
  const hashedAgain = pseudonymizeActorId(hashed!, SECRET_A);

  assert.equal(hashed?.length, 64);
  assert.equal(hashed, hashedAgain, 'Should not double-hash existing digests');
  assert.equal(pseudonymizeActorId(null, SECRET_A), null);
  assert.equal(pseudonymizeActorId(undefined, SECRET_A), null);
});
