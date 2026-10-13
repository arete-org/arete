// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { workoutApi, type WorkoutView } from '@/lib/workouts';
import { WorkoutSelection } from './WorkoutSelection';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const view = (id: number, state?: string, updated = '2027-01-10T08:00:00Z'): WorkoutView => ({
  session: { id, revision: 1, date: '2027-01-12', sport: 'running', description: `Footing ${id}`, status: 'pending' },
  export: state ? { session_id: id, operation_id: `op-${id}`, updated_at: updated, state } as WorkoutView['export'] : null,
});

function mount(sessions: WorkoutView[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><WorkoutSelection sessions={sessions} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

it('reads every card in one request and reports a deleted session on its own card', async () => {
  const many = vi.spyOn(workoutApi, 'inspectMany').mockResolvedValue({
    workouts: [1, 2, 3, 4].map(id => view(id, 'scheduled')),
    errors: { 5: 'Cette séance n’existe plus.' },
  });
  const one = vi.spyOn(workoutApi, 'inspect');
  mount([1, 2, 3, 4, 5].map(id => view(id)));
  expect(await screen.findByText('Cette séance n’existe plus.')).toBeTruthy();
  expect(await screen.findAllByText('Programmée dans Garmin Connect')).toHaveLength(4);
  expect(many.mock.calls).toEqual([[[1, 2, 3, 4, 5]]]);
  expect(one).not.toHaveBeenCalled();
});

it('polls only the sessions in progress and stops once none remain', async () => {
  const many = vi.spyOn(workoutApi, 'inspectMany').mockImplementation(async ids => ({
    workouts: ids.map(id => view(id, 'scheduled', '2027-01-10T08:01:00Z')),
    errors: {},
  }));
  mount([view(1, 'scheduled'), view(2, 'working')]);
  await waitFor(() => expect(screen.getAllByText('Programmée dans Garmin Connect')).toHaveLength(2));
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(many.mock.calls).toEqual([[[1, 2]], [[2]]]);
});
