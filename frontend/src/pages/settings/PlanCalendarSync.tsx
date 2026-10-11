import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  calendarApi,
  type CalendarStatus,
  type GoogleCalendarInfo,
} from "@/lib/googleCalendar";
import { Button, Select } from "@/components/ui";

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });

const plural = (count: number, word: string) =>
  `${count} ${word}${count > 1 ? "s" : ""}`;

/**
 * The standing authorization to follow the training plan into one of the
 * account's writable calendars (services/calendar_plan.py). Turning it off
 * keeps the events; removing them is a separate, explicit action.
 */
export function PlanCalendarSync({
  status,
  calendars,
}: {
  status: CalendarStatus;
  calendars: GoogleCalendarInfo[];
}) {
  const cache = useQueryClient();
  const [target, setTarget] = useState("");
  const update = (result: CalendarStatus) =>
    cache.setQueryData(["calendarStatus"], result);
  const configure = useMutation({
    mutationFn: calendarApi.planSync,
    onSuccess: update,
  });
  const remove = useMutation({
    mutationFn: calendarApi.removePlanEvents,
    onSuccess: update,
  });
  const plan = status.plan;
  if (!plan) return null;
  const writable = calendars.filter((c) =>
    status.selection.writable.includes(c.id),
  );
  const chosen = target || plan.calendar_id || writable[0]?.id || "";
  const busy = configure.isPending || remove.isPending;
  const error = configure.error || remove.error;
  return (
    <section
      aria-label="Plan d’entraînement dans Google Calendar"
      className="space-y-2 border-t border-text-muted/10 pt-3 text-xs"
    >
      <div className="font-sans text-sm text-text-primary">
        Plan d’entraînement
      </div>
      <p className="text-text-muted">
        Les séances prévues des 28 prochains jours apparaissent dans le
        calendrier choisi et suivent chaque modification du plan. Arete ne
        touche qu’aux événements qu’il a créés.
      </p>
      <p className="text-text-muted">
        Conseil : crée d’abord un calendrier « Arete » dans Google Calendar,
        puis coche-le en Modification ci-dessus.
      </p>
      {writable.length === 0 ? (
        <p className="text-text-muted">
          Aucun calendrier modifiable sélectionné.
        </p>
      ) : (
        <label className="flex items-center gap-2">
          Calendrier du plan
          <Select
            className="w-auto py-1 text-xs"
            value={chosen}
            disabled={busy}
            onChange={(e) => {
              setTarget(e.target.value);
              if (plan.enabled)
                configure.mutate({ enabled: true, calendar_id: e.target.value });
            }}
          >
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.summary}
              </option>
            ))}
          </Select>
        </label>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={plan.enabled}
          disabled={busy || (!plan.enabled && !chosen)}
          onChange={(e) =>
            configure.mutate(
              e.target.checked
                ? { enabled: true, calendar_id: chosen }
                : { enabled: false },
            )
          }
        />
        Synchroniser le plan d’entraînement
      </label>
      {(error || plan.error) && (
        <p role="alert" className="break-words text-danger-red">
          {error ? error.message : plan.error}
        </p>
      )}
      <p className="text-text-secondary">
        {plural(plan.events, "événement")} dans Google Calendar
        {plan.synced_at &&
          ` · dernière synchronisation le ${formatWhen(plan.synced_at)}`}
      </p>
      {!plan.enabled && plan.events > 0 && (
        <div className="space-y-2">
          <p className="text-text-muted">
            Synchronisation arrêtée : les événements déjà créés restent dans
            Google.
          </p>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            Retirer les événements du plan
          </Button>
        </div>
      )}
    </section>
  );
}
