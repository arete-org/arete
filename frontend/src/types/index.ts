// ========================= //
// FITNESS & WORKLOAD TYPES //
// ========================= //

export interface StatBar {
  current: number;
  max: number;
  label: string;
  detail: string | null;
  source: string | null;
}

export interface PlayerStats {
  hp: StatBar;
  mp: StatBar;
  xp: StatBar;
  /** Consecutive finished weeks at goal: older readers only, the dashboard shows `recent_*`. */
  level: number;
  weeks_at_goal: number;
  weekly_goal_tss: number;
  /** Weeks at goal among the last `recent_weeks` finished (at most 12). */
  recent_weeks_at_goal: number;
  recent_weeks: number;
}

// Zone values sent by the backend (features/workload.py, features/fitness.py).
export type AcwrZone = "undertrained" | "optimal" | "caution" | "danger" | "unknown";
export type FormZone = "freshest" | "fresh" | "neutral" | "tired" | "exhausted";
export type ReadinessLevel = "optimal" | "good" | "moderate" | "low" | "critical";
export type MonotonyZone = "ideal" | "acceptable" | "high" | "unknown";
export type StrainZone = "low" | "optimal" | "high" | "critical" | "unknown";

export interface FitnessMetrics {
  ctl: number;
  atl: number;
  tsb: number;
  form_zone: FormZone;
  readiness_score: number;
  readiness_level: ReadinessLevel;
  readiness_source: "garmin_training" | "garmin" | "model";
  readiness_measured_on: string | null;
  ramp_rate: number | null;
  days_analyzed: number;
}

export interface WorkloadMetrics {
  acute_load: number;
  chronic_load: number | null;
  acwr: number | null;
  acwr_zone: AcwrZone | null;
  acwr_ewma: number | null;
  monotony: number | null;
  monotony_zone: MonotonyZone | null;
  strain: number | null;
  strain_zone: StrainZone | null;
  days_analyzed: number;
}

// ========================= //
// SESSION TYPES            //
// ========================= //

export interface PlannedSession {
  prescription?: import('@/lib/documents').Prescription | null;
  provenance?: import('@/lib/documents').Provenance[] | null;
  revision?: number;
  id: number;
  date: string;
  sport: string;
  session_type: string;
  target_duration_min: number | null;
  target_distance_km: number | null;
  target_hr_zone: string | null;
  target_intensity: "easy" | "moderate" | "hard" | null;
  description: string | null;
  source: string;
  status: "pending" | "completed" | "skipped" | "modified";
  /** Garmin calendar copy of the session, set once it was sent to Garmin. */
  garmin_workout_id: string | null;
  garmin_pushed_at: string | null;
}

// ========================= //
// DAILY ADAPTATION          //
// ========================= //

/** `move` comes from « Modifier » or a missed session's replanning, `drop` from the latter only. */
export type PlanDecisionKind = "keep" | "ease" | "replace_easy" | "rest" | "move" | "drop";

/** The morning rule engine's verdict on one planned session (GET /plan/today). */
export interface PlanDecision {
  id: number;
  date: string;
  planned_session_id: number;
  decision: PlanDecisionKind;
  /** French sentence with the figure that justifies the decision. */
  reason: string;
  readiness_score: number | null;
  /** `athlete`: the athlete's own choice (« Modifier »); `missed`: the evening's
   *  replanning of a missed session. No readiness behind either. */
  readiness_source: "garmin_training" | "garmin" | "model" | "athlete" | "missed" | null;
  acwr: number | null;
  original: Record<string, unknown> | null;
  adapted: Record<string, unknown> | null;
  applied_at: string | null;
  reverted_at: string | null;
  created_at: string | null;
}

/** One reason of « Modifier » on today's session, with the rules' options (`GET /plan/today/sessions/{id}/options`). */
export interface RenegotiationReason {
  id: "tired" | "no_time" | "pain";
  label: string;
  options: { id: string; decision: Exclude<PlanDecisionKind, "keep">; label: string; detail: string }[];
  /** Why an option is missing (no free day), or a caution (pain). */
  note: string | null;
}

export interface RenegotiationMenu {
  session_id: number;
  date: string;
  /** Sent back with the choice: anything changed since answers 409. */
  version: string;
  /** Why nothing can be offered (a proposal to answer, an adjusted session…). */
  blocked: string | null;
  reasons: RenegotiationReason[];
}

/** Garmin after the choice, as the server reports it; never a failed choice. */
export type RenegotiationGarmin =
  | "sent" | "withdrawn" | "failed" | "not_started" | "unchanged" | "disabled" | "disconnected";

export interface Renegotiated {
  decision: PlanDecision;
  /** The session's day once written: a move changes it. */
  date: string;
  garmin: RenegotiationGarmin;
}

export interface PlanToday {
  date: string;
  decisions: PlanDecision[];
}

export interface ActualSession {
  id: number;
  planned_session_id: number | null;
  date: string;
  start_time: string | null;
  sport: string;
  session_type: string | null;
  name: string | null;
  duration_sec: number;
  duration_min: string; // "MM:SS"
  moving_time_sec: number | null;
  distance_m: number | null;
  distance_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_pace_sec_km: number | null;
  avg_pace: string | null; // "MM:SS"
  ascent_m: number | null;
  calories: number | null;
  rpe: number | null;
  notes: string | null;
  source: string;
  garmin_activity_id: string | null;
  strava_activity_id: string | null;
  adherence_score: number | null;
  /** Exercises of the Muscu log behind this session, when there is one (browser-side). */
  exercises?: string[];
}

export interface MatchSummary {
  total_planned: number;
  total_actual: number;
  total_matched: number;
  total_unmatched: number;
  adherence_rate: number; // 0-100, over sessions due in the window
  planned_due: number;
  completed: number;
  skipped: number;
  window_start: string | null;
  window_end: string | null;
}

// ========================= //
// STRENGTH MODULE TYPES    //
// ========================= //

export interface Exercise {
  id: number;
  name: string;
  category: string;
  primary_muscle: string;
  secondary_muscles: string[];
  equipment: string | null;
  is_unilateral: boolean;
  notes: string | null;
}

export interface ExerciseSet {
  id: number;
  set_number: number;
  reps: number | null;
  weight_kg: number | null;
  rpe: number | null;
  rir: number | null;
  rest_sec: number | null;
  tempo: string | null;
  is_warmup: boolean;
  is_failure: boolean;
  volume: number | null;
  estimated_1rm: number | null;
  notes: string | null;
}

export interface SessionExercise {
  id: number;
  order: number;
  exercise: Exercise;
  exercise_id?: number;
  target_sets: number | null;
  target_reps: number | null;
  target_rpe: number | null;
  sets: ExerciseSet[];
  total_volume: number;
  working_sets_count: number;
  avg_rpe: number | null;
  notes: string | null;
}

export interface StrengthSession {
  id: number;
  date: string;
  name: string | null;
  program: string | null;
  duration_min: number | null;
  overall_rpe: number | null;
  fatigue_level: number | null;
  sleep_quality: number | null;
  notes: string | null;
  total_volume: number;
  total_sets: number;
  exercises_count?: number;
  muscles_worked?: string[];
  exercises?: SessionExercise[];
  /** Exercise names in order; the list endpoint's light alternative to `exercises`. */
  exercise_names?: string[];
  /** actual_sessions.id of the Garmin activity this log was recorded with. */
  garmin_activity_id?: number | null;
}

/** An exercise Garmin recognised in a strength activity; `exercise_id` when the catalog did too. */
export interface StrengthDraftExercise {
  name: string;
  exercise_id: string | null;
  sets: number | null;
  reps: number | null;
}

/** A Garmin strength activity awaiting its loads: not a session until completed. */
export interface StrengthDraft {
  id: number;
  /** actual_sessions.id of the Garmin activity it completes. */
  actual_session_id: number;
  date: string;
  name: string | null;
  duration_min: number | null;
  /** 'import' (Garmin sync) or 'journal' (opened by the athlete). */
  origin: string;
  exercises: StrengthDraftExercise[];
  /** The completion screen's text: one line per catalog exercise (free-text ones are left out). */
  notation: string;
}

/** The Journal's newest drafts and how many there are in all. */
export interface StrengthDraftList {
  items: StrengthDraft[];
  total: number;
}

/** The Muscu log a completed draft became. */
export interface DraftCompletion {
  session_id: number;
  message: string;
  records: SessionRecord[];
  unparsed_lines: string[];
  dropped: string[];
}

export interface MuscleStat {
  muscle: string;
  /** French label, e.g. "Grands dorsaux". */
  label: string;
  volume: number;
  sets: number;
  /** 0 (untouched) to 4 (busiest region of the window). */
  level: number;
  previous_volume: number | null;
  last_trained: string | null;
}

export interface MuscleStatsResponse {
  days: number;
  start: string;
  end: string;
  muscles: MuscleStat[];
}

// ========================= //
// SYNC & STATUS TYPES      //
// ========================= //

export interface SyncStatus {
  freshness?: { state: string; activities_checked_at?: string | null; health_checked_at?: string | null; complete?: boolean; errors?: string[] };
  garmin_authenticated: boolean;
  user_email: string | null;
  last_sync: string | null;
  activities_synced: number;
}

export interface SyncResult {
  success: boolean;
  activities_synced: number;
  activities_merged: number;
  activities_matched: number;
  activities_skipped: number;
  errors: string[];
  last_activity_date: string | null;
  next_history_offset?: number | null;
  history_anchor?: number | null;
}

// ========================= //
// WORKOUT PARSER            //
// ========================= //

export interface ParsedSet {
  set_number: number;
  reps: number | null; // null for failure sets
  weight_kg: number | null;
  rpe: number | null;
  is_warmup: boolean;
  is_failure: boolean;
  rest_sec?: number | null;
  rir?: number | null;
  tempo?: string | null;
}

/** Next-session load from fixed rules (double progression, RIR/RPE, deload). */
export interface StrengthSuggestion {
  weight_kg: number | null;
  sets: number;
  reps: number;
  rep_range: string | null;
  rule: 'increase' | 'double_progression' | 'hold' | 'decrease' | 'reps' | 'deload';
  /** French, ready to show. */
  reason: string;
  based_on: string;
  deload: boolean;
  readiness: number | null;
}

export interface StrengthRecord {
  kind: 'weight' | 'e1rm' | 'reps';
  /** kg for weight/e1rm, reps for reps. */
  value: number;
  previous: number | null;
  weight_kg: number | null;
  reps: number | null;
  date: string | null;
}

/** A record the session just saved beat. */
export interface SessionRecord extends StrengthRecord {
  exercise_id: number;
  exercise: string;
}

export interface ExerciseHistoryEntry {
  date: string;
  session_exercise_id: number;
  total_sets: number;
  working_sets: number;
  max_weight: number | null;
  volume: number;
  avg_rpe: number | null;
  best_e1rm: number | null;
  top_weight: number | null;
  top_reps: number | null;
}

export interface ExercisePersonalRecords {
  max_weight: number | null;
  max_weight_reps: number | null;
  max_weight_date: string | null;
  estimated_1rm: number | null;
  max_session_volume: number | null;
  max_volume_date: string | null;
  best_e1rm: StrengthRecord | null;
  rep_records: StrengthRecord[];
}

export interface ExerciseSuggestionResponse {
  suggestion: StrengthSuggestion | null;
  readiness: { score: number; source: string; level: string } | null;
}

export interface LibraryExercise {
  id: number;
  name: string;
  category: string;
}

export interface ParsedExercise {
  name: string;
  exercise_id: string | null;
  exercise_matched: boolean;
  sets: ParsedSet[];
  notes: string | null;
  /** Catalog candidates; the first is the exercise a matched name was read as. */
  suggestions?: { exercise_id: string; name: string; name_fr?: string | null; score: number }[];
  /** What the history suggested for this session (preview only). */
  progression?: StrengthSuggestion | null;
}

/** What POST /strength/sessions/transcribe answers for a dictated session. */
export interface WorkoutTranscription {
  /** French text, exactly as dictated. */
  transcript: string;
  /** Compact notation rebuilt from what the grammar read. */
  notation: string;
  /** Sentences left verbatim rather than guessed. */
  unparsed: string[];
  exercises: number;
  cost_usd: number | null;
}

export interface ParsedWorkout {
  success: boolean;
  date: string;
  name: string | null;
  exercises: ParsedExercise[];
  duration_min: number | null;
  overall_rpe: number | null;
  notes: string | null;
  session_id: number | null;
  message: string | null;
  /** Lines the grammar could not parse (LLM fallback disabled or failed). */
  unparsed_lines?: string[];
  /** Personal records the saved session set. */
  records?: SessionRecord[];
}

// ========================= //
// ANALYTICS                 //
// ========================= //

export type Period = '7d' | '30d' | '90d' | '6m' | '1y' | 'all';
export type Bucket = 'day' | 'week' | 'month';
export type Tone = 'good' | 'neutral' | 'warn' | 'bad';
/** Which direction of change is an improvement for this number. */
export type Better = 'up' | 'down' | 'neutral';

export interface Headline {
  value: number | null;
  unit: string;
  display: string;
  previous: number | null;
  delta: number | null;
  delta_pct: number | null;
  better: Better;
}

export interface Insight {
  text: string;
  tone: Tone;
}

/** A point of a card series: always a bucket, plus that card's own fields. */
export type SeriesPoint = { bucket: string } & Record<string, number | string | null>;

export interface Card {
  headline: Headline;
  secondary: Headline[];
  insight: Insight;
  series: SeriesPoint[];
}

export type CardKey =
  | 'volume'
  | 'pmc'
  | 'zones'
  | 'sports'
  | 'decoupling'
  | 'pace'
  | 'elevation'
  | 'cadence'
  | 'vam'
  | 'descent'
  | 'readiness'
  | 'hrv'
  | 'sleep'
  | 'resting_hr';

export interface HrZoneRange {
  zone: string;
  min: number;
  max: number | null;
}

export interface HrZoneModel {
  /** Which reference the zones are built on. */
  basis: 'lthr' | 'max_hr';
  reference: number;
  boundaries: number[];
  ranges: HrZoneRange[];
}

export interface OverviewResponse {
  hr_zone_model: HrZoneModel;
  period: Period;
  bucket: Bucket;
  start: string;
  end: string;
  prev_start: string | null;
  prev_end: string | null;
  cards: Record<CardKey, Card>;
}

/** The sports card series is per sport, not per bucket. */
export interface SportSlice {
  sport: string;
  hours: number;
  count: number;
  pct: number;
}

export interface CardioSession {
  id: number;
  date: string;
  sport: string;
  name: string | null;
  duration_sec: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  avg_pace_sec_km: number | null;
  pace_display: string | null;
  rpe: number | null;
  notes: string | null;
  source: string;
  calories: number | null;
}
export interface CardioSessionsResponse {
  sessions: CardioSession[];
}

/** One lap, Garmin FIT or Strava, in a single shape (GET /analytics/sessions/{id}/detail). */
export interface ActivityLap {
  n: number;
  duration_sec: number;
  distance_m: number | null;
  speed_mps: number | null;
  pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  cadence: number | null;
  /** FIT lap intensity: warmup, active, rest, cooldown (or a raw number). */
  intensity: string | number | null;
}

export interface ActivitySplit {
  n: number;
  duration_sec: number;
  distance_m: number | null;
  pace_sec_km: number | null;
  avg_hr: number | null;
  elevation_m: number | null;
}

export interface ActivityIntervals {
  count: number;
  work_avg_sec: number;
  rest_avg_sec: number;
  warmup_sec: number;
  cooldown_sec: number;
  pace_cv_pct: number | null;
  hr_progression_pct: number | null;
  work: {
    n: number;
    lap: number;
    duration_sec: number;
    distance_m: number | null;
    pace_sec_km: number | null;
    avg_hr: number | null;
  }[];
}

/** Derived metrics of the kept streams; a key is absent when it cannot be computed. */
export interface ActivityMetrics {
  hr_avg?: number;
  hr_max?: number;
  hr_drift_pct?: number;
  decoupling_pct?: number;
  pace_fade_pct?: number;
  pace_first_half_sec_km?: number;
  pace_second_half_sec_km?: number;
  pace_cv_pct?: number;
  cadence_avg?: number;
  cadence_cv_pct?: number;
  power_avg?: number;
  power_np?: number;
  power_vi?: number;
}

/** Chart-sized streams: every channel aligned on `t` (seconds from the start). */
export interface ActivityStreams {
  t: number[];
  heart_rate?: (number | null)[];
  speed_mps?: (number | null)[];
  altitude_m?: (number | null)[];
  distance_m?: (number | null)[];
  cadence?: (number | null)[];
  power_w?: (number | null)[];
}

/** What the streams say about the terrain (stored when the session arrived). */
export interface ActivityTerrain {
  /** Flat-equivalent distance over distance run (Minetti); 1 on the flat. */
  grade_factor: number | null;
  /** Grade-adjusted pace, s/km. */
  gap_sec_km: number | null;
  /** Best net climbing speed in m/h, keyed by minutes ("5", "10", "20", "30", "60"). */
  vam: Record<string, number>;
  /** Time and horizontal distance per grade band (percent). */
  descent: { min: number; max: number; sec: number; m: number }[];
}

/** The weather at the start (Open-Meteo), read once when the session arrived. */
export interface ActivityWeather {
  observed_at: string;
  temperature_c: number | null;
  humidity_pct: number | null;
  wind_kmh: number | null;
  start_altitude_m: number | null;
  source: string;
}

export interface ActivityDetail {
  /** A strength activity's linked Muscu log (null without one, or for another sport). */
  strength_log_id?: number | null;
  /** Without a linked log: a Muscu log of that day linked to no activity, probably this session. */
  strength_unlinked_log_id?: number | null;
  session: {
    id: number;
    date: string;
    start_time: string | null;
    sport: string;
    session_type: string | null;
    name: string | null;
    duration_sec: number;
    moving_time_sec: number | null;
    distance_m: number | null;
    calories: number | null;
    avg_hr: number | null;
    max_hr: number | null;
    avg_pace_sec_km: number | null;
    avg_speed_mps: number | null;
    max_speed_mps: number | null;
    ascent_m: number | null;
    descent_m: number | null;
    avg_cadence: number | null;
    max_cadence: number | null;
    avg_watts: number | null;
    rpe: number | null;
    notes: string | null;
    source: string;
    device_name: string | null;
    planned_session_id: number | null;
    adherence_score: number | null;
  };
  zones: Record<'z1' | 'z2' | 'z3' | 'z4' | 'z5', number> | null;
  laps: ActivityLap[];
  splits: ActivitySplit[];
  intervals: ActivityIntervals | null;
  metrics: ActivityMetrics | null;
  streams: ActivityStreams | null;
  /** [lat, lon] pairs. */
  route: [number, number][] | null;
  feedback: { text: string; source: 'agent' | 'rules'; trigger: string; created_at: string | null } | null;
  terrain: ActivityTerrain | null;
  weather: ActivityWeather | null;
}

// ========================= //
// RACE GOALS AND PLAN       //
// ========================= //

export type GoalPriority = "A" | "B" | "C";
export type GoalStatus = "active" | "done" | "cancelled";

/** A goal race the plan is built towards (GET /goals). */
export interface Goal {
  id: number;
  name: string;
  race_date: string;
  distance_km: number;
  target_time_sec: number | null;
  priority: GoalPriority;
  status: GoalStatus;
  /** Days until race day, from the server's today. */
  days_left: number;
  created_at: string | null;
}

export interface GoalCreate {
  name: string;
  race_date: string;
  distance_km: number;
  target_time_sec?: number | null;
  priority: GoalPriority;
}

export type PlanPhase = "base" | "build" | "specific" | "taper" | "race";

export interface PlanSessionDraft {
  date: string;
  session_type: string;
  duration_min: number | null;
  hr_zone: string | null;
  intensity: string | null;
  description: string;
  distance_km: number | null;
}

export interface PlanWeek {
  /** Monday of the week. */
  start: string;
  phase: PlanPhase;
  minutes: number;
  recovery: boolean;
  sessions: PlanSessionDraft[];
}

/** POST /goals/{id}/plan/preview: the plan as it would be written. */
export interface PlanPreview {
  goal: Goal;
  inputs: {
    weekly_minutes_now: number;
    sessions_per_week: number;
    /** Monday is 0. */
    rest_days: number[];
    vdot: number | null;
  };
  weeks: PlanWeek[];
}

export interface PlanWriteResult {
  created: number;
  replaced: number;
  skipped_days: string[];
  weeks: PlanWeek[];
}

export interface ProjectionPoint {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
  tss: number;
  /** True from the first day whose load comes from the plan. */
  planned: boolean;
}

/** GET /goals/{id}/projection: fitness and form until race day. */
export interface GoalProjection {
  goal: Goal;
  series: ProjectionPoint[];
  race_day: { ctl: number | null; tsb: number | null };
  peak_ctl: number | null;
  planned_sessions: number;
}

// ========================= //
// TRAINING PACES            //
// ========================= //

export type RaceKey = "5k" | "10k" | "half" | "marathon";

/** GET /metrics/paces: Daniels paces in seconds per km, equivalents in seconds. */
export interface TrainingPaces {
  vdot: number | null;
  source: "garmin_prediction" | "threshold_pace" | null;
  paces: {
    vdot: number;
    /** [slow, fast] */
    easy: [number, number];
    marathon: number;
    threshold: number;
    interval: number;
    repetition: number;
  } | null;
  equivalents: Record<RaceKey, number> | null;
  /** French sentence when there is no VDOT. */
  reason: string | null;
}

// ========================= //
// ATHLETE FACTS             //
// ========================= //

export type FactKind = "injury" | "constraint" | "preference" | "goal" | "other";

/** A durable fact the coach keeps about the athlete (GET /athlete-facts). */
export interface AthleteFact {
  id: number;
  kind: FactKind;
  /** At most 300 characters. */
  text: string;
  since: string;
  status: "active" | "resolved";
  source: "coach" | "athlete";
  evidence: "explicit" | "hypothesis" | "legacy";
  revision: number;
  source_ref: string;
  valid_until: string | null;
  updated_at: string | null;
}

// ========================= //
// WEEKLY REVIEW             //
// ========================= //

export interface ReviewProposal {
  index: number;
  planned_session_id: number;
  date: string;
  /** What is planned now, in French. */
  session: string;
  change: Record<string, unknown>;
  before: Record<string, unknown>;
  reason: string;
}

/** Last week's review and its proposals for the days ahead (GET /plan/review). */
export interface WeeklyReview {
  id: number;
  week_start: string;
  text: string;
  source: "agent" | "rules";
  proposals: ReviewProposal[];
  applied: number[];
  created_at: string | null;
  applied_at: string | null;
}

export interface ReviewApplyResult {
  applied: number[];
  stale: number[];
}

/** « Ma semaine » (GET /plan/review/week): the reviewed week in numbers, read now. */
export interface WeekRecap {
  week_start: string;
  week_end: string;
  planned: number;
  completed: number;
  minutes_done: number;
  minutes_planned: number;
  /** Completed over planned, null without a session due. */
  adherence: number | null;
  tsb: number | null;
}

export interface ReviewWeek {
  today: string;
  review: WeeklyReview | null;
  recap: WeekRecap | null;
}

/** One key session's Garmin outcome after « Accepter », as the server reports it. */
export interface WeekPushSession {
  planned_session_id: number;
  date: string;
  session_type: string;
  outcome: "sent" | "already" | "withdrawn" | "skipped" | "failed" | "not_started";
}

/** `POST /plan/review/{id}/accept`: the plan is written whatever Garmin and the calendar say. */
export interface ReviewAccepted extends ReviewApplyResult {
  /** `unchanged`: nothing new accepted, nothing sent. */
  garmin: { state: "done" | "disabled" | "disconnected" | "failed" | "unchanged"; sessions: WeekPushSession[] };
  /** Training plan calendar sync: synced, partial, busy, failed, disabled, unchanged (several connections: joined). */
  calendar: string;
}
