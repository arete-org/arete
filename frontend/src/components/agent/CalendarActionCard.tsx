import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  calendarApi,
  type CalendarAction,
  type CalendarEventSnapshot,
} from "@/lib/googleCalendar";
import { Button } from "@/components/ui";

const STATUS: Record<CalendarAction["status"], string> = {
  pending: "À valider",
  executing: "Exécution en cours",
  succeeded: "Enregistré",
  rejected: "Refusé",
  expired: "Proposition expirée",
  invalidated: "Permissions modifiées",
  failed: "Échec — nouvelle proposition nécessaire",
  uncertain: "Résultat à vérifier",
};

function Snapshot({
  label,
  event,
  timezone,
}: {
  label: string;
  event: CalendarEventSnapshot | null;
  timezone: string;
}) {
  if (!event) return null;
  const point = (value: CalendarEventSnapshot["start"]) =>
    value.date ??
    (value.dateTime
      ? new Intl.DateTimeFormat("fr-FR", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: value.timeZone || timezone,
        }).format(new Date(value.dateTime))
      : "Date indisponible");
  return (
    <div className="rounded bg-void/50 p-3">
      <p className="font-medium text-text-muted">{label}</p>
      <p className="mt-1 font-medium">{event.summary || "Sans titre"}</p>
      <p>
        {point(event.start)} → {point(event.end)}
      </p>
      <p className="text-text-muted">
        {event.start.date
          ? "Journée entière · fin exclusive"
          : event.start.timeZone || timezone}
      </p>
      {event.location && (
        <p className="mt-1 whitespace-pre-wrap break-words">{event.location}</p>
      )}
      {event.description && (
        <p className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">
          {event.description}
        </p>
      )}
    </div>
  );
}

/** Outcomes the server never changes again (services/calendar_repository.py). */
const FINAL: ReadonlySet<CalendarAction["status"]> = new Set([
  "succeeded",
  "rejected",
  "expired",
  "invalidated",
  "failed",
]);

export function CalendarActionCard({ id }: { id: string }) {
  const cache = useQueryClient();
  const key = ["calendarAction", id];
  // Reopening the coach rereads only actions whose outcome can still change.
  const query = useQuery({
    queryKey: key,
    queryFn: () => calendarApi.action(id),
    retry: false,
    staleTime: (q) => (q.state.data && FINAL.has(q.state.data.status) ? Infinity : 0),
  });
  const mutation = useMutation({
    mutationFn: (decision: "approve" | "reject" | "verify") =>
      decision === "verify"
        ? calendarApi.verify(id)
        : calendarApi.decide(id, decision),
    retry: false,
    onSuccess: (action) => cache.setQueryData(["calendarAction", id], action),
  });
  const action = query.data;
  const expiresAt = action?.expires_at;
  const status = action?.status;
  const refetch = query.refetch;
  useEffect(() => {
    if (!expiresAt || status !== "pending") return;
    const delay = Math.max(
      0,
      Math.min(900_000, Date.parse(expiresAt) - Date.now() + 100),
    );
    const timeout = window.setTimeout(() => {
      void refetch();
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [expiresAt, status, refetch]);
  if (!action)
    return (
      <section
        aria-label="Action Google Calendar"
        className="my-3 rounded-xl border border-text-muted/20 p-3 text-xs"
      >
        {query.isError
          ? "Proposition Calendar indisponible."
          : "Chargement de la proposition Calendar…"}
        {query.isError && (
          <Button size="sm" onClick={() => void query.refetch()}>
            Actualiser
          </Button>
        )}
      </section>
    );
  const pending = action.status === "pending" && !query.isError;
  return (
    <section
      aria-label="Action Google Calendar"
      className="my-3 space-y-3 rounded-xl border border-neon-cyan/30 bg-shadow/40 p-3 text-xs text-text-secondary"
    >
      <div className="font-medium text-text-primary">
        Google Calendar ·{" "}
        {action.operation === "create"
          ? "Créer"
          : action.operation === "update"
            ? "Modifier"
            : "Supprimer"}{" "}
        un événement
      </div>
      <p>{action.calendar_name}</p>
      <Snapshot
        label="Avant"
        event={action.before}
        timezone={action.timezone}
      />
      <Snapshot label="Après" event={action.after} timezone={action.timezone} />
      <p role="status">{STATUS[action.status]}</p>
      {action.result.message && <p>{action.result.message}</p>}
      {mutation.isError && (
        <p role="alert" className="text-danger-red">
          Réponse indisponible. Actualise l’état avant toute nouvelle action.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {pending && (
          <>
            <Button
              size="sm"
              variant="green"
              disabled={mutation.isPending || mutation.isError}
              onClick={() => mutation.mutate("approve")}
            >
              Valider
            </Button>
            <Button
              size="sm"
              disabled={mutation.isPending || mutation.isError}
              onClick={() => mutation.mutate("reject")}
            >
              Refuser
            </Button>
          </>
        )}
        {action.status === "uncertain" && (
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("verify")}
          >
            Vérifier dans Google
          </Button>
        )}
        <Button
          size="sm"
          disabled={query.isFetching || mutation.isPending}
          onClick={() => {
            mutation.reset();
            void query.refetch();
          }}
        >
          Actualiser l’état
        </Button>
      </div>
    </section>
  );
}
