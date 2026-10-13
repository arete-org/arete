// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { calendarApi, type CalendarAction } from "@/lib/googleCalendar";
import { CalendarActionCard } from "./CalendarActionCard";
import { applyEvent, parseEvent } from "@/lib/agentStream";
import { restoreConversation } from "@/lib/agentConversation";

vi.mock("@/lib/googleCalendar", () => ({
  calendarApi: { action: vi.fn(), decide: vi.fn(), verify: vi.fn() },
}));
const id = "a".repeat(32);
const action: CalendarAction = {
  id,
  thread_id: "thread-a",
  operation: "create",
  calendar_id: "personal",
  calendar_name: "Personnel",
  timezone: "Europe/Paris",
  before: null,
  after: {
    summary: "Course",
    description: "<script>unsafe()</script>",
    location: "Parc",
    start: { date: "2030-01-01" },
    end: { date: "2030-01-02" },
  },
  status: "pending",
  expires_at: "2030-01-01T00:00:00Z",
  result: {},
};
function mount(identifier = id) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CalendarActionCard id={identifier} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(calendarApi.action).mockResolvedValue(action);
});
afterEach(cleanup);

it("renders the server proposal and approves only its id", async () => {
  vi.mocked(calendarApi.decide).mockResolvedValue({
    ...action,
    status: "succeeded",
    result: { message: "Modification enregistrée." },
  });
  mount();
  expect(await screen.findByText("Course")).toBeTruthy();
  expect(screen.getByText("<script>unsafe()</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Valider" }));
  expect(await screen.findByText("Enregistré")).toBeTruthy();
  expect(calendarApi.decide).toHaveBeenCalledExactlyOnceWith(id, "approve");
  expect(screen.queryByRole("button", { name: "Valider" })).toBeNull();
});

it("refuses without another model request and restores authoritative status on reload", async () => {
  vi.mocked(calendarApi.decide).mockResolvedValue({
    ...action,
    status: "rejected",
  });
  const first = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Refuser" }));
  expect(await screen.findByText("Refusé")).toBeTruthy();
  first.unmount();
  vi.mocked(calendarApi.action).mockResolvedValue({
    ...action,
    status: "rejected",
  });
  mount();
  expect(await screen.findByText("Refusé")).toBeTruthy();
  expect(calendarApi.decide).toHaveBeenCalledTimes(1);
});

it("keeps ambiguous outcomes out of the approval path", async () => {
  vi.mocked(calendarApi.action).mockResolvedValue({
    ...action,
    status: "uncertain",
  });
  vi.mocked(calendarApi.verify).mockResolvedValue({
    ...action,
    status: "succeeded",
  });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Vérifier dans Google" }),
  );
  expect(await screen.findByText("Enregistré")).toBeTruthy();
  expect(calendarApi.verify).toHaveBeenCalledExactlyOnceWith(id);
  expect(calendarApi.decide).not.toHaveBeenCalled();
});

it("requires refresh after a lost decision response", async () => {
  vi.mocked(calendarApi.decide).mockRejectedValue(new Error("offline"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Valider" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByRole("button", { name: "Valider" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  vi.mocked(calendarApi.action).mockResolvedValue({
    ...action,
    status: "succeeded",
  });
  fireEvent.click(screen.getByRole("button", { name: "Actualiser l’état" }));
  await waitFor(() => expect(screen.getByText("Enregistré")).toBeTruthy());
  expect(calendarApi.decide).toHaveBeenCalledTimes(1);
});

it("preserves action IDs through SSE and browser storage without trusting a stored payload", () => {
  const event = parseEvent(JSON.stringify({ type: "calendar_action", id }));
  if (!event) throw new Error("calendar_action must parse");
  const message = applyEvent(
    { role: "assistant", content: "Proposition" },
    event,
  );
  expect(applyEvent(message, event).parts).toHaveLength(1);
  const restored = restoreConversation(JSON.stringify([message]));
  expect(restored[0].parts).toEqual([{ kind: "calendar_action", id }]);
  const forged = restoreConversation(JSON.stringify([{
    ...message,
    parts: [{ kind: "calendar_action", id, status: "succeeded", after: {} }],
  }]));
  expect(forged[0].parts).toEqual([{ kind: "calendar_action", id }]);
  expect(() =>
    parseEvent('{"type":"calendar_action","id":"../decision"}'),
  ).toThrow();
  expect(() =>
    restoreConversation(
      JSON.stringify([
        { ...message, parts: [{ kind: "calendar_action", id: "../" }] },
      ]),
    ),
  ).toThrow();
});

it("rereads an open proposal on remount but never a final outcome", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const show = (identifier: string) =>
    render(
      <QueryClientProvider client={client}>
        <CalendarActionCard id={identifier} />
      </QueryClientProvider>,
    );
  const done = "b".repeat(32);
  vi.mocked(calendarApi.action).mockImplementation(async (identifier) =>
    identifier === done ? { ...action, id: done, status: "succeeded" } : action,
  );
  for (const identifier of [id, done]) {
    const view = show(identifier);
    await waitFor(() => expect(client.getQueryData(["calendarAction", identifier])).toBeTruthy());
    view.unmount();
  }
  show(id);
  show(done);
  expect(await screen.findByText("Enregistré")).toBeTruthy();
  await waitFor(() =>
    expect(vi.mocked(calendarApi.action).mock.calls.filter(([a]) => a === id)).toHaveLength(2),
  );
  expect(vi.mocked(calendarApi.action).mock.calls.filter(([a]) => a === done)).toHaveLength(1);
});
