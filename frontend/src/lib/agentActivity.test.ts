import { describe, expect, it } from 'vitest';
import { toolLabel } from './agentActivity';

describe('memory outcomes', () => {
  it.each([
    ['created', 'Information enregistrée'],
    ['updated', 'Information corrigée'],
    ['already_present', 'Information déjà mémorisée'],
    ['needs_clarification', 'Souvenir à clarifier'],
  ])('reports %s truthfully', (action, label) => {
    expect(toolLabel({ name: 'remember_fact', status: 'done', output: { text: JSON.stringify({ action }), truncated: false } })).toBe(label);
  });
  it('does not turn errors into success or crash on a truncated preview', () => {
    expect(toolLabel({ name: 'remember_fact', status: 'error', output: { text: '{"action":"created"}', truncated: false } })).toBe('Action non aboutie');
    expect(toolLabel({ name: 'remember_fact', status: 'done', output: { text: '{"action":', truncated: true } })).toBe('Vérification mémoire terminée');
  });
});
