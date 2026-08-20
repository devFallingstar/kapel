/**
 * "What has this workspace actually done lately" — the aggregation behind the
 * REPL's startup dashboard and its `/stats` command.
 *
 * The shapes and the window arithmetic live here, apart from the SQL that
 * fills them (`SqliteSessionStore.activityTotals`), because the boundaries are
 * the part worth testing on their own: a window is a local-calendar fact, and
 * local calendars have days that are not 24 hours long.
 */

/** One time window's work, as the dashboard reports it. */
export interface ActivityTotals {
  /** Orchestration runs *started* in the window (`runs.created_at`). */
  readonly runs: number;
  /** Chat sessions *started* in the window (`chat_sessions.created_at`). */
  readonly chatSessions: number;
  /** Tasks that reached `success` in the window (`task_results.updated_at`). */
  readonly tasksCompleted: number;
  /** Tasks that reached `failed` in the window. */
  readonly tasksFailed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Summed `usage_events.cost_usd`, counting only the rows that carried a
   * price. `undefined` means nothing in the window was priced at all — a
   * delegated backend bills a subscription, and `0` there would read as
   * "this was free" rather than "nobody priced it".
   */
  readonly costUsd?: number;
}

/** A window with nothing in it — what a brand new workspace reports. */
export const EMPTY_ACTIVITY: ActivityTotals = {
  runs: 0,
  chatSessions: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Whether a window holds nothing at all, so a caller can say "no runs yet"
 * instead of printing six zeroes.
 */
export function isIdleActivity(totals: ActivityTotals): boolean {
  return (
    totals.runs === 0 &&
    totals.chatSessions === 0 &&
    totals.tasksCompleted === 0 &&
    totals.tasksFailed === 0 &&
    totals.inputTokens === 0 &&
    totals.outputTokens === 0
  );
}

/** Both windows the dashboard shows, plus the instants they start at. */
export interface ActivityWindows {
  readonly today: ActivityTotals;
  readonly week: ActivityTotals;
  /** Local midnight this morning. */
  readonly todaySince: number;
  /** Local midnight {@link WEEK_DAYS} − 1 days ago. */
  readonly weekSince: number;
}

/** How many calendar days "this week" covers, today included. */
export const WEEK_DAYS = 7;

/**
 * Local midnight at the start of `now`'s day.
 *
 * Local, not UTC: a dashboard that resets at 09:00 because the user is in
 * UTC+9 is telling them about someone else's day.
 */
export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Local midnight `days - 1` days before `now`'s day, so the window covers
 * `days` calendar days *including today*.
 *
 * Done with `setDate` rather than subtracting milliseconds because a
 * daylight-saving boundary inside the window makes one of those days 23 or 25
 * hours long, and `now - 6 * 86_400_000` would then land an hour off midnight
 * and either drop or double-count that day's first hour.
 */
export function startOfWindow(now: number, days: number = WEEK_DAYS): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (Math.max(1, Math.trunc(days)) - 1));
  return date.getTime();
}

/** Half-open `[since, until)` — `until` omitted means "up to now". */
export interface ActivityWindow {
  readonly since: number;
  readonly until?: number;
}

/** One backend's spend in a window — the dashboard's per-backend usage cell. */
export interface BackendUsageTotals {
  /** `native`, `codex`, `claude-code`, or `"unknown"` for unattributed rows. */
  readonly backend: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Absent when nothing in this bucket carried a price — see {@link ActivityTotals.costUsd}. */
  readonly costUsd?: number;
}

/** The label used for usage rows that never said which backend spent them. */
export const UNKNOWN_BACKEND = "unknown";
