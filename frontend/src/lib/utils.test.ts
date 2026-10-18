import { describe, expect, it } from 'vitest';
import { formatPace, readableError } from './utils';

it("shows paces as m'ss per km or m:ss", () => {
  expect(formatPace(210, "'")).toBe("3'30");
  expect(formatPace(210)).toBe('3:30');
});

it('rounds a fractional pace as a whole, never showing 60 seconds', () => {
  expect(formatPace(239.5, "'")).toBe("4'00");
  expect(formatPace(239.4)).toBe('3:59');
});

describe('readableError', () => {
  it('keeps the server’s French detail', () => {
    expect(readableError(new Error('API Error 422: {"detail":"Enregistrement vide"}'))).toBe('Enregistrement vide');
  });

  it('turns a status without detail, a network failure or a timeout into French', () => {
    expect(readableError(new Error('API Error 500: Internal Server Error'))).toBe('Le serveur ne répond pas correctement : réessaie dans un instant.');
    expect(readableError(new Error('API Error 422: {"detail":[{"loc":["body"],"msg":"field required"}]}'))).toBe('Demande refusée par le serveur : vérifie les champs.');
    expect(readableError(new Error('API Error 409'))).toBe('Les données ont changé entre-temps : recharge puis réessaie.');
    expect(readableError(new TypeError('Failed to fetch'))).toBe('Connexion impossible : vérifie ton réseau puis réessaie.');
    expect(readableError(new TypeError('Load failed'))).toBe('Connexion impossible : vérifie ton réseau puis réessaie.');
    expect(readableError(new DOMException('signal timed out', 'TimeoutError'))).toBe('Le serveur met trop de temps à répondre : réessaie.');
  });

  it('lets the app’s own messages through, never an empty one', () => {
    expect(readableError(new Error('Brouillon trop volumineux.'))).toBe('Brouillon trop volumineux.');
    expect(readableError(new Error(''))).toBe('Une erreur inattendue est survenue.');
  });
});
