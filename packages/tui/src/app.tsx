import { Box, Text } from "ink";
import type { JSX } from "react";
import { type TuiState, type TuiTask, truncate } from "./model.js";

export interface OrchestrationAppProps {
  readonly state: TuiState;
  /** Wall-clock milliseconds, injected so rendering stays deterministic. */
  readonly now: number;
}

/** Total render width. Fixed so frames are byte-stable across terminals. */
const WIDTH = 80;
/** How many log lines the footer area shows. */
const LOG_LINES = 8;

const GLYPHS: Record<TuiTask["status"], string> = {
  pending: "▷",
  running: "▶",
  completed: "✔",
  failed: "✖",
  cancelled: "⊘",
  held: "⏸",
};

const COLORS: Record<TuiTask["status"], string> = {
  pending: "gray",
  running: "cyan",
  completed: "green",
  failed: "red",
  cancelled: "yellow",
  held: "yellow",
};

/**
 * The whole dashboard, as a pure function of state and the current time.
 *
 * No hooks, no input handling, no clock of its own: everything that moves is a
 * prop, so a frame can be asserted on directly in tests.
 */
export function OrchestrationApp({
  state,
  now,
}: OrchestrationAppProps): JSX.Element {
  const { tasks } = state;
  const done = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.filter(
    (task) => task.status === "failed" || task.status === "cancelled",
  ).length;
  const idWidth = columnWidth(
    tasks.map((task) => task.id),
    4,
    18,
  );
  const agentWidth = columnWidth(
    tasks.map((task) => task.agent ?? ""),
    0,
    14,
  );
  const log = state.log.slice(-LOG_LINES);

  return (
    <Box flexDirection="column" width={WIDTH}>
      <Text bold>
        {truncate(`▪ ${state.objective ?? "orchestration run"}`, WIDTH)}
      </Text>
      <Text dimColor>
        {truncate(statusLine(state, now, done, failed), WIDTH)}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {tasks.length === 0 ? (
          <Text dimColor>no tasks yet</Text>
        ) : (
          tasks.map((task) => (
            <Text key={task.id} color={COLORS[task.status]}>
              {taskRow(task, idWidth, agentWidth)}
            </Text>
          ))
        )}
      </Box>

      {log.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {/* One Text node: the log is a positional ring with no stable keys. */}
          <Text dimColor wrap="truncate-end">
            {log.map((line) => truncate(line, WIDTH)).join("\n")}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text bold={state.finished}>
          {truncate(footer(state, done, failed), WIDTH)}
        </Text>
      </Box>
    </Box>
  );
}

function statusLine(
  state: TuiState,
  now: number,
  done: number,
  failed: number,
): string {
  const parts: string[] = [];
  if (state.runId !== undefined) parts.push(`run ${state.runId.slice(0, 8)}`);
  parts.push(formatElapsed(elapsedMs(state, now)));
  parts.push(`${done}/${state.tasks.length} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

function footer(state: TuiState, done: number, failed: number): string {
  const counts = `${done}/${state.tasks.length} done${failed > 0 ? `, ${failed} failed` : ""}`;
  if (!state.finished) return `⟳ running — ${counts}`;
  return `■ finished — ${counts}${state.outcome === undefined ? "" : ` · ${state.outcome}`}`;
}

function taskRow(task: TuiTask, idWidth: number, agentWidth: number): string {
  const head = `${GLYPHS[task.status]} ${pad(task.id, idWidth)}`;
  const agent = agentWidth === 0 ? "" : ` ${pad(task.agent ?? "", agentWidth)}`;
  const attempts = task.attempts > 1 ? ` ×${task.attempts}` : "";
  const detailText = [task.note, task.summary].find(
    (part) => part !== undefined && part !== "",
  );
  const prefix = `${head}${agent}${attempts}`;
  if (detailText === undefined) return prefix;
  const room = WIDTH - prefix.length - 3;
  return room < 8
    ? prefix
    : `${prefix} — ${truncate(detailText.replace(/\s+/g, " ").trim(), room)}`;
}

function elapsedMs(state: TuiState, now: number): number {
  if (state.startedAt === undefined) return 0;
  return Math.max(0, now - state.startedAt);
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours === 0 ? mm : `${hours}:${mm}`;
}

function columnWidth(
  values: readonly string[],
  min: number,
  max: number,
): number {
  const widest = values.reduce(
    (width, value) => Math.max(width, value.length),
    min,
  );
  return Math.min(widest, max);
}

function pad(value: string, width: number): string {
  const text = truncate(value, width);
  return text.padEnd(width, " ");
}
