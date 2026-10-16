import { authFetch } from "./auth";

const API_BASE = "/api";

/** A non-2xx answer; `detail` is FastAPI's message (French) when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(status: number, body: string) {
    super(`API Error ${status}: ${body}`);
    this.status = status;
    this.detail = parseDetail(body);
  }
}

function parseDetail(body: string): string | null {
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail;
    return typeof detail === "string" ? detail : null;
  } catch {
    return null;
  }
}

/** The record when the answer is one (an object with a numeric id), else null.
 *  "Nothing yet" endpoints answer null; anything else must not pass for a record. */
function recordOrNull<T extends { id: number }>(data: unknown): T | null {
  return data !== null && typeof data === "object" && !Array.isArray(data) &&
    typeof (data as { id?: unknown }).id === "number"
    ? (data as T)
    : null;
}

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await authFetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }

  // 204 No Content (subscription routes): there is no body to parse.
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}

// ========================= //
// METRICS API              //
// ========================= //

export const metricsApi = {
  getFitness: () =>
    fetchAPI<import("@/types").FitnessMetrics>("/metrics/fitness"),

  getWorkload: () =>
    fetchAPI<import("@/types").WorkloadMetrics>("/metrics/workload"),

  getPlayerStats: () =>
    fetchAPI<import("@/types").PlayerStats>("/metrics/player-stats"),

  /** Daniels VDOT, training paces and race equivalents, or why there are none. */
  getPaces: () => fetchAPI<import("@/types").TrainingPaces>("/metrics/paces"),
};

// ========================= //
// RACE GOALS API            //
// ========================= //

export const goalsApi = {
  list: (includePast = false) =>
    fetchAPI<import("@/types").Goal[]>(`/goals?include_past=${includePast}`),

  /** The next active race, or null. */
  next: async () =>
    recordOrNull<import("@/types").Goal>(await fetchAPI<unknown>("/goals/next")),

  create: (goal: import("@/types").GoalCreate) =>
    fetchAPI<import("@/types").Goal>("/goals", {
      method: "POST",
      body: JSON.stringify(goal),
    }),

  /** Also deletes the goal's future generated sessions. */
  remove: (id: number) => fetchAPI<void>(`/goals/${id}`, { method: "DELETE" }),

  previewPlan: (id: number) =>
    fetchAPI<import("@/types").PlanPreview>(`/goals/${id}/plan/preview`, {
      method: "POST",
    }),

  /** Writes the plan; days already holding another session are skipped. */
  writePlan: (id: number) =>
    fetchAPI<import("@/types").PlanWriteResult>(`/goals/${id}/plan`, {
      method: "POST",
    }),

  deletePlan: (id: number) =>
    fetchAPI<{ deleted: number }>(`/goals/${id}/plan`, { method: "DELETE" }),

  getProjection: async (id: number) => {
    const data = await fetchAPI<import("@/types").GoalProjection>(`/goals/${id}/projection`);
    // A projection without its series cannot be drawn: treat it as none.
    return data && Array.isArray(data.series) ? data : null;
  },
};

// ========================= //
// ATHLETE FACTS API         //
// ========================= //

export const athleteFactsApi = {
  list: () => fetchAPI<import("@/types").AthleteFact[]>("/athlete-facts"),

  create: (fact: { kind: import("@/types").FactKind; text: string; since?: string; valid_until?: string }) =>
    fetchAPI<import("@/types").AthleteFact>("/athlete-facts", {
      method: "POST",
      body: JSON.stringify(fact),
    }),

  update: (
    id: number,
    patch: Partial<Pick<import("@/types").AthleteFact, "kind" | "text" | "status" | "since" | "evidence" | "valid_until" | "source_ref">> & { expected_revision: number }
  ) =>
    fetchAPI<import("@/types").AthleteFact>(`/athlete-facts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  history: (id: number) => fetchAPI<import("@/types").AthleteFact[]>(`/athlete-facts/${id}/history`),

  remove: (id: number, revision: number) =>
    fetchAPI<void>(`/athlete-facts/${id}?expected_revision=${revision}`, { method: "DELETE" }),
};

// ========================= //
// GARMIN API               //
// ========================= //

export interface PlannedSessionCreate {
  prescription?: import("./documents").Prescription | null;
  date: string;
  sport?: string;
  session_type: string;
  target_duration_min?: number;
  target_distance_km?: number;
  target_hr_zone?: string;
  target_intensity?: string;
  description?: string;
  source?: string;
}

export const garminApi = {
  refreshThreshold: () =>
    fetchAPI<{
      updated: boolean;
      reason: string;
      lthr?: number | null;
      previous_lthr?: number | null;
      threshold_pace_sec_km?: number | null;
      measured_on?: string | null;
    }>("/garmin/sync/threshold", { method: "POST" }),

  recomputeZones: () =>
    fetchAPI<{
      sessions: number;
      from_fit: number;
      from_laps: number;
      unchanged: number;
      model: import("@/types").HrZoneModel;
    }>("/garmin/sync/recompute-zones", { method: "POST" }),

  getPlanned: (startDate?: string, endDate?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    return fetchAPI<import("@/types").PlannedSession[]>(
      `/garmin/planned?${params}`
    );
  },

  createPlanned: (session: PlannedSessionCreate) =>
    fetchAPI<import("@/types").PlannedSession>("/garmin/planned", {
      method: "POST",
      body: JSON.stringify(session),
    }),

  getActual: (startDate?: string, endDate?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    return fetchAPI<import("@/types").ActualSession[]>(
      `/garmin/actual?${params}`
    );
  },

  createActual: (session: {
    date: string;
    sport: string;
    name: string | null;
    duration_min: number;
    distance_km: number | null;
    avg_hr: number | null;
    rpe: number | null;
    notes: string | null;
  }) =>
    fetchAPI<import("@/types").ActualSession>("/garmin/actual", {
      method: "POST",
      body: JSON.stringify(session),
    }),

  updatePlanned: (id: number, revision: number, session: Omit<PlannedSessionCreate, 'source' | 'sport'>) =>
    fetchAPI<import("@/types").PlannedSession>(`/garmin/planned/${id}`, {
      method: "PUT", body: JSON.stringify({ ...session, revision }),
    }),

  deletePlanned: (id: number, revision?: number) =>
    fetchAPI<{ message: string }>(`/garmin/planned/${id}${revision ? `?revision=${revision}` : ''}`, { method: "DELETE" }),

  setPlannedStatus: (id: number, status: "pending" | "completed" | "skipped", revision?: number) =>
    fetchAPI<import("@/types").PlannedSession>(`/garmin/planned/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, revision }),
    }),

  getSummary: (startDate?: string, endDate?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);
    return fetchAPI<import("@/types").MatchSummary>(`/garmin/summary?${params}`);
  },

  uploadFit: async (file: File, autoMatch = true) => {
    const formData = new FormData();
    formData.append("file", file);
    const response = await authFetch(
      `${API_BASE}/garmin/upload-fit?auto_match=${autoMatch}`,
      {
        method: "POST",
        body: formData,
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Upload Error: ${error}`);
    }
    return response.json();
  },

  // Sync endpoints
  getSyncStatus: () =>
    fetchAPI<import("@/types").SyncStatus>("/garmin/sync/status"),

  logout: () =>
    fetchAPI<{ status: string }>("/garmin/sync/logout", { method: "POST" }),

  syncActivities: (options: {
    start_date?: string;
    end_date?: string;
    download_fit?: boolean;
    max_activities?: number;
  }) =>
    fetchAPI<import("@/types").SyncResult>("/garmin/sync/activities", {
      method: "POST",
      body: JSON.stringify(options),
    }),
};

// ========================= //
// STRENGTH API             //
// ========================= //

export const strengthApi = {
  getSessions: (limit = 50) =>
    fetchAPI<import("@/types").StrengthSession[]>(
      `/strength/sessions?limit=${limit}`
    ),

  getSession: (id: number) =>
    fetchAPI<import("@/types").StrengthSession>(`/strength/sessions/${id}`),

  deleteSession: (id: number) =>
    fetchAPI<{ message: string }>(`/strength/sessions/${id}`, {
      method: "DELETE",
    }),

  transcribeWorkout: async (
    clip: { blob: Blob; extension: string },
    signal?: AbortSignal
  ) => {
    const formData = new FormData();
    // The browser sets the multipart boundary; forcing a Content-Type breaks it.
    formData.append("file", clip.blob, `dictation.${clip.extension}`);
    const response = await authFetch(`${API_BASE}/strength/sessions/transcribe`, {
      method: "POST",
      body: formData,
      signal,
    });
    if (!response.ok) {
      throw new Error(`API Error ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<import("@/types").WorkoutTranscription>;
  },

  parseWorkout: (text: string, date?: string, save = false) =>
    fetchAPI<import("@/types").ParsedWorkout>("/strength/sessions/parse", {
      method: "POST",
      body: JSON.stringify({ text, date, save }),
    }),

  getExercises: () =>
    fetchAPI<import("@/types").LibraryExercise[]>("/strength/exercises"),

  getExerciseHistory: (exerciseId: number, limit = 50) =>
    fetchAPI<import("@/types").ExerciseHistoryEntry[]>(
      `/strength/exercises/${exerciseId}/history?limit=${limit}`
    ),

  getExerciseRecords: (exerciseId: number) =>
    fetchAPI<import("@/types").ExercisePersonalRecords>(
      `/strength/exercises/${exerciseId}/prs`
    ),

  getExerciseSuggestion: (exerciseId: number) =>
    fetchAPI<import("@/types").ExerciseSuggestionResponse>(
      `/strength/exercises/${exerciseId}/suggestion`
    ),

  getMuscleStats: (days = 7) =>
    fetchAPI<import("@/types").MuscleStatsResponse>(
      `/strength/stats/muscles?days=${days}`
    ),

  // Garmin linking
  getGarminCandidates: (sessionId: number) =>
    fetchAPI<{
      candidates: Array<{
        id: number;
        date: string;
        sport: string;
        activity_type: string;
        duration_seconds: number;
        source: string;
      }>;
      session_date: string;
    }>(`/strength/sessions/${sessionId}/garmin-candidates`),

  linkToGarmin: (sessionId: number, garminActivityId: number | null) =>
    fetchAPI<{ message: string }>(
      `/strength/sessions/${sessionId}/link-garmin`,
      {
        method: "POST",
        body: JSON.stringify({ garmin_activity_id: garminActivityId }),
      }
    ),
};

// ========================= //
// HEALTH API               //
// ========================= //

export const healthApi = {
  check: () =>
    fetchAPI<{ status: string; database: string }>("/health"),
};

// ========================= //
// AUTH API                  //
// ========================= //

/** Whether the server requires sign-in; when it does, Clerk's key for the browser. */
export interface AuthConfig {
  enabled: boolean;
  publishable_key: string | null;
}

export type AccountRole = "athlete" | "admin";

/** The signed-in account; `athlete_id` stays null until the owner attaches an athlete. */
export interface AuthMe {
  email: string;
  name: string | null;
  athlete_id: number | null;
  is_owner: boolean;
  role: AccountRole;
  /** The owner, or an account with the admin role. */
  is_admin: boolean;
}

export const authApi = {
  /** Public and never authenticated: it decides whether the gate loads Clerk at all. */
  config: async () => {
    const response = await fetch(`${API_BASE}/auth/config`);
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return response.json() as Promise<AuthConfig>;
  },

  me: () => fetchAPI<AuthMe>("/auth/me"),
};

// ========================= //
// ADMIN API                 //
// ========================= //

/** One (athlete, login) pair: an athlete with two logins has two, one without any has `user_id` null. */
export interface AdminAccount {
  athlete_id: number;
  user_id: number | null;
  email: string | null;
  name: string | null;
  role: AccountRole;
  is_owner: boolean;
  last_seen_at: string | null;
  last_sync_at: string | null;
  /** Set while the automatic sync holds the athlete; `lease_stuck` once it outlived its deadline. */
  sync_lease_until: string | null;
  lease_stuck: boolean;
  deactivated_at: string | null;
}

/** Admins and the owner; the server enforces who may do what and answers a French `detail` otherwise. */
export interface AdminFeatureFlags {
  glm_flash: boolean;
  glm_flash_available: boolean;
}

export const adminApi = {
  featureFlags: () => fetchAPI<AdminFeatureFlags>("/admin/feature-flags"),
  setFeatureFlags: (glmFlash: boolean) =>
    fetchAPI<AdminFeatureFlags>("/admin/feature-flags", {
      method: "PUT",
      body: JSON.stringify({ glm_flash: glmFlash }),
    }),
  accounts: () => fetchAPI<AdminAccount[]>("/admin/accounts"),

  /** Owner only, never on an owner's row. */
  setRole: (userId: number, role: AccountRole) =>
    fetchAPI<AuthMe>(`/admin/accounts/${userId}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    }),

  deactivate: (athleteId: number) =>
    fetchAPI<void>(`/admin/athletes/${athleteId}/deactivate`, { method: "POST" }),

  reactivate: (athleteId: number) =>
    fetchAPI<void>(`/admin/athletes/${athleteId}/reactivate`, { method: "POST" }),

  /** `released` is false when no sync held the athlete any more. */
  releaseLease: (athleteId: number) =>
    fetchAPI<{ released: boolean }>(`/admin/athletes/${athleteId}/release-lease`, {
      method: "POST",
    }),
};

// ========================= //
// SETTINGS API             //
// ========================= //

export interface UserSettings {
  user_id: number;
  display_name: string;
  email: string | null;
  timezone: string;
  weekly_training_goal: number;
  rest_day_preference: string[];
  fatigue_threshold: number;
  fitness_goal: "maintenance" | "build" | "peak" | "recovery";
  notifications_enabled: boolean;
  coach_briefing_enabled: boolean;
  /** The morning sync adapts today's sessions to readiness and load. */
  auto_adapt_enabled: boolean;
  /** The morning sync sends today's cardio sessions to the Garmin calendar. */
  push_to_garmin_enabled: boolean;
  theme: import('./theme').Theme;
  exercise_abbreviations: Record<string, string>;
  weekly_volume_target_kg: number;
  /** Threshold heart rate: the reference the HR zones are built on. */
  lthr: number | null;
  max_hr: number | null;
  threshold_pace_sec_km: number | null;
  /** Date of the Garmin test the threshold comes from; null when typed by hand. */
  lthr_measured_on: string | null;
  /** Which pushes arrive (every kind spelled out) and the local quiet hours. */
  notification_preferences: NotificationPreferences;
}

/** Mirrors services/settings.NotificationKind; `soon` kinds in CoachTab are not sent yet. */
export type NotificationKind =
  | 'briefing'
  | 'post_session'
  | 'weekly_review'
  | 'adapted_session'
  | 'imports'
  | 'checkin'
  | 'evening'
  | 'automation' | 'eve_reminder';

export interface NotificationPreferences {
  kinds: Record<NotificationKind, boolean>;
  /** "HH:MM" in the athlete's timezone; null sends at any hour. */
  quiet_hours: { start: string; end: string } | null;
}

/** The coach's word on a finished session, or the rule engine's when it is away. */
export interface PostSessionFeedback {
  feedback: string;
  highlights: string[];
  source: "agent" | "rules";
}

/** The day's briefing, or `pending` (no other field) while the coach writes it. */
export interface DailyTip {
  status: "ready" | "pending";
  tip: string | null;
  priority: "info" | "warning" | "alert" | null;
  /** Who wrote it: the coaching agent, or the deterministic rule engine. */
  source: "agent" | "rules" | null;
  generated_at: string | null;
  /** The daily sync rewrote a briefing written before its data. */
  updated_after_sync: boolean;
  /** The stored briefing (absent while pending), for a reaction or a question to the coach. */
  id?: number | null;
  /** When the day's first briefing was written, if this one replaced it. */
  first_written_at?: string | null;
  reaction?: BriefingReaction | null;
  reaction_comment?: string | null;
}

export type BriefingReaction = "up" | "down";

/** One of the previous days' briefings (`GET /tips/history`, at most seven). */
export interface PastBriefing {
  id: number;
  date: string;
  tip: string;
  source: "agent" | "rules";
  generated_at: string | null;
  reaction: BriefingReaction | null;
  reaction_comment: string | null;
}

export const tipsApi = {
  briefing: (id: number) => fetchAPI<PastBriefing>(`/tips/briefings/${id}`),
  /** Reads only: never runs the coach. */
  getDaily: () => fetchAPI<DailyTip>("/tips/daily"),

  /** Writes the day's briefing if it has none: a long request nobody waits on. */
  writeDaily: () => fetchAPI<DailyTip>("/tips/daily", { method: "POST" }),

  /** Idempotent: the same reaction again stores nothing new; `null` withdraws it. */
  react: (briefingId: number, reaction: BriefingReaction | null, comment?: string) =>
    fetchAPI<{ id: number; reaction: BriefingReaction | null; reaction_comment: string | null }>(
      `/tips/briefings/${briefingId}/reaction`,
      { method: "PUT", body: JSON.stringify({ reaction, comment: comment ?? null }) }
    ),

  /** The previous days' briefings, newest first. */
  history: () => fetchAPI<PastBriefing[]>("/tips/history"),

  getPostSession: (
    sessionType: "strength" | "cardio",
    sessionId: number
  ) =>
    fetchAPI<PostSessionFeedback>("/tips/post-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_type: sessionType,
        session_id: sessionId,
      }),
    }),
};

// ========================= //
// STRAVA API              //
// ========================= //

export const stravaApi = {
  getStatus: () =>
    fetchAPI<{
      connected: boolean;
      athlete_name: string | null;
      athlete_id: number | null;
    }>("/strava/status"),

  getAuthorizeUrl: () =>
    fetchAPI<{ url: string }>("/strava/authorize"),

  sync: (days = 30) =>
    fetchAPI<{
      success: boolean;
      imported: number;
      merged: number;
      skipped: number;
      errors: string[];
    }>("/strava/sync", {
      method: "POST",
      body: JSON.stringify({ days }),
    }),

  disconnect: () =>
    fetchAPI<{ success: boolean }>("/strava/disconnect", { method: "DELETE" }),
};

// ========================= //
// ANALYTICS API             //
// ========================= //

export const analyticsApi = {
  getOverview: (period = "30d") =>
    fetchAPI<import("@/types").OverviewResponse>(
      `/analytics/overview?period=${period}`
    ),
  getRecords: (sport = "running") =>
    fetchAPI<import("@/types").RecordsResponse>(
      `/analytics/records?sport=${sport}`
    ),
  getSessions: (limit = 20, offset = 0) =>
    fetchAPI<import("@/types").CardioSessionsResponse>(
      `/analytics/sessions?limit=${limit}&offset=${offset}`
    ),
  getSessionDetail: (id: number) =>
    fetchAPI<import("@/types").ActivityDetail>(`/analytics/sessions/${id}/detail`),
  updateSession: (id: number, data: { rpe?: number | null; notes?: string }) =>
    fetchAPI<{ success: boolean }>(`/analytics/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};

// ========================= //
// GARMIN HEALTH API         //
// ========================= //

export const garminHealthApi = {
  getStatus: () =>
    fetchAPI<{
      tokens_present: boolean;
      days_stored: number;
      first_date: string | null;
      last_date: string | null;
      last_sync: string | null;
    }>("/garmin/health/status"),

  sync: (start: string, end: string) =>
    fetchAPI<{ start: string; end: string; days_synced: number; days_failed: number; errors: string[] }>(
      `/garmin/health/sync?start=${start}&end=${end}`,
      { method: "POST" }
    ),

  getDaily: (date: string) =>
    fetchAPI<{
      date: string;
      hrv_weekly_avg: number | null;
      hrv_last_night: number | null;
      hrv_status: string | null;
      sleep_duration_sec: number | null;
      sleep_score: number | null;
      body_battery_high: number | null;
      stress_avg: number | null;
      stress_max: number | null;
      steps: number | null;
      readiness_score: number | null;
      /** Garmin's own morning Training Readiness (0-100). */
      training_readiness_score: number | null;
      training_readiness_level: string | null;
    }>(`/garmin/health/daily?date=${date}`),

  getRange: (start: string, end: string) =>
    fetchAPI<{
      start: string;
      end: string;
      days: Array<{
        date: string;
        hrv_last_night: number | null;
        hrv_weekly_avg: number | null;
        sleep_score: number | null;
        sleep_duration_sec: number | null;
        body_battery_high: number | null;
        body_battery_low: number | null;
        stress_avg: number | null;
        resting_hr: number | null;
        readiness_score: number | null;
        steps: number | null;
      }>;
    }>(`/garmin/health/range?start=${start}&end=${end}`),
};

export const settingsApi = {
  get: () => fetchAPI<UserSettings>("/settings"),

  update: (settings: Omit<UserSettings, "user_id">) =>
    fetchAPI<UserSettings>("/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
};

// ========================= //
// DAILY PLAN API            //
// ========================= //

export const planApi = {
  getToday: () => fetchAPI<import("@/types").PlanToday>("/plan/today"),

  /** Recomputes now, whatever the auto-adapt setting; idempotent per session per day. */
  adaptNow: () =>
    fetchAPI<import("@/types").PlanToday>("/plan/today/adapt", { method: "POST" }),

  revert: (decisionId: number) =>
    fetchAPI<import("@/types").PlanDecision>(`/plan/decisions/${decisionId}/revert`, {
      method: "POST",
    }),

  /** Last week's review, or null when it was not written yet. */
  getReview: async () =>
    recordOrNull<import("@/types").WeeklyReview>(await fetchAPI<unknown>("/plan/review")),

  /** Written once per week; `refresh` writes again the review shown (`reviewId`). May wait for the coach (~60 s). */
  writeReview: (refresh = false, reviewId?: number) =>
    fetchAPI<import("@/types").WeeklyReview>(
      `/plan/review?refresh=${refresh}${reviewId != null ? `&review_id=${reviewId}` : ""}`,
      { method: "POST" },
    ),

  /** « Ma semaine »: the current review and its week in numbers. */
  getReviewWeek: () => fetchAPI<import("@/types").ReviewWeek>("/plan/review/week"),

  /** Applies the ticked proposals, then the week's key sessions go to Garmin and the calendar. */
  /** `createdAt`: the review's version as the page read it; a rewrite since answers 409. */
  acceptReview: (reviewId: number, indices: number[], createdAt: string | null = null) =>
    fetchAPI<import("@/types").ReviewAccepted>(`/plan/review/${reviewId}/accept`, {
      method: "POST",
      body: JSON.stringify({ indices, created_at: createdAt }),
    }),

  applyReview: (reviewId: number, indices: number[]) =>
    fetchAPI<import("@/types").ReviewApplyResult>(`/plan/review/${reviewId}/apply`, {
      method: "POST",
      body: JSON.stringify({ indices }),
    }),
};

// ========================= //
// WEB PUSH API              //
// ========================= //

export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export const notificationsApi = {
  /** `key` is null when the server has no VAPID keys configured. */
  getVapidPublicKey: () =>
    fetchAPI<{ key: string | null }>("/notifications/vapid-public-key"),

  subscribe: (subscription: PushSubscriptionBody) =>
    fetchAPI<unknown>("/notifications/subscription", {
      method: "POST",
      body: JSON.stringify(subscription),
    }),

  unsubscribe: (endpoint: string) =>
    fetchAPI<unknown>("/notifications/subscription", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),

  sendTest: () =>
    fetchAPI<{ sent: number; dropped: number; skipped_reason: string | null }>(
      "/notifications/test",
      { method: "POST" }
    ),
};
