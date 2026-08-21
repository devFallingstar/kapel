/**
 * The REPL's startup dashboard: a boxed, two-column summary of what kapel is
 * set up to do (left) and what it has actually been doing (right).
 *
 * It replaces the four plain banner lines the shell used to print — but only
 * on a terminal. A piped or redirected REPL keeps the old banner verbatim, so
 * `kapel chat < script.txt` still produces a transcript with no box drawing
 * and no escape sequences in it; see `runInteractive`.
 *
 * Everything here is pure: {@link renderDashboard} turns a {@link
 * DashboardModel} into lines, and knows nothing about stores, subprocesses or
 * terminals. Gathering the model (probing logins, reading the session
 * database) is `interactive.ts`'s job, which is what lets the layout be
 * tested without either.
 */

import {
  type ActivityTotals,
  type ActivityWindows,
  type BackendUsageTotals,
  isIdleActivity,
} from "@agent/session";
import type { KapelModels, KapelRole } from "./config.js";
import { KAPEL_ROLES } from "./config.js";
import type { KapelProjectConfig } from "./config-project.js";
import { ansi, ROLE_SGR } from "./styles.js";

// --- The model --------------------------------------------------------------

/** How a configured backend answered when kapel asked whether it was usable. */
export type BackendState =
  | "ok"
  | "logged-out"
  | "missing"
  /** The probe had not come back before the dashboard had to be printed. */
  | "pending";

export interface DashboardBackend {
  readonly name: string;
  readonly state: BackendState;
}

/** One role's `role  backend:model` line, and where the answer came from. */
export interface DashboardRole {
  readonly role: string;
  readonly backend: string;
  readonly model: string;
  /** True when `.agent/config.local.json` is what decided this role. */
  readonly overridden: boolean;
}

/**
 * One backend's subscription cell. `value` is `undefined` while whatever
 * fills it is still in flight, which renders as `…`.
 */
export interface DashboardQuota {
  readonly backend: string;
  readonly value?: string;
}

/**
 * The subscription block: a heading that says whose numbers these are, and a
 * row per backend.
 *
 * The heading is not decoration. Neither the Claude Code CLI nor the Codex
 * CLI reports remaining subscription allowance anywhere a program can read it
 * (see the README's REPL section), so what these rows actually hold is what
 * *kapel* watched each backend spend — and a cell labelled `subscription`
 * with a kapel-tracked number under it would be a claim about an allowance
 * nobody measured.
 */
export interface DashboardQuotaBlock {
  /** e.g. `usage (kapel-tracked, 7 days)`. */
  readonly heading: string;
  readonly cells: readonly DashboardQuota[];
}

export interface DashboardModel {
  readonly version: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  /**
   * What *this conversation* runs on, as `bannerModel` spells it. Distinct
   * from {@link roles}, which is what `/plan` and `/orchestrate` would use:
   * a REPL opened with `--backend codex` chats through Codex whatever the
   * orchestrator role says.
   */
  readonly chat: string;
  readonly backends: readonly DashboardBackend[];
  readonly roles: readonly DashboardRole[];
  /** True when this workspace has a `.agent/config.local.json` at all. */
  readonly projectOverride: boolean;
  /**
   * Today's and this week's work. Absent under `--no-save`, or when the
   * session database could not be opened — the dashboard then says so rather
   * than printing zeroes that would read as "you did nothing".
   */
  readonly activity?: ActivityWindows;
  /** Absent when no backend has a cell worth showing. */
  readonly quota?: DashboardQuotaBlock;
}

// --- Building the model -----------------------------------------------------

/**
 * Turns `checkBackendAvailability`'s answer into a glyph state.
 *
 * `installed` is absent for the native backend (there is no binary to find),
 * which is why a missing `installed` never means "missing": a native backend
 * with no credential is `logged-out`, not uninstalled.
 */
export function backendStateFrom(result: {
  readonly ok: boolean;
  readonly installed?: boolean;
}): BackendState {
  if (result.ok) return "ok";
  return result.installed === false ? "missing" : "logged-out";
}

/**
 * The four role rows, in {@link KAPEL_ROLES} order, marking each one the
 * project's `.agent/config.local.json` had an opinion about.
 *
 * `models` is the *merged* answer — machine config with the project override
 * already applied — and `overrides` is only consulted to decide whether to
 * put a marker next to a row. An unconfigured machine has no rows at all
 * rather than invented ones.
 */
export function dashboardRoles(
  models: KapelModels | undefined,
  overrides?: KapelProjectConfig["models"],
): readonly DashboardRole[] {
  if (models === undefined) return [];
  return KAPEL_ROLES.map((role: KapelRole) => ({
    role,
    backend: models[role].backend,
    model: models[role].model,
    overridden: overrides?.[role] !== undefined,
  }));
}

/**
 * The subscription block, built from what kapel itself recorded.
 *
 * One row per *configured* backend, whether or not it spent anything, so the
 * block answers "what is this machine set up to bill" and not merely "what
 * happened to be busy". Backends with recorded usage that are no longer
 * configured are left out: the block is about the setup on screen above it.
 */
export function quotaBlockFrom(
  backends: readonly string[],
  usage: readonly BackendUsageTotals[],
  days: number,
): DashboardQuotaBlock | undefined {
  if (backends.length === 0) return undefined;
  const byBackend = new Map(usage.map((row) => [row.backend, row]));
  return {
    heading: `usage (kapel-tracked, ${days} days)`,
    cells: backends.map((backend) => {
      const row = byBackend.get(backend);
      return {
        backend,
        value: formatTokens(row?.inputTokens ?? 0, row?.outputTokens ?? 0),
      };
    }),
  };
}

export interface DashboardOptions {
  /** Terminal width. Defaults to {@link DEFAULT_COLUMNS}. */
  readonly columns?: number;
  /** Whether to emit SGR escapes. Defaults to `false` — nothing sneaks in. */
  readonly color?: boolean;
}

// --- Layout constants -------------------------------------------------------

const DEFAULT_COLUMNS = 80;

/** Below this the box goes single-column: two columns stop being readable. */
export const NARROW_COLUMNS = 80;

/** Nothing narrower than this can hold a box worth drawing. */
const MIN_COLUMNS = 28;

/** The widest box we draw, however wide the terminal is. */
const MAX_COLUMNS = 110;

/** Fraction of the inner width the setup column gets in two-column mode. */
const LEFT_SHARE = 0.5;

// --- Segments ---------------------------------------------------------------

type SegmentStyle = "dim" | "bold" | "ok" | "warn";

/**
 * The box's four styles, spelled in the shell's own role vocabulary
 * (`styles.ts`) rather than in SGR codes of its own: a dashboard whose "dim"
 * drifted from the transcript's would be two programs on one screen.
 */
const SGR: Record<SegmentStyle, string> = {
  dim: ROLE_SGR.tool,
  bold: ROLE_SGR.heading,
  ok: ROLE_SGR.ok,
  warn: ROLE_SGR.warn,
};

/**
 * A run of text with one style. A line is a list of them, which is what lets
 * padding and truncation be computed on the *plain* text while the styling is
 * applied afterwards — measuring a string that already contains escapes is
 * how box drawing goes crooked the moment colour is switched on.
 */
interface Segment {
  readonly text: string;
  readonly style?: SegmentStyle;
}

type Line = readonly Segment[];

/** Styles, then pads (or truncates) a line to exactly `cells` characters. */
function renderLine(line: Line, cells: number, color: boolean): string {
  let remaining = cells;
  let out = "";
  for (const segment of line) {
    if (remaining <= 0) break;
    const text =
      segment.text.length <= remaining
        ? segment.text
        : segment.text.slice(0, remaining);
    remaining -= text.length;
    out +=
      segment.style === undefined
        ? text
        : ansi(SGR[segment.style], text, color);
  }
  return out + " ".repeat(Math.max(0, remaining));
}

/**
 * `label` dim and padded, then `value` — the shape of most dashboard rows.
 *
 * A label at least as long as its column still gets one space after it: a
 * gutter that disappears turns `orchestrator` + `codex:gpt-5.1` into one
 * unreadable word, and losing a character of alignment is the cheaper of the
 * two failures.
 */
function field(
  label: string,
  labelWidth: number,
  ...value: readonly Segment[]
): Line {
  const gutter = Math.max(1, labelWidth - label.length);
  const text =
    label === "" ? " ".repeat(labelWidth) : label + " ".repeat(gutter);
  return [{ text, style: "dim" }, ...value];
}

// --- Formatting -------------------------------------------------------------

/**
 * `950` → `950`, `12_345` → `12.3k`, `2_400_000` → `2.4M`.
 *
 * The same shape as `formatTokenCount` in `status-line.ts`, carried one order
 * of magnitude further: a status line shows one turn, this shows a week, and
 * `2400.0k` is not a number anyone reads at a glance.
 */
export function formatCount(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `12.3k in · 4.1k out` — the shared shape of every token cell. */
export function formatTokens(
  inputTokens: number,
  outputTokens: number,
): string {
  return `${formatCount(inputTokens)} in · ${formatCount(outputTokens)} out`;
}

const STATE_GLYPH: Record<BackendState, string> = {
  ok: "✓",
  "logged-out": "!",
  missing: "✗",
  pending: "…",
};

const STATE_STYLE: Record<BackendState, SegmentStyle> = {
  ok: "ok",
  "logged-out": "warn",
  missing: "dim",
  pending: "dim",
};

/** A one-word gloss of a backend's state, for the narrow single-column box. */
export function describeBackendState(state: BackendState): string {
  switch (state) {
    case "ok":
      return "logged in";
    case "logged-out":
      return "not logged in";
    case "missing":
      return "not installed";
    default:
      return "checking…";
  }
}

/** `~5m ago`-style path shortening: keep the tail that identifies the repo. */
function shortenPath(value: string, max: number): string {
  if (value.length <= max) return value;
  const tail = value.slice(value.length - (max - 1));
  const cut = tail.indexOf("/");
  return `…${cut === -1 ? tail : tail.slice(cut)}`;
}

// --- Column contents --------------------------------------------------------

const SETUP_LABEL_WIDTH = 13;

/** `✓ claude-code`, styled by state. */
function backendSegments(backend: DashboardBackend): readonly Segment[] {
  return [
    { text: STATE_GLYPH[backend.state], style: STATE_STYLE[backend.state] },
    { text: ` ${backend.name}` },
  ];
}

/**
 * The backends row: all of them on one line where that fits, one per line
 * where it does not. Truncating this row instead would drop a backend's
 * glyph, and a login state that is silently missing is worse than a row that
 * is one line taller.
 */
function backendLines(
  backends: readonly DashboardBackend[],
  cells: number,
): readonly Line[] {
  if (backends.length === 0) {
    return [
      field("backends", SETUP_LABEL_WIDTH, {
        text: "none configured",
        style: "dim",
      }),
    ];
  }

  const joined: Segment[] = [];
  for (const backend of backends) {
    if (joined.length > 0) joined.push({ text: "  " });
    joined.push(...backendSegments(backend));
  }
  const used = joined.reduce(
    (total, segment) => total + segment.text.length,
    0,
  );
  if (used <= cells - SETUP_LABEL_WIDTH) {
    return [field("backends", SETUP_LABEL_WIDTH, ...joined)];
  }
  return backends.map((backend, index) =>
    field(
      index === 0 ? "backends" : "",
      SETUP_LABEL_WIDTH,
      ...backendSegments(backend),
    ),
  );
}

/** The left column: what this REPL is configured to be. */
function setupLines(model: DashboardModel, cells: number): readonly Line[] {
  const lines: Line[] = [
    [{ text: "setup", style: "bold" }],
    field("workspace", SETUP_LABEL_WIDTH, {
      text: shortenPath(
        model.workspacePath,
        Math.max(8, cells - SETUP_LABEL_WIDTH),
      ),
    }),
    field("session", SETUP_LABEL_WIDTH, { text: model.sessionId }),
    field("chat", SETUP_LABEL_WIDTH, { text: model.chat }),
    ...backendLines(model.backends, cells),
    [],
  ];

  if (model.roles.length === 0) {
    lines.push([{ text: "no role models configured", style: "dim" }]);
  }
  for (const role of model.roles) {
    lines.push(
      field(
        role.role,
        SETUP_LABEL_WIDTH,
        { text: `${role.backend}:${role.model}` },
        ...(role.overridden
          ? [{ text: " *", style: "warn" as SegmentStyle }]
          : []),
      ),
    );
  }
  if (model.projectOverride) {
    lines.push([]);
    lines.push([{ text: "* from .agent/config.local.json", style: "dim" }]);
  }
  return lines;
}

const ACTIVITY_LABEL_WIDTH = 9;

/** Wide enough for `claude-code`, the longest backend name there is. */
const QUOTA_LABEL_WIDTH = 13;

/** One window's three lines, or a single honest "nothing yet". */
function windowLines(
  label: string,
  totals: ActivityTotals,
  cells: number,
): readonly Line[] {
  if (isIdleActivity(totals)) {
    return [
      field(label, ACTIVITY_LABEL_WIDTH, {
        text: "no runs yet",
        style: "dim",
      }),
    ];
  }
  const lines: Line[] = [
    field(label, ACTIVITY_LABEL_WIDTH, {
      text: `${totals.runs} run${totals.runs === 1 ? "" : "s"} · ${totals.chatSessions} chat${totals.chatSessions === 1 ? "" : "s"}`,
    }),
  ];
  if (totals.tasksCompleted > 0 || totals.tasksFailed > 0) {
    lines.push(
      field(
        "",
        ACTIVITY_LABEL_WIDTH,
        {
          text: `${totals.tasksCompleted} task${totals.tasksCompleted === 1 ? "" : "s"} ok`,
        },
        { text: " · " },
        {
          text: `${totals.tasksFailed} failed`,
          style: totals.tasksFailed > 0 ? "warn" : "dim",
        },
      ),
    );
  }
  const tokens = formatTokens(totals.inputTokens, totals.outputTokens);
  const cost =
    totals.costUsd === undefined || totals.costUsd <= 0
      ? undefined
      : `~$${totals.costUsd.toFixed(2)}`;
  // A price is never allowed to be *truncated* — `~$4.2` where `~$4.21` was
  // meant is a wrong number, not a shortened one — so a cost that will not
  // fit beside the tokens takes a line of its own.
  const together =
    ACTIVITY_LABEL_WIDTH + tokens.length + 2 + (cost?.length ?? 0);
  if (cost === undefined || together > cells) {
    lines.push(field("", ACTIVITY_LABEL_WIDTH, { text: tokens }));
    if (cost !== undefined) {
      lines.push(field("", ACTIVITY_LABEL_WIDTH, { text: cost, style: "dim" }));
    }
    return lines;
  }
  lines.push(
    field(
      "",
      ACTIVITY_LABEL_WIDTH,
      { text: tokens },
      { text: `  ${cost}`, style: "dim" },
    ),
  );
  return lines;
}

/** The right column: what has actually happened here lately. */
function activityLines(model: DashboardModel, cells: number): readonly Line[] {
  const lines: Line[] = [[{ text: "activity", style: "bold" }]];

  if (model.activity === undefined) {
    lines.push([{ text: "not recorded (--no-save)", style: "dim" }]);
  } else {
    lines.push(...windowLines("today", model.activity.today, cells));
    lines.push(...windowLines("7 days", model.activity.week, cells));
  }

  const quota = model.quota;
  if (quota !== undefined && quota.cells.length > 0) {
    lines.push([]);
    lines.push([{ text: quota.heading, style: "bold" }]);
    for (const cell of quota.cells) {
      lines.push(
        field(
          cell.backend,
          QUOTA_LABEL_WIDTH,
          cell.value === undefined
            ? { text: "…", style: "dim" }
            : { text: cell.value },
        ),
      );
    }
  }
  return lines;
}

// --- The box ----------------------------------------------------------------

function pad(line: Line | undefined, cells: number, color: boolean): string {
  return renderLine(line ?? [], cells, color);
}

/**
 * Renders the dashboard as lines, with no trailing newline on any of them.
 *
 * Two layouts: side by side above {@link NARROW_COLUMNS}, stacked below it.
 * The box never exceeds the terminal's width (a box that wraps is not a box)
 * and never exceeds {@link MAX_COLUMNS} either, because a full-width panel on
 * an ultrawide terminal is a wall, not a summary.
 */
export function renderDashboard(
  model: DashboardModel,
  options: DashboardOptions = {},
): readonly string[] {
  const color = options.color ?? false;
  const terminal = Math.max(
    MIN_COLUMNS,
    Math.min(options.columns ?? DEFAULT_COLUMNS, MAX_COLUMNS),
  );
  const title: Line = [{ text: `kapel v${model.version}`, style: "bold" }];

  if (terminal < NARROW_COLUMNS) {
    const inner = terminal - 4;
    const body = [
      ...setupLines(model, inner),
      [],
      ...activityLines(model, inner),
    ];
    return [
      `╭${"─".repeat(terminal - 2)}╮`,
      `│ ${pad(title, inner, color)} │`,
      `├${"─".repeat(terminal - 2)}┤`,
      ...body.map((line) => `│ ${pad(line, inner, color)} │`),
      `╰${"─".repeat(terminal - 2)}╯`,
    ];
  }

  // 1 border + 1 pad + left + 1 pad + 1 divider + 1 pad + right + 1 pad + 1
  const inner = terminal - 7;
  const left = Math.max(20, Math.round(inner * LEFT_SHARE));
  const right = inner - left;

  const leftLines = setupLines(model, left);
  const rightLines = activityLines(model, right);
  const rows = Math.max(leftLines.length, rightLines.length);

  const body: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    body.push(
      `│ ${pad(leftLines[i], left, color)} │ ${pad(rightLines[i], right, color)} │`,
    );
  }

  return [
    `╭${"─".repeat(terminal - 2)}╮`,
    `│ ${pad(title, terminal - 4, color)} │`,
    `├${"─".repeat(left + 2)}┬${"─".repeat(right + 2)}┤`,
    ...body,
    `╰${"─".repeat(left + 2)}┴${"─".repeat(right + 2)}╯`,
  ];
}
