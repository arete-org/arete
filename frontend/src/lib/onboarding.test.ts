// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDraft, readDraft, writeDraft, clearDraft } from './onboarding';

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('private onboarding drafts', () => {
  it('resumes one athlete without exposing their answers to another account', () => {
    const first = newDraft();
    first.answers.constraints = 'Garde des enfants le mercredi';
    first.step = 3; first.deferred = true;
    writeDraft(7, first);
    expect(readDraft(7)).toEqual(first);
    expect(readDraft(8).answers.constraints).toBeNull();
    clearDraft(8);
    expect(readDraft(7).answers.constraints).toBe(first.answers.constraints);
  });

  it('retains a corrupt source rather than silently replacing it with empty answers', () => {
    const key = 'arete.onboarding.v1.athlete.7';
    localStorage.setItem(key, '{invalid');
    expect(() => readDraft(7)).toThrow();
    expect(localStorage.getItem(key)).toBe('{invalid');
  });

  it('reports unavailable storage and keeps the caller’s draft intact', () => {
    const draft = newDraft(); draft.answers.description = 'Progresser doucement';
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('QuotaExceededError'); });
    expect(() => writeDraft(7, draft)).toThrow();
    expect(draft.answers.description).toBe('Progresser doucement');
  });
});
