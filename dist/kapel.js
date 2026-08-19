#!/usr/bin/env node
import { createRequire as __kapelCreateRequire } from "node:module";
const require = __kapelCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/tui/dist/model.js
function initialTuiState(init) {
  const tasks = (init?.taskIds ?? []).map((seed) => buildTask({
    id: seed.id,
    status: "pending",
    attempts: 0,
    ...pick("summary", seed.title)
  }));
  return {
    tasks,
    log: [],
    finished: false,
    ...pick("objective", init?.objective)
  };
}
function finishTuiState(state, outcome) {
  if (state.finished && state.outcome === outcome)
    return state;
  return { ...state, finished: true, outcome };
}
function reduceTuiEvent(state, event2) {
  const base = adoptEnvelope(state, event2);
  const data = isRecord6(event2.data) ? event2.data : {};
  const tasks = reduceTasks(base.tasks, event2, data);
  const line = formatEventLine(event2);
  const log = line === void 0 ? base.log : appendLog(base.log, line);
  if (tasks === base.tasks && log === base.log)
    return base;
  return { ...base, tasks, log };
}
function formatEventLine(event2) {
  const data = isRecord6(event2.data) ? event2.data : {};
  if (event2.type.startsWith("codex."))
    return formatCodexLine(data);
  const taskId = taskIdOf2(event2, data);
  switch (event2.type) {
    case "model.turn.completed": {
      const text2 = str2(data.text);
      return text2 === void 0 ? void 0 : truncate4(collapse(text2), MAX_LINE);
    }
    case "tool.execution.started": {
      const tool = str2(data.tool) ?? "?";
      const preview = previewInput2(data.input);
      return truncate4(`\u2192 ${tool}${preview === "" ? "" : ` ${preview}`}`, MAX_LINE);
    }
    case "tool.execution.completed": {
      if (data.ok === true)
        return "  \u2713";
      return `  \u2717 (${data.denied === true ? "denied" : "error"})`;
    }
    case "task.started": {
      const agent = str2(data.agent) ?? "?";
      return `\u25B6 ${taskId} \u2192 ${agent} (attempt ${num2(data.attempt) ?? 1})`;
    }
    case "task.completed": {
      const result = isRecord6(data.result) ? data.result : {};
      const glyph = result.status === "success" ? "\u2714" : "\u2716";
      const suffix = data.final === false ? " (retrying)" : "";
      return `${glyph} ${taskId} \u2014 ${firstLine3(result.summary)}${suffix}`;
    }
    case "task.escalated": {
      const from = str2(data.from) ?? "(unassigned)";
      return `\u2191 ${taskId} rerouted ${from} \u2192 ${str2(data.to) ?? "?"}`;
    }
    case "task.cancelled":
      return `\u2298 ${taskId} (${str2(data.reason) ?? "cancelled"})`;
    case "task.held": {
      const blocker = str2(data.conflictsWith);
      return `\u23F8 ${taskId} held${blocker === void 0 ? "" : ` (conflicts with ${blocker})`}`;
    }
    case "task.low_confidence": {
      const confidence = num2(data.confidence) ?? 0;
      const threshold = num2(data.threshold) ?? 0;
      const verdict = data.accepted === true ? "accepted (attempts exhausted)" : "redoing";
      return `\u21BB ${taskId} low confidence ${confidence.toFixed(2)} < ${threshold.toFixed(2)} \u2014 ${verdict}`;
    }
    case "worktree.created":
      return `\u2387 ${taskId} worktree created (${str2(data.branch) ?? "?"})`;
    case "worktree.integrated": {
      if (data.merged === true) {
        const commit = str2(data.commit);
        return `\u21E1 ${taskId} merged${commit === void 0 ? "" : ` \u2192 ${commit.slice(0, 8)}`}`;
      }
      const files = stringList(data.conflictFiles);
      return files.length === 0 ? `\u26A0 ${taskId} not merged (${str2(data.reason) ?? "unknown reason"})` : `\u26A0 ${taskId} merge conflict: ${files.join(", ")}`;
    }
    case "worktree.removed": {
      if (data.keptBranch !== true)
        return void 0;
      return `\u2387 ${taskId} branch kept: ${str2(data.branch) ?? "?"}`;
    }
    case "validation.started":
      return `\u2699 ${taskId} validator ${str2(data.name) ?? "?"}\u2026`;
    case "validation.completed": {
      const name = str2(data.name) ?? "?";
      const duration = `${((num2(data.durationMs) ?? 0) / 1e3).toFixed(1)}s`;
      if (data.passed === true)
        return `  \u2713 ${name} (${duration})`;
      const exitCode = num2(data.exitCode);
      return `  \u2717 ${name} (exit ${exitCode === void 0 ? "unknown" : exitCode}, ${duration})`;
    }
    default:
      return void 0;
  }
}
function reduceTasks(tasks, event2, data) {
  switch (event2.type) {
    case "task.started":
    case "task.completed":
    case "task.escalated":
    case "task.cancelled":
    case "task.held":
    case "task.low_confidence":
    case "validation.completed":
      break;
    default:
      return tasks;
  }
  const id = taskIdOf2(event2, data);
  if (id === "?")
    return tasks;
  return updateTask(tasks, id, (draft) => {
    switch (event2.type) {
      case "task.started": {
        draft.status = "running";
        const agent = str2(data.agent);
        if (agent !== void 0)
          draft.agent = agent;
        draft.attempts = num2(data.attempt) ?? draft.attempts + 1;
        break;
      }
      case "task.completed": {
        const result = isRecord6(data.result) ? data.result : {};
        const summary = str2(result.summary);
        if (summary !== void 0)
          draft.summary = firstLine3(summary);
        const attempt = num2(data.attempt);
        if (attempt !== void 0)
          draft.attempts = attempt;
        if (data.final === false) {
          draft.status = "running";
          draft.note = `retrying (attempt ${draft.attempts})`;
          break;
        }
        const ok = result.status === "success";
        draft.status = ok ? "completed" : "failed";
        if (ok)
          delete draft.note;
        break;
      }
      case "task.escalated":
        draft.note = `\u2192 ${str2(data.to) ?? "?"}`;
        break;
      case "task.cancelled":
        draft.status = "cancelled";
        draft.note = str2(data.reason) ?? "cancelled";
        break;
      case "task.held": {
        if (draft.status !== "pending" && draft.status !== "held")
          break;
        draft.status = "held";
        const blocker = str2(data.conflictsWith);
        draft.note = blocker === void 0 ? "held" : `held by ${blocker}`;
        break;
      }
      case "task.low_confidence": {
        const confidence = num2(data.confidence) ?? 0;
        const verdict = data.accepted === true ? " (accepted)" : "";
        draft.note = `low confidence ${confidence.toFixed(2)}${verdict}`;
        break;
      }
      case "validation.completed": {
        if (data.passed === true)
          break;
        const failure = `\u2717 ${str2(data.name) ?? "?"}`;
        draft.note = draft.note === void 0 ? failure : `${draft.note} \xB7 ${failure}`;
        break;
      }
      default:
        break;
    }
  });
}
function updateTask(tasks, id, update) {
  const index2 = tasks.findIndex((task) => task.id === id);
  const existing = index2 === -1 ? void 0 : tasks[index2];
  const draft = existing === void 0 ? { id, status: "pending", attempts: 0 } : { ...existing };
  update(draft);
  const next = buildTask(draft);
  if (existing !== void 0 && sameTask(existing, next))
    return tasks;
  if (index2 === -1)
    return [...tasks, next];
  return tasks.map((task, i) => i === index2 ? next : task);
}
function sameTask(a, b) {
  return a.id === b.id && a.agent === b.agent && a.status === b.status && a.attempts === b.attempts && a.summary === b.summary && a.note === b.note;
}
function buildTask(draft) {
  return {
    id: draft.id,
    status: draft.status,
    attempts: draft.attempts,
    ...pick("agent", draft.agent),
    ...pick("summary", draft.summary),
    ...pick("note", draft.note)
  };
}
function pick(key, value) {
  return value === void 0 ? {} : { [key]: value };
}
function adoptEnvelope(state, event2) {
  if (state.runId !== void 0 && state.startedAt !== void 0)
    return state;
  return {
    ...state,
    runId: state.runId ?? event2.runId,
    startedAt: state.startedAt ?? event2.timestamp
  };
}
function appendLog(log, line) {
  const next = [...log, line];
  return next.length <= MAX_LOG_LINES ? next : next.slice(next.length - MAX_LOG_LINES);
}
function isRecord6(value) {
  return typeof value === "object" && value !== null;
}
function str2(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function num2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function taskIdOf2(event2, data) {
  return event2.taskId ?? str2(data.taskId) ?? "?";
}
function truncate4(text2, limit) {
  return text2.length <= limit ? text2 : `${text2.slice(0, Math.max(1, limit - 1))}\u2026`;
}
function collapse(text2) {
  return text2.replace(/\s+/g, " ").trim();
}
function firstLine3(text2) {
  if (typeof text2 !== "string")
    return "(no summary)";
  const line = text2.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === void 0 ? "(no summary)" : truncate4(line, MAX_SUMMARY);
}
function previewInput2(input) {
  if (input === void 0 || input === null)
    return "";
  if (typeof input === "string")
    return truncate4(collapse(input), 60);
  try {
    return truncate4(collapse(JSON.stringify(input) ?? ""), 60);
  } catch {
    return "";
  }
}
function formatCodexLine(data) {
  const item = codexItem(data);
  if (item === void 0)
    return void 0;
  switch (str2(item.type)) {
    case "agent_message": {
      const text2 = codexMessageText2(item);
      return text2 === void 0 ? void 0 : truncate4(collapse(text2), MAX_LINE);
    }
    case "command_execution": {
      const command = codexCommandText2(item);
      return command === void 0 ? void 0 : `\u2192 codex: ${truncate4(command, MAX_SUMMARY)}`;
    }
    case "file_change": {
      const summary = codexFileText(item);
      return summary === void 0 ? void 0 : `\u270E ${truncate4(summary, MAX_SUMMARY)}`;
    }
    default:
      return void 0;
  }
}
function codexItem(data) {
  if (isRecord6(data.item))
    return data.item;
  if (isRecord6(data.msg) && isRecord6(data.msg.item))
    return data.msg.item;
  return void 0;
}
function codexMessageText2(item) {
  const direct = str2(item.text) ?? str2(item.message);
  if (direct !== void 0)
    return direct;
  const content = item.content;
  if (typeof content === "string")
    return str2(content);
  if (!Array.isArray(content))
    return void 0;
  const joined = content.map((part) => typeof part === "string" ? part : isRecord6(part) ? str2(part.text) ?? "" : "").join("");
  return str2(joined);
}
function codexCommandText2(item) {
  const direct = str2(item.command) ?? str2(item.cmd);
  if (direct !== void 0)
    return direct;
  const argv = stringList(item.argv ?? item.command);
  return argv.length === 0 ? void 0 : argv.join(" ");
}
function codexFileText(item) {
  const direct = str2(item.path) ?? str2(item.file) ?? str2(item.summary);
  if (direct !== void 0)
    return direct;
  const changes = item.changes;
  if (!Array.isArray(changes))
    return void 0;
  const paths = [];
  for (const change of changes) {
    if (typeof change === "string")
      paths.push(change);
    else if (isRecord6(change)) {
      const path10 = str2(change.path) ?? str2(change.file);
      if (path10 !== void 0)
        paths.push(path10);
    }
  }
  return paths.length === 0 ? void 0 : paths.join(", ");
}
var MAX_LOG_LINES, MAX_SUMMARY, MAX_LINE;
var init_model = __esm({
  "packages/tui/dist/model.js"() {
    "use strict";
    MAX_LOG_LINES = 100;
    MAX_SUMMARY = 120;
    MAX_LINE = 160;
  }
});

// packages/tui/dist/app.js
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
function OrchestrationApp({ state, now }) {
  const { tasks } = state;
  const done = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.filter((task) => task.status === "failed" || task.status === "cancelled").length;
  const idWidth = columnWidth(tasks.map((task) => task.id), 4, 18);
  const agentWidth = columnWidth(tasks.map((task) => task.agent ?? ""), 0, 14);
  const log = state.log.slice(-LOG_LINES);
  return _jsxs(Box, { flexDirection: "column", width: WIDTH, children: [_jsx(Text, { bold: true, children: truncate4(`\u25AA ${state.objective ?? "orchestration run"}`, WIDTH) }), _jsx(Text, { dimColor: true, children: truncate4(statusLine(state, now, done, failed), WIDTH) }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: tasks.length === 0 ? _jsx(Text, { dimColor: true, children: "no tasks yet" }) : tasks.map((task) => _jsx(Text, { color: COLORS[task.status], children: taskRow2(task, idWidth, agentWidth) }, task.id)) }), log.length > 0 && _jsx(Box, { flexDirection: "column", marginTop: 1, children: _jsx(Text, { dimColor: true, wrap: "truncate-end", children: log.map((line) => truncate4(line, WIDTH)).join("\n") }) }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { bold: state.finished, children: truncate4(footer(state, done, failed), WIDTH) }) })] });
}
function statusLine(state, now, done, failed) {
  const parts = [];
  if (state.runId !== void 0)
    parts.push(`run ${state.runId.slice(0, 8)}`);
  parts.push(formatElapsed(elapsedMs(state, now)));
  parts.push(`${done}/${state.tasks.length} done`);
  if (failed > 0)
    parts.push(`${failed} failed`);
  return parts.join(" \xB7 ");
}
function footer(state, done, failed) {
  const counts = `${done}/${state.tasks.length} done${failed > 0 ? `, ${failed} failed` : ""}`;
  if (!state.finished)
    return `\u27F3 running \u2014 ${counts}`;
  return `\u25A0 finished \u2014 ${counts}${state.outcome === void 0 ? "" : ` \xB7 ${state.outcome}`}`;
}
function taskRow2(task, idWidth, agentWidth) {
  const head = `${GLYPHS[task.status]} ${pad(task.id, idWidth)}`;
  const agent = agentWidth === 0 ? "" : ` ${pad(task.agent ?? "", agentWidth)}`;
  const attempts = task.attempts > 1 ? ` \xD7${task.attempts}` : "";
  const detailText = [task.note, task.summary].find((part) => part !== void 0 && part !== "");
  const prefix = `${head}${agent}${attempts}`;
  if (detailText === void 0)
    return prefix;
  const room = WIDTH - prefix.length - 3;
  return room < 8 ? prefix : `${prefix} \u2014 ${truncate4(detailText.replace(/\s+/g, " ").trim(), room)}`;
}
function elapsedMs(state, now) {
  if (state.startedAt === void 0)
    return 0;
  return Math.max(0, now - state.startedAt);
}
function formatElapsed(ms) {
  const total = Math.floor(ms / 1e3);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours === 0 ? mm : `${hours}:${mm}`;
}
function columnWidth(values, min, max) {
  const widest = values.reduce((width, value) => Math.max(width, value.length), min);
  return Math.min(widest, max);
}
function pad(value, width) {
  const text2 = truncate4(value, width);
  return text2.padEnd(width, " ");
}
var WIDTH, LOG_LINES, GLYPHS, COLORS;
var init_app = __esm({
  "packages/tui/dist/app.js"() {
    "use strict";
    init_model();
    WIDTH = 80;
    LOG_LINES = 8;
    GLYPHS = {
      pending: "\u25B7",
      running: "\u25B6",
      completed: "\u2714",
      failed: "\u2716",
      cancelled: "\u2298",
      held: "\u23F8"
    };
    COLORS = {
      pending: "gray",
      running: "cyan",
      completed: "green",
      failed: "red",
      cancelled: "yellow",
      held: "yellow"
    };
  }
});

// packages/tui/dist/runner.js
import { render } from "ink";
import { createElement } from "react";
function startOrchestrationTui(init) {
  const clock = init?.clock ?? Date.now;
  let state = initialTuiState(init);
  let pending;
  let unmounted = false;
  const instance = render(createElement(OrchestrationApp, { state, now: clock() }), {
    ...init?.stdout === void 0 ? {} : { stdout: init.stdout },
    patchConsole: false,
    exitOnCtrlC: false
  });
  const paint = () => {
    if (unmounted)
      return;
    instance.rerender(createElement(OrchestrationApp, { state, now: clock() }));
  };
  const clearPending = () => {
    if (pending === void 0)
      return;
    clearTimeout(pending);
    pending = void 0;
  };
  const schedule = () => {
    if (unmounted || pending !== void 0)
      return;
    pending = setTimeout(() => {
      pending = void 0;
      paint();
    }, RENDER_INTERVAL_MS);
    unref(pending);
  };
  const tick = setInterval(paint, TICK_INTERVAL_MS);
  unref(tick);
  const sink = {
    emit(event2) {
      try {
        state = reduceTuiEvent(state, event2);
        schedule();
      } catch {
      }
    }
  };
  return {
    sink,
    get state() {
      return state;
    },
    finish(outcome) {
      try {
        state = finishTuiState(state, outcome);
        clearPending();
        paint();
      } catch {
      }
    },
    async unmount() {
      if (unmounted)
        return;
      clearPending();
      clearInterval(tick);
      paint();
      unmounted = true;
      const exited = instance.waitUntilExit();
      instance.unmount();
      await exited;
    }
  };
}
function unref(timer) {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
var RENDER_INTERVAL_MS, TICK_INTERVAL_MS;
var init_runner = __esm({
  "packages/tui/dist/runner.js"() {
    "use strict";
    init_app();
    init_model();
    RENDER_INTERVAL_MS = 50;
    TICK_INTERVAL_MS = 1e3;
  }
});

// packages/tui/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  MAX_LOG_LINES: () => MAX_LOG_LINES,
  OrchestrationApp: () => OrchestrationApp,
  finishTuiState: () => finishTuiState,
  formatEventLine: () => formatEventLine,
  initialTuiState: () => initialTuiState,
  reduceTuiEvent: () => reduceTuiEvent,
  startOrchestrationTui: () => startOrchestrationTui
});
var init_dist = __esm({
  "packages/tui/dist/index.js"() {
    "use strict";
    init_app();
    init_model();
    init_runner();
  }
});

// apps/cli/dist/index.js
import path9 from "node:path";
import { Command } from "commander";

// apps/cli/dist/backend.js
var BACKEND_NAMES = ["native", "codex"];
var DEFAULT_BACKEND = "native";
function isBackendName(value) {
  return BACKEND_NAMES.includes(value);
}
function resolveBackendName(env, flag) {
  if (flag !== void 0 && flag !== "")
    return flag;
  const fromEnv = env.AGENT_BACKEND;
  if (fromEnv !== void 0 && fromEnv !== "")
    return fromEnv;
  return DEFAULT_BACKEND;
}
function validateBackendName(raw) {
  if (isBackendName(raw))
    return raw;
  throw new Error(`Invalid --backend value "${raw}": expected one of ${BACKEND_NAMES.join(", ")}.`);
}
var SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access"
];
var DEFAULT_SANDBOX_MODE = "workspace-write";
function isSandboxMode(value) {
  return SANDBOX_MODES.includes(value);
}
function validateSandboxMode(raw) {
  if (isSandboxMode(raw))
    return raw;
  throw new Error(`Invalid --sandbox value "${raw}": expected one of ${SANDBOX_MODES.join(", ")}.`);
}
function fullAutoForSandbox(sandbox) {
  return sandbox !== "read-only";
}
function codexModelOverride(raw) {
  return raw === void 0 || raw === "" ? void 0 : raw;
}
function codexInstallGuidance(availability) {
  const lines = [
    "The Codex CLI is not installed.",
    "Install it with `npm install -g @openai/codex`, then authenticate with `codex login`."
  ];
  if (availability.detail !== void 0 && availability.detail !== "") {
    lines.push(availability.detail);
  }
  return lines.join("\n");
}
function codexLoginGuidance(availability) {
  const lines = [
    "The Codex CLI is installed but you are not logged in.",
    "Run `codex login` to authenticate with your ChatGPT account \u2014 no OpenAI API key needed."
  ];
  if (availability.detail !== void 0 && availability.detail !== "") {
    lines.push(availability.detail);
  }
  return lines.join("\n");
}

// apps/cli/dist/env.js
import { readFile } from "node:fs/promises";
import path from "node:path";
var LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
function unquote(raw) {
  const value = raw.trim();
  if (value.length < 2)
    return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === '"' && last === '"' || first === "'" && last === "'") {
    return value.slice(1, -1);
  }
  return value;
}
function parseDotEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#"))
      continue;
    const match = LINE_RE.exec(line);
    if (match === null)
      continue;
    const [, key = "", rawValue = ""] = match;
    if (key === "")
      continue;
    result[key] = unquote(rawValue);
  }
  return result;
}
function applyDotEnv(parsed, target = process.env) {
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === void 0)
      target[key] = value;
  }
}
async function loadDotEnvFile(workspaceRoot, target = process.env) {
  const filePath = path.join(workspaceRoot, ".env");
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  applyDotEnv(parseDotEnv(content), target);
}

// packages/orchestration/dist/conflicts.js
var MUTATING_TASK_TYPES = /* @__PURE__ */ new Set([
  "architecture",
  "implementation",
  "testing",
  "documentation"
]);
function isWholeRepo(area) {
  return area === "**" || area === "" || area === ".";
}
function normalizeArea(area) {
  const slashed = area.replace(/\\/g, "/");
  const withoutLeading = slashed.startsWith("./") ? slashed.slice(2) : slashed;
  return withoutLeading.length > 1 && withoutLeading.endsWith("/") ? withoutLeading.slice(0, -1) : withoutLeading;
}
function prefixOverlap(x, y) {
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
function areasOverlap(a, b) {
  const normalizedA = a.map(normalizeArea);
  const normalizedB = b.map(normalizeArea);
  for (const x of normalizedA) {
    for (const y of normalizedB) {
      if (isWholeRepo(x) || isWholeRepo(y) || prefixOverlap(x, y))
        return true;
    }
  }
  return false;
}
function tasksConflict(a, b) {
  if (!MUTATING_TASK_TYPES.has(a.type) || !MUTATING_TASK_TYPES.has(b.type))
    return false;
  const areasA = a.affectedAreas.length === 0 ? ["**"] : a.affectedAreas;
  const areasB = b.affectedAreas.length === 0 ? ["**"] : b.affectedAreas;
  return areasOverlap(areasA, areasB);
}

// packages/orchestration/dist/graph.js
var TaskGraph = class {
  #tasks = /* @__PURE__ */ new Map();
  constructor(plan) {
    for (const spec of plan.tasks) {
      if (this.#tasks.has(spec.id))
        throw new Error(`Duplicate task id: ${spec.id}`);
      this.#tasks.set(spec.id, { spec, status: "pending", attempts: 0 });
    }
    this.#assertDependenciesExist();
    this.#assertAcyclic();
  }
  all() {
    return [...this.#tasks.values()];
  }
  get(id) {
    const task = this.#tasks.get(id);
    if (!task)
      throw new Error(`Unknown task: ${id}`);
    return task;
  }
  ready() {
    const completed = new Set(this.all().filter((t) => t.status === "completed").map((t) => t.spec.id));
    return this.all().filter((task) => (task.status === "pending" || task.status === "ready") && task.spec.dependencies.every((dependency) => completed.has(dependency)));
  }
  done() {
    return this.all().every((task) => ["completed", "failed", "cancelled"].includes(task.status));
  }
  /** Tasks that declare `id` as a direct dependency. */
  dependentsOf(id) {
    return this.all().filter((task) => task.spec.dependencies.includes(id));
  }
  #assertDependenciesExist() {
    for (const task of this.all()) {
      for (const dependency of task.spec.dependencies) {
        if (!this.#tasks.has(dependency))
          throw new Error(`Task ${task.spec.id} depends on missing task ${dependency}`);
      }
    }
  }
  #assertAcyclic() {
    const visiting = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set();
    const visit = (id) => {
      if (visiting.has(id))
        throw new Error(`Task graph contains a cycle at ${id}`);
      if (visited.has(id))
        return;
      visiting.add(id);
      for (const dependency of this.get(id).spec.dependencies)
        visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of this.all())
      visit(task.spec.id);
  }
};

// packages/orchestration/dist/types.js
var TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled"
];
function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}
var COMPLEXITY_ORDER = [
  "trivial",
  "normal",
  "complex",
  "architectural"
];
function complexityRank(complexity) {
  const index2 = COMPLEXITY_ORDER.indexOf(complexity);
  return index2 === -1 ? 0 : index2;
}

// packages/orchestration/dist/plan-policy.js
function applyPolicyToPlan(plan, policy, knownAgents) {
  const issues = [];
  const notes = [];
  const ids = /* @__PURE__ */ new Set();
  for (const task of plan.tasks) {
    if (ids.has(task.id))
      issues.push(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  const tasks = plan.tasks.map((task) => sanitizeAgent(task, knownAgents, notes));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id)
        issues.push(`Task ${task.id} depends on itself.`);
      else if (!ids.has(dependency))
        issues.push(`Task ${task.id} depends on missing task ${dependency}`);
    }
  }
  if (issues.length === 0) {
    try {
      new TaskGraph({ objective: plan.objective, tasks });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  const injected = [];
  const injectedReviews = [];
  const taken = new Set(ids);
  for (const rule of policy.review) {
    if (rule.riskCategories.length === 0 && rule.minimumComplexity === void 0)
      notes.push(`Review rule ${rule.id} constrains neither risk categories nor minimum complexity, so it matches no task and injected nothing.`);
  }
  for (const rule of policy.review) {
    for (const task of tasks) {
      if (!ruleMatches(rule, task))
        continue;
      if (task.type === "review")
        continue;
      const id = sanitizeId(`${task.id}-review-${rule.id}`);
      if (taken.has(id))
        continue;
      if ([...tasks, ...injected].some((candidate) => candidate.type === "review" && candidate.dependencies.includes(task.id) && candidate.suggestedAgent === rule.reviewer))
        continue;
      const reviewerKnown = knownAgents.has(rule.reviewer);
      if (!reviewerKnown)
        notes.push(`Review rule ${rule.id} names unknown reviewer "${rule.reviewer}"; ${id} was injected without a suggested agent.`);
      injected.push({
        id,
        title: `Review: ${task.title}`,
        goal: `Review the work done by ${task.id} (${task.title}) against policy rule ${rule.id}${rule.riskCategories.length === 0 ? "" : ` covering ${rule.riskCategories.join(", ")}`}. Confirm the goal was met, flag defects and risks, and state whether the change is safe to keep.`,
        type: "review",
        complexity: "normal",
        dependencies: [task.id],
        ...reviewerKnown ? { suggestedAgent: rule.reviewer } : {},
        affectedAreas: task.affectedAreas,
        risk: task.risk
      });
      taken.add(id);
      injectedReviews.push(id);
    }
  }
  return {
    plan: { objective: plan.objective, tasks: [...tasks, ...injected] },
    injectedReviews,
    issues,
    notes
  };
}
function ruleMatches(rule, task) {
  const hasCategories = rule.riskCategories.length > 0;
  const hasComplexity = rule.minimumComplexity !== void 0;
  if (!hasCategories && !hasComplexity)
    return false;
  if (hasCategories && !rule.riskCategories.some((category) => task.risk.categories.includes(category)))
    return false;
  if (rule.minimumComplexity !== void 0 && complexityRank(task.complexity) < complexityRank(rule.minimumComplexity))
    return false;
  return true;
}
function sanitizeAgent(task, knownAgents, notes) {
  if (task.suggestedAgent === void 0 || knownAgents.has(task.suggestedAgent))
    return task;
  notes.push(`Task ${task.id} suggested unknown agent "${task.suggestedAgent}"; the suggestion was dropped.`);
  const { suggestedAgent: _dropped, ...rest } = task;
  return rest;
}
function sanitizeId(id) {
  return id.replace(/[^A-Za-z0-9_-]+/g, "-");
}

// packages/orchestration/dist/planner.js
import { z } from "zod";
var EMIT_PLAN_TOOL_NAME = "emit_plan";
var DEFAULT_MAX_ATTEMPTS = 3;
var MIN_TASKS = 1;
var MAX_TASKS = 12;
var TASK_ID_PATTERN = /^T\d{2,3}$/;
var TaskIdSchema = z.string().regex(TASK_ID_PATTERN, 'Task ids look like "T01" (T + two digits).');
var TaskTypeSchema = z.enum([
  "exploration",
  "architecture",
  "implementation",
  "testing",
  "review",
  "documentation"
]);
var TaskComplexitySchema = z.enum([
  "trivial",
  "normal",
  "complex",
  "architectural"
]);
var RiskLevelSchema = z.enum(["low", "medium", "high"]);
var PlannedTaskSchema = z.object({
  id: TaskIdSchema.describe('Stable id for this task, "T01", "T02", ... in plan order.'),
  title: z.string().min(1).describe("Short imperative name for the task."),
  goal: z.string().min(1).describe("What done looks like for this task, concrete enough for another agent to execute it without further context."),
  type: TaskTypeSchema.describe("The kind of work this task is."),
  complexity: TaskComplexitySchema.describe("How much judgement the task needs: trivial < normal < complex < architectural."),
  dependencies: z.array(TaskIdSchema).default([]).describe("Ids of tasks that must finish first. Declare a dependency only when the work genuinely cannot start otherwise."),
  suggestedAgent: z.string().optional().describe("Optional preferred agent, which must be one of the known agents. Omit it when no agent is clearly better."),
  affectedAreas: z.array(z.string()).default([]).describe("Files or directories this task is expected to touch, used to detect conflicts between parallel tasks."),
  risk: z.object({
    level: RiskLevelSchema.describe("Blast radius if this task goes wrong."),
    categories: z.array(z.string()).default([]).describe("Risk areas this task touches, drawn from the policy's vocabulary where they apply.")
  }).describe("Risk assessment used for routing and review decisions.")
});
var ExecutionPlanSchema = z.object({
  objective: z.string().min(1).describe("Restatement of the objective this plan delivers."),
  tasks: z.array(PlannedTaskSchema).min(MIN_TASKS).max(MAX_TASKS).describe("The tasks, in a sensible execution order.")
});
function buildToolInputSchema() {
  const generated = z.toJSONSchema(ExecutionPlanSchema, {
    io: "input"
  });
  const schema = {};
  for (const [key, value] of Object.entries(generated)) {
    if (key !== "$schema")
      schema[key] = value;
  }
  schema.required = ["objective", "tasks"];
  return schema;
}
var emitPlanTool = {
  name: EMIT_PLAN_TOOL_NAME,
  description: "Emit the execution plan: the decomposition of the objective into individually executable tasks.",
  inputSchema: buildToolInputSchema()
};
function riskVocabulary(policy) {
  const categories = /* @__PURE__ */ new Set();
  for (const rule of policy.routing)
    for (const category of rule.riskCategories)
      categories.add(category);
  for (const rule of policy.review)
    for (const category of rule.riskCategories)
      categories.add(category);
  return [...categories].sort();
}
function systemPrompt(policy, knownAgents) {
  const agents = knownAgents.length === 0 ? "(none declared)" : knownAgents.join(", ");
  const categories = riskVocabulary(policy);
  const riskLine = categories.length === 0 ? "The policy names no risk categories; use short lowercase nouns for the areas this work touches." : `The policy routes and reviews on these risk categories: ${categories.join(", ")}. Use exactly these strings when a task touches one of those areas, and only add another category when none of them fits.`;
  const parallelLine = policy.parallelizeIndependentTasks ? `Independent tasks run concurrently (up to ${policy.maxConcurrency} at a time), so prefer a wide, shallow shape: split work that can proceed in parallel into separate tasks instead of chaining it.` : "Tasks run one at a time, so a mostly linear plan is fine; still declare only the dependencies that are real.";
  return `You are the planner for a multi-agent coding runtime. The user gives you an objective. Decompose it into narrow tasks that other agents can execute independently.

Rules:
- Call the ${EMIT_PLAN_TOOL_NAME} tool exactly once. Never answer with prose.
- Emit between ${MIN_TASKS} and ${MAX_TASKS} tasks. Keep the plan small: one coherent unit of work per task, no bookkeeping tasks, no "task 0: understand the problem" filler.
- Every task must be executable on its own by an agent that sees only its goal, so write goals that carry their own context.
- Ids are "T01", "T02", ... in plan order. Dependencies reference those ids only, must already exist, and must not form a cycle.
- Declare a dependency only when the later task genuinely cannot start until the earlier one finishes. Do not use dependencies to express preferred ordering.
- ${parallelLine}
- affectedAreas lists the files and directories a task will touch (for example "packages/api/src", "docs/README.md"). It is how the runtime detects two tasks colliding, so fill it in for every task.
- ${riskLine}
- Known agent names are: ${agents}. suggestedAgent must be one of them or omitted entirely \u2014 never invent an agent, and prefer omitting it over guessing.
- Task types: exploration, architecture, implementation, testing, review, documentation. Complexity: trivial, normal, complex, architectural.
- The runtime injects policy-mandated reviews itself; only add a review task when the objective explicitly asks for one.`;
}
var PlanError = class extends Error {
  attempts;
  lastIssues;
  constructor(init) {
    super(init.message);
    this.name = "PlanError";
    this.attempts = init.attempts;
    this.lastIssues = init.lastIssues;
  }
};
function toIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message
  }));
}
function formatIssues(issues) {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
}
function toPlannedTask(draft) {
  return {
    id: draft.id,
    title: draft.title,
    goal: draft.goal,
    type: draft.type,
    complexity: draft.complexity,
    dependencies: draft.dependencies,
    ...draft.suggestedAgent === void 0 ? {} : { suggestedAgent: draft.suggestedAgent },
    affectedAreas: draft.affectedAreas,
    risk: { level: draft.risk.level, categories: draft.risk.categories }
  };
}
function toPlan(draft) {
  return { objective: draft.objective, tasks: draft.tasks.map(toPlannedTask) };
}
function validatePlanDraft(plan, knownAgents) {
  const issues = [];
  const seen = /* @__PURE__ */ new Set();
  const known = new Set(knownAgents);
  plan.tasks.forEach((task, index2) => {
    if (seen.has(task.id))
      issues.push({
        path: `tasks.${index2}.id`,
        message: `Duplicate task id "${task.id}".`
      });
    seen.add(task.id);
  });
  plan.tasks.forEach((task, index2) => {
    task.dependencies.forEach((dependency, position) => {
      if (dependency === task.id)
        issues.push({
          path: `tasks.${index2}.dependencies.${position}`,
          message: `Task "${task.id}" depends on itself.`
        });
      else if (!seen.has(dependency))
        issues.push({
          path: `tasks.${index2}.dependencies.${position}`,
          message: `Task "${task.id}" depends on unknown task "${dependency}".`
        });
    });
    if (task.suggestedAgent !== void 0 && !known.has(task.suggestedAgent))
      issues.push({
        path: `tasks.${index2}.suggestedAgent`,
        message: `Unknown agent "${task.suggestedAgent}". Use one of: ${knownAgents.length === 0 ? "(none declared)" : knownAgents.join(", ")}, or omit the field.`
      });
  });
  if (issues.length === 0) {
    try {
      new TaskGraph(plan);
    } catch (error) {
      issues.push({
        path: "tasks",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return issues;
}
var LlmPlanner = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  async plan(objective, policy, signal) {
    const maxAttempts = Math.max(1, this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const messages = [
      {
        role: "system",
        content: systemPrompt(policy, this.#options.knownAgents)
      },
      { role: "user", content: `Plan this objective:

${objective}` }
    ];
    let lastIssues;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const { call, text: text2 } = await this.#runAttempt(messages, signal);
      signal?.throwIfAborted();
      if (call === void 0) {
        lastIssues = [
          {
            path: "(root)",
            message: `no ${EMIT_PLAN_TOOL_NAME} tool call in the response`
          }
        ];
        if (attempt === maxAttempts)
          break;
        messages.push({ role: "assistant", content: text2 });
        messages.push({
          role: "user",
          content: `You did not call ${EMIT_PLAN_TOOL_NAME}. Reply with exactly one ${EMIT_PLAN_TOOL_NAME} tool call carrying the plan, and no prose.`
        });
        continue;
      }
      const parsed = ExecutionPlanSchema.safeParse(call.input);
      if (parsed.success) {
        const plan = toPlan(parsed.data);
        const issues = validatePlanDraft(plan, this.#options.knownAgents);
        if (issues.length === 0)
          return plan;
        lastIssues = issues;
      } else {
        lastIssues = toIssues(parsed.error);
      }
      if (attempt === maxAttempts)
        break;
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: call.id, name: EMIT_PLAN_TOOL_NAME, input: call.input }
        ]
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `That ${EMIT_PLAN_TOOL_NAME} call is not a usable plan:
${formatIssues(lastIssues)}

Call ${EMIT_PLAN_TOOL_NAME} again with a corrected plan that fixes every issue above. Do not reply with prose.`
      });
    }
    throw new PlanError({
      message: `Failed to plan the objective after ${maxAttempts} attempt(s).${lastIssues === void 0 ? "" : `
${formatIssues(lastIssues)}`}`,
      attempts: maxAttempts,
      ...lastIssues === void 0 ? {} : { lastIssues }
    });
  }
  async #runAttempt(messages, signal) {
    const { maxOutputTokens } = this.#options;
    const request = {
      model: this.#options.model,
      messages: [...messages],
      tools: [emitPlanTool],
      toolChoice: { type: "tool", name: EMIT_PLAN_TOOL_NAME },
      ...maxOutputTokens === void 0 ? {} : { maxOutputTokens }
    };
    let call;
    let text2 = "";
    for await (const event2 of this.#options.provider.stream(request, signal)) {
      if (event2.type === "text.delta") {
        text2 += event2.text;
        continue;
      }
      if (event2.type === "tool.call" && event2.name === EMIT_PLAN_TOOL_NAME && call === void 0) {
        call = { id: event2.id, input: event2.input };
      }
    }
    return { call, text: text2 };
  }
};

// packages/orchestration/dist/router.js
var PolicyRouter = class {
  route(task, policy) {
    const candidates = policy.routing.filter((rule) => ruleMatches2(rule, task));
    const hard = candidates.filter((rule) => rule.strength === "hard");
    const pool = hard.length > 0 ? hard : candidates;
    const best = [...pool].sort(byWeightThenId)[0];
    return best?.agent ?? task.suggestedAgent ?? policy.orchestrator;
  }
};
function ruleMatches2(rule, task) {
  return matches(rule.taskTypes, task.type) && matches(rule.riskCategories, task.risk.categories) && matches(rule.complexity, task.complexity);
}
function byWeightThenId(a, b) {
  if (a.weight !== b.weight)
    return b.weight - a.weight;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function matches(expected, actual) {
  if (expected.length === 0)
    return true;
  const values = typeof actual === "string" ? [actual] : actual;
  return expected.some((value) => values.includes(value));
}

// packages/orchestration/dist/scheduler.js
var DeterministicScheduler = class {
  router;
  worker;
  events;
  options;
  constructor(router, worker, events2, options) {
    this.router = router;
    this.worker = worker;
    this.events = events2;
    this.options = options;
  }
  async run(runId, graph, policy, signal) {
    const limit = policy.parallelizeIndependentTasks === false ? 1 : Math.max(1, policy.maxConcurrency);
    const serializeOverlappingAreas = this.options?.serializeOverlappingAreas ?? true;
    const running = /* @__PURE__ */ new Map();
    const runningTasks = /* @__PURE__ */ new Map();
    const heldPairsEmitted = /* @__PURE__ */ new Set();
    let sequence = 0;
    for (; ; ) {
      const aborted = signal?.aborted === true;
      if (!aborted) {
        while (running.size < limit) {
          const next = await this.#nextDispatchable(runId, graph, serializeOverlappingAreas, runningTasks, heldPairsEmitted);
          if (next === void 0)
            break;
          const key = sequence;
          sequence += 1;
          runningTasks.set(key, next);
          running.set(key, this.#attempt(runId, next, graph, policy, signal).then(() => {
            runningTasks.delete(key);
            return key;
          }));
        }
      }
      if (running.size === 0) {
        if (aborted) {
          await this.#cancelRemaining(runId, graph, "aborted");
          return;
        }
        if (graph.done())
          return;
        throw new Error("Scheduler deadlock: unfinished tasks exist but none are runnable.");
      }
      const finished = await Promise.race(running.values());
      running.delete(finished);
    }
  }
  /**
   * The next ready task that is safe to dispatch: the first one (in
   * `graph.ready()` order) that does not conflict with any currently
   * running task. Ready tasks held back by a running conflict each emit
   * `task.held` at most once per (task, blocking task) pair.
   */
  async #nextDispatchable(runId, graph, serializeOverlappingAreas, runningTasks, heldPairsEmitted) {
    const ready = graph.ready();
    if (!serializeOverlappingAreas)
      return ready[0];
    const runningList = [...runningTasks.values()];
    for (const candidate of ready) {
      const blocker = runningList.find((other) => tasksConflict(candidate.spec, other.spec));
      if (blocker === void 0)
        return candidate;
      const pairKey = `${candidate.spec.id}:${blocker.spec.id}`;
      if (!heldPairsEmitted.has(pairKey)) {
        heldPairsEmitted.add(pairKey);
        await this.#emit(runId, "task.held", candidate.spec.id, {
          taskId: candidate.spec.id,
          conflictsWith: blocker.spec.id
        });
      }
    }
    return void 0;
  }
  /** Runs one attempt of `task` and settles it: retried, failed or completed. */
  async #attempt(runId, task, graph, policy, signal) {
    const previousAgent = task.assignedAgent;
    const escalation = this.#escalationFor(task, policy);
    const agent = escalation === void 0 ? this.router.route(task.spec, policy) : escalation.toAgent;
    task.assignedAgent = agent;
    task.status = "running";
    task.attempts += 1;
    if (escalation !== void 0) {
      const from = previousAgent;
      task.lastEscalation = { rule: escalation.id, from, to: agent };
      await this.#emit(runId, "task.escalated", task.spec.id, {
        from,
        to: agent,
        rule: escalation.id
      });
    }
    await this.#emit(runId, "task.started", task.spec.id, {
      agent,
      attempt: task.attempts
    });
    const context = this.#dependencyContext(graph, task);
    const result = await this.#execute(task, agent, signal, context);
    task.result = result;
    const maxAttempts = this.#maxAttemptsFor(policy);
    const canRetry = task.attempts < maxAttempts && signal?.aborted !== true;
    if (result.status === "success") {
      const lowConfidenceRule = this.#lowConfidenceRuleFor(agent, result.confidence, policy);
      if (lowConfidenceRule !== void 0) {
        const accepted = !canRetry;
        await this.#emit(runId, "task.low_confidence", task.spec.id, {
          taskId: task.spec.id,
          agent,
          confidence: result.confidence,
          threshold: lowConfidenceRule.confidenceBelow,
          rule: lowConfidenceRule.id,
          ...accepted ? { accepted: true } : {}
        });
        if (!accepted) {
          task.status = "pending";
          await this.#emit(runId, "task.completed", task.spec.id, {
            agent,
            result,
            attempt: task.attempts,
            final: false
          });
          return;
        }
      }
      task.status = "completed";
      await this.#emit(runId, "task.completed", task.spec.id, {
        agent,
        result,
        attempt: task.attempts,
        final: true
      });
      return;
    }
    const retry = canRetry;
    task.status = retry ? "pending" : "failed";
    await this.#emit(runId, "task.completed", task.spec.id, {
      agent,
      result,
      attempt: task.attempts,
      final: !retry
    });
    if (retry)
      return;
    if (signal?.aborted === true) {
      task.status = "cancelled";
      await this.#emit(runId, "task.cancelled", task.spec.id, {
        reason: "aborted"
      });
      return;
    }
    await this.#cancelDependents(runId, graph, task.spec.id);
  }
  /**
   * The results of `task`'s direct dependencies, in dependency-declaration
   * order. Dependencies with no recorded result (should not happen for a
   * task that reached "ready", but the graph does not guarantee it) are
   * skipped rather than filled with a placeholder.
   */
  #dependencyContext(graph, task) {
    const dependencyResults = [];
    for (const dependencyId of task.spec.dependencies) {
      const result = graph.get(dependencyId).result;
      if (result !== void 0)
        dependencyResults.push(result);
    }
    return { dependencyResults };
  }
  /** A worker that throws counts as a failed attempt, not a crashed run. */
  async #execute(task, agent, signal, context) {
    try {
      return await this.worker.execute(task, agent, signal, context);
    } catch (error) {
      return {
        taskId: task.spec.id,
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        decisions: [],
        changedFiles: [],
        tests: { passed: 0, failed: 0, commands: [] },
        unresolvedIssues: [],
        confidence: 0
      };
    }
  }
  #maxAttemptsFor(policy) {
    return Math.max(1, this.options?.maxAttempts ?? policy.defaultMaxAttempts);
  }
  /**
   * The escalation rule that redirects the *next* attempt of `task`, if any:
   * it must hand off from the agent that just ran, and either its failure
   * threshold or its confidence threshold must be met — the two conditions
   * are OR'd, so a rule with only `confidenceBelow` set matches on
   * confidence alone, with no `afterFailures` required. When several rules
   * match, the one with the lexicographically lowest `id` wins, so escalation
   * target selection is deterministic regardless of policy authoring order.
   */
  #escalationFor(task, policy) {
    const from = task.assignedAgent;
    if (from === void 0 || task.attempts === 0)
      return void 0;
    const confidence = task.result?.confidence ?? 0;
    const matches2 = policy.escalation.filter((rule) => rule.fromAgent === from && (rule.afterFailures !== void 0 && task.attempts >= rule.afterFailures || rule.confidenceBelow !== void 0 && confidence < rule.confidenceBelow));
    return pickLowestId(matches2);
  }
  /**
   * The escalation rule that disqualifies a "success" result from being
   * accepted outright, if any: it must hand off from the agent that just
   * produced the result and the result's confidence must fall below the
   * rule's `confidenceBelow` threshold. Unlike `#escalationFor`,
   * `afterFailures` plays no part here — a rule that only sets
   * `afterFailures` has nothing to say about a confident-or-not success. Lowest
   * `id` wins when several rules match, matching `#escalationFor`'s tie-break.
   */
  #lowConfidenceRuleFor(agent, confidence, policy) {
    const matches2 = policy.escalation.filter((rule) => rule.fromAgent === agent && rule.confidenceBelow !== void 0 && confidence < rule.confidenceBelow);
    return pickLowestId(matches2);
  }
  /** Cancels everything that (transitively) depended on a dead task. */
  async #cancelDependents(runId, graph, id) {
    const queue = [id];
    for (let index2 = 0; index2 < queue.length; index2 += 1) {
      const current = queue[index2];
      if (current === void 0)
        continue;
      for (const dependent of graph.dependentsOf(current)) {
        if (isTerminal(dependent.status))
          continue;
        dependent.status = "cancelled";
        await this.#emit(runId, "task.cancelled", dependent.spec.id, {
          reason: "dependency-failed",
          dependency: current
        });
        queue.push(dependent.spec.id);
      }
    }
  }
  async #cancelRemaining(runId, graph, reason) {
    for (const task of graph.all()) {
      if (isTerminal(task.status))
        continue;
      task.status = "cancelled";
      await this.#emit(runId, "task.cancelled", task.spec.id, { reason });
    }
  }
  async #emit(runId, type, taskId, data) {
    await this.events?.emit(event(runId, type, taskId, data));
  }
};
function pickLowestId(rules) {
  return rules.reduce((best, rule) => best === void 0 || rule.id < best.id ? rule : best, void 0);
}
function event(runId, type, taskId, data) {
  return {
    id: crypto.randomUUID(),
    runId,
    timestamp: Date.now(),
    type,
    taskId,
    data
  };
}

// packages/policy/dist/compiler.js
import { z as z3 } from "zod";

// packages/policy/dist/schema.js
import { z as z2 } from "zod";
var RuleStrengthSchema = z2.enum(["hard", "preference"]);
var ComplexitySchema = z2.enum([
  "trivial",
  "normal",
  "complex",
  "architectural"
]);
var RoutingRuleSchema = z2.object({
  id: z2.string(),
  taskTypes: z2.array(z2.string()).default([]),
  riskCategories: z2.array(z2.string()).default([]),
  complexity: z2.array(ComplexitySchema).default([]),
  agent: z2.string(),
  strength: RuleStrengthSchema,
  weight: z2.number().min(0).max(1).default(1)
});
var ReviewRuleSchema = z2.object({
  id: z2.string(),
  riskCategories: z2.array(z2.string()).default([]),
  minimumComplexity: ComplexitySchema.optional(),
  reviewer: z2.string(),
  blocking: z2.boolean().default(true),
  strength: RuleStrengthSchema.default("hard")
});
var EscalationRuleSchema = z2.object({
  id: z2.string(),
  fromAgent: z2.string(),
  toAgent: z2.string(),
  afterFailures: z2.number().int().positive().optional(),
  confidenceBelow: z2.number().min(0).max(1).optional()
});
var PolicySchema = z2.object({
  version: z2.literal(1),
  orchestrator: z2.string(),
  maxConcurrency: z2.number().int().positive().default(4),
  parallelizeIndependentTasks: z2.boolean().default(true),
  routing: z2.array(RoutingRuleSchema).default([]),
  review: z2.array(ReviewRuleSchema).default([]),
  escalation: z2.array(EscalationRuleSchema).default([]),
  defaultMaxAttempts: z2.number().int().positive().default(2)
});

// packages/policy/dist/compiler.js
var EMIT_POLICY_TOOL_NAME = "emit_policy";
var DEFAULT_MAX_ATTEMPTS2 = 3;
var PolicyDraftSchema = z3.object({
  version: z3.literal(1).describe("IR version. Always 1."),
  orchestrator: z3.string().describe("Name of the agent that plans and delegates. Must be one of the known agents."),
  maxConcurrency: z3.number().int().positive().optional().describe("Maximum number of agents allowed to run at the same time. Defaults to 4."),
  parallelizeIndependentTasks: z3.boolean().optional().describe("Whether tasks with no dependency on each other may run concurrently. Defaults to true."),
  routing: z3.array(RoutingRuleSchema).optional().describe("Rules that pick which agent handles a task."),
  review: z3.array(ReviewRuleSchema).optional().describe("Rules that require a second agent to review work."),
  escalation: z3.array(EscalationRuleSchema).optional().describe("Rules that hand a stuck or low-confidence task to another agent."),
  defaultMaxAttempts: z3.number().int().positive().optional().describe("How many times an agent may attempt a task before the run gives up or escalates. Defaults to 2.")
});
var CompilerOutputSchema = z3.object({
  policy: PolicyDraftSchema,
  warnings: z3.array(z3.string()).default([]).describe("Judgement calls and lossy simplifications made while compiling. Empty array if none."),
  ambiguities: z3.array(z3.string()).default([]).describe("Source phrases that could not be mapped cleanly, each quoting the phrase and saying why. Empty array if none.")
});
function buildToolInputSchema2() {
  const generated = z3.toJSONSchema(CompilerOutputSchema, {
    io: "input"
  });
  const schema = {};
  for (const [key, value] of Object.entries(generated)) {
    if (key !== "$schema")
      schema[key] = value;
  }
  schema.required = ["policy", "warnings", "ambiguities"];
  return schema;
}
var emitPolicyTool = {
  name: EMIT_POLICY_TOOL_NAME,
  description: "Emit the compiled orchestration policy IR, plus any warnings and ambiguities.",
  inputSchema: buildToolInputSchema2()
};
var IR_REFERENCE = `IR semantics, field by field:
- version: always 1.
- orchestrator: the agent that plans work and delegates it.
- maxConcurrency: integer cap on simultaneously running agents. "at most four workers concurrently" -> maxConcurrency 4. "one thing at a time" -> maxConcurrency 1.
- parallelizeIndependentTasks: true when independent tasks may run side by side; false when the policy demands sequential execution.
- defaultMaxAttempts: total attempts an agent gets at a task before giving up. "retry once then escalate" -> defaultMaxAttempts 2 plus an escalation rule.
- routing[]: which agent handles which work.
  - id: short stable kebab-case identifier, unique within the policy.
  - taskTypes: free-form kinds of work the rule matches ("test", "refactor", "docs"). Empty means any task type.
  - riskCategories: risk areas the rule matches ("auth", "payments", "migrations"). Empty means any risk category.
  - complexity: subset of trivial | normal | complex | architectural. Empty means any complexity.
  - agent: the agent the matched work is routed to.
  - strength: "hard" for a requirement ("must", "always", "never"), "preference" for a leaning ("prefer", "usually", "ideally").
  - weight: 0..1 tie-breaker among preferences; use 1 unless the source ranks options.
- review[]: when work must be reviewed by another agent.
  - id, riskCategories, minimumComplexity (trivial | normal | complex | architectural), reviewer.
  - blocking: true when work cannot land until the review passes. "X requires blocking review" -> blocking true, strength "hard".
  - strength: "hard" for a requirement, "preference" otherwise.
- escalation[]: handing a task from one agent to another.
  - id, fromAgent, toAgent.
  - afterFailures: positive integer count of failed attempts that triggers the hand-off.
  - confidenceBelow: 0..1 threshold; the hand-off triggers when confidence drops under it.`;
function systemPrompt2(knownAgents) {
  const agents = knownAgents.length === 0 ? "(none declared)" : knownAgents.join(", ");
  return `You are the policy compiler for a multi-agent coding runtime. The user gives you an orchestration policy written in natural language (the contents of .agent/orchestration.md). Convert it into the structured policy IR exactly as written \u2014 you are a translator, not an author.

Rules:
- Call the ${EMIT_POLICY_TOOL_NAME} tool exactly once. Never answer with prose.
- Known agent names are: ${agents}. Never invent an agent that is not in this list; if the policy names something else, leave it out of the IR and record it under ambiguities.
- Transcribe only what the source says. Do not add rules the source does not state, and do not drop rules it does state.
- Any rule you cannot map cleanly onto the IR goes in ambiguities: quote the source phrase and say why it does not fit.
- Any judgement call or lossy simplification you did make goes in warnings.
- version is always 1.
- Omit optional fields rather than guessing; omitted fields fall back to documented defaults.

${IR_REFERENCE}`;
}
var PolicyCompileError = class extends Error {
  attempts;
  lastIssues;
  constructor(init) {
    super(init.message);
    this.name = "PolicyCompileError";
    this.attempts = init.attempts;
    this.lastIssues = init.lastIssues;
  }
};
function toIssues2(error) {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message
  }));
}
function formatIssues2(issues) {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
}
var LlmPolicyCompiler = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  async compile(markdown, signal) {
    const maxAttempts = Math.max(1, this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS2);
    const messages = [
      { role: "system", content: systemPrompt2(this.#options.knownAgents) },
      {
        role: "user",
        content: `Compile this orchestration policy:

${markdown}`
      }
    ];
    let lastIssues;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const { call, text: text2 } = await this.#runAttempt(messages, signal);
      signal?.throwIfAborted();
      if (call === void 0) {
        lastIssues = [
          {
            path: "(root)",
            message: `no ${EMIT_POLICY_TOOL_NAME} tool call in the response`
          }
        ];
        if (attempt === maxAttempts)
          break;
        messages.push({ role: "assistant", content: text2 });
        messages.push({
          role: "user",
          content: `You did not call ${EMIT_POLICY_TOOL_NAME}. Reply with exactly one ${EMIT_POLICY_TOOL_NAME} tool call carrying the compiled policy, and no prose.`
        });
        continue;
      }
      const parsed = CompilerOutputSchema.safeParse(call.input);
      if (parsed.success) {
        const policy = PolicySchema.parse(parsed.data.policy);
        return {
          policy,
          warnings: parsed.data.warnings,
          ambiguities: parsed.data.ambiguities
        };
      }
      lastIssues = toIssues2(parsed.error);
      if (attempt === maxAttempts)
        break;
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: call.id, name: EMIT_POLICY_TOOL_NAME, input: call.input }
        ]
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `That ${EMIT_POLICY_TOOL_NAME} call did not match the policy schema:
${formatIssues2(lastIssues)}

Call ${EMIT_POLICY_TOOL_NAME} again with a corrected policy that fixes every issue above. Do not reply with prose.`
      });
    }
    throw new PolicyCompileError({
      message: `Failed to compile the orchestration policy after ${maxAttempts} attempt(s).${lastIssues === void 0 ? "" : `
${formatIssues2(lastIssues)}`}`,
      attempts: maxAttempts,
      ...lastIssues === void 0 ? {} : { lastIssues }
    });
  }
  async #runAttempt(messages, signal) {
    const { maxOutputTokens } = this.#options;
    const request = {
      model: this.#options.model,
      messages: [...messages],
      tools: [emitPolicyTool],
      toolChoice: { type: "tool", name: EMIT_POLICY_TOOL_NAME },
      ...maxOutputTokens === void 0 ? {} : { maxOutputTokens }
    };
    let call;
    let text2 = "";
    for await (const event2 of this.#options.provider.stream(request, signal)) {
      if (event2.type === "text.delta") {
        text2 += event2.text;
        continue;
      }
      if (event2.type === "tool.call" && event2.name === EMIT_POLICY_TOOL_NAME && call === void 0) {
        call = { id: event2.id, input: event2.input };
      }
    }
    return { call, text: text2 };
  }
};

// packages/policy/dist/explain.js
function joinList(values) {
  if (values.length <= 1)
    return values[0] ?? "";
  const head = values.slice(0, -1).join(", ");
  return `${head} and ${values[values.length - 1] ?? ""}`;
}
function matchClause(rule) {
  const parts = [];
  const taskTypes = rule.taskTypes ?? [];
  const riskCategories = rule.riskCategories ?? [];
  const complexity = rule.complexity ?? [];
  if (taskTypes.length > 0)
    parts.push(`${joinList(taskTypes)} tasks`);
  else
    parts.push("tasks");
  if (riskCategories.length > 0) {
    parts.push(`touching ${joinList(riskCategories)}`);
  }
  if (complexity.length > 0) {
    parts.push(`of ${joinList(complexity)} complexity`);
  }
  return parts.join(" ");
}
function describeRouting(rule) {
  const verb = rule.strength === "hard" ? "always route" : "prefer to route";
  const weight = rule.weight === 1 ? "" : ` [weight ${rule.weight}]`;
  return `- ${rule.id}: ${verb} ${matchClause(rule)} to ${rule.agent}${weight}`;
}
function describeReview(rule) {
  const blocking = rule.blocking ? "must pass before the work lands" : "is advisory";
  const strength = rule.strength === "hard" ? "required" : "preferred";
  const floor = rule.minimumComplexity === void 0 ? "" : ` at ${rule.minimumComplexity} complexity or above`;
  return `- ${rule.id}: ${rule.reviewer} reviews ${matchClause(rule)}${floor}; review ${blocking} (${strength})`;
}
function describeEscalation(rule) {
  const triggers = [];
  if (rule.afterFailures !== void 0) {
    triggers.push(`after ${rule.afterFailures} failed attempt${rule.afterFailures === 1 ? "" : "s"}`);
  }
  if (rule.confidenceBelow !== void 0) {
    triggers.push(`when confidence drops below ${rule.confidenceBelow}`);
  }
  const when = triggers.length === 0 ? "on request" : joinList(triggers);
  return `- ${rule.id}: hand off from ${rule.fromAgent} to ${rule.toAgent} ${when}`;
}
function section(title, rules, render2) {
  if (rules.length === 0)
    return [`${title}: none`];
  return [`${title} (${rules.length}):`, ...rules.map(render2)];
}
function describePolicy(policy) {
  const lines = [
    `Orchestrator: ${policy.orchestrator}`,
    `Concurrency: up to ${policy.maxConcurrency} agent${policy.maxConcurrency === 1 ? "" : "s"} at a time`,
    `Independent tasks: ${policy.parallelizeIndependentTasks ? "may run in parallel" : "run one at a time"}`,
    `Attempts per task: ${policy.defaultMaxAttempts} before giving up`,
    ...section("Routing rules", policy.routing, describeRouting),
    ...section("Review rules", policy.review, describeReview),
    ...section("Escalation rules", policy.escalation, describeEscalation)
  ];
  return lines.join("\n");
}

// packages/policy/dist/lockfile.js
import { createHash } from "node:crypto";
import { z as z4 } from "zod";
var LOCKFILE_VERSION = 1;
var LockfileSchema = z4.object({
  lockfileVersion: z4.literal(1),
  sourceHash: z4.string(),
  compiledAt: z4.number(),
  model: z4.string(),
  policy: PolicySchema,
  warnings: z4.array(z4.string()).default([]),
  ambiguities: z4.array(z4.string()).default([])
});
function normalizeSource(markdown) {
  return markdown.split(/\r\n|\r|\n/).map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
}
function hashPolicySource(markdown) {
  return createHash("sha256").update(normalizeSource(markdown), "utf8").digest("hex");
}
function createLockfile(input) {
  return {
    lockfileVersion: LOCKFILE_VERSION,
    sourceHash: hashPolicySource(input.markdown),
    compiledAt: input.now ?? Date.now(),
    model: input.model,
    policy: input.result.policy,
    warnings: [...input.result.warnings],
    ambiguities: [...input.result.ambiguities]
  };
}
function sortDeep(value) {
  if (Array.isArray(value))
    return value.map(sortDeep);
  if (typeof value !== "object" || value === null)
    return value;
  const entries = Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const sorted = {};
  for (const [key, item] of entries)
    sorted[key] = sortDeep(item);
  return sorted;
}
function serializeLockfile(lock) {
  return `${JSON.stringify(sortDeep(lock), null, 2)}
`;
}
function describeIssues(error) {
  return error.issues.map((issue) => {
    const path10 = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${path10}: ${issue.message}`;
  }).join("; ");
}
function parseLockfile(content) {
  let raw;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid orchestration lockfile: not valid JSON (${detail})`);
  }
  const parsed = LockfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid orchestration lockfile: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}
function checkLock(markdown, lockContent) {
  if (lockContent === void 0 || lockContent.trim() === "") {
    return { fresh: false, reason: "missing" };
  }
  let lock;
  try {
    lock = parseLockfile(lockContent);
  } catch (error) {
    return {
      fresh: false,
      reason: "invalid",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
  const expected = hashPolicySource(markdown);
  if (lock.sourceHash !== expected) {
    return {
      fresh: false,
      reason: "stale-source",
      detail: `policy source hash ${expected} does not match locked ${lock.sourceHash}`,
      lock
    };
  }
  return { fresh: true, lock };
}

// packages/policy/dist/index.js
function validatePolicy(policy, knownAgents) {
  const issues = [];
  const referenced = /* @__PURE__ */ new Set([policy.orchestrator]);
  for (const rule of policy.routing)
    referenced.add(rule.agent);
  for (const rule of policy.review)
    referenced.add(rule.reviewer);
  for (const rule of policy.escalation) {
    referenced.add(rule.fromAgent);
    referenced.add(rule.toAgent);
  }
  for (const agent of referenced) {
    if (!knownAgents.has(agent)) {
      issues.push({
        severity: "error",
        code: "UNKNOWN_AGENT",
        message: `Policy references unknown agent: ${agent}`
      });
    }
  }
  for (const rule of policy.escalation) {
    if (rule.fromAgent === rule.toAgent) {
      issues.push({
        severity: "error",
        code: "SELF_ESCALATION",
        message: `Escalation ${rule.id} points ${rule.fromAgent} to itself.`
      });
    }
  }
  return issues;
}

// packages/protocol/dist/index.js
import { z as z5 } from "zod";
var AgentEventSchema = z5.object({
  id: z5.string(),
  runId: z5.string(),
  timestamp: z5.number(),
  type: z5.string(),
  taskId: z5.string().optional(),
  workerId: z5.string().optional(),
  data: z5.unknown().optional()
});

// packages/coding-agent/dist/backends/codex.js
import { execFile as execFile2, spawn } from "node:child_process";

// packages/coding-agent/dist/platform/shell.js
import { execFile } from "node:child_process";
function shellInvocationFor(command, platform = process.platform) {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { command: "bash", args: ["-lc", command] };
}
function detachedSpawnOptions(platform = process.platform) {
  if (platform === "win32") {
    return { detached: false, windowsHide: true };
  }
  return { detached: true, windowsHide: true };
}
var defaultTaskkill = (pid) => {
  execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
  });
};
function killProcessTree(child, signal, platform = process.platform, taskkill = defaultTaskkill) {
  const pid = child.pid;
  if (pid === void 0)
    return;
  if (platform === "win32") {
    try {
      taskkill(pid);
    } catch {
      try {
        child.kill();
      } catch {
      }
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
    }
  }
}
function executableCandidates(binary, platform = process.platform) {
  if (platform !== "win32")
    return [binary];
  const base = binary.split(/[\\/]/).pop() ?? binary;
  if (base.includes("."))
    return [binary];
  return [binary, `${binary}.cmd`, `${binary}.exe`];
}

// packages/coding-agent/dist/backends/codex.js
var DEFAULT_BINARY = "codex";
var DEFAULT_SANDBOX = "workspace-write";
var KILL_GRACE_MS = 2e3;
var MAX_STDERR_CHARS = 5e4;
var MAX_RAW_LINES = 20;
var MAX_RAW_LINE_CHARS = 500;
var PROBE_TIMEOUT_MS = 5e3;
var PROBE_MAX_BUFFER = 512 * 1024;
var INSTALL_HINT = "Install the Codex CLI with `npm install -g @openai/codex`, then authenticate with `codex login`.";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value !== "")
      return value;
  }
  return void 0;
}
function toCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function extractMessageText(item) {
  const direct = firstString(item.text, item.message, item.content);
  if (direct !== void 0)
    return direct;
  const content = item.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string")
        parts.push(part);
      else if (isRecord(part) && typeof part.text === "string")
        parts.push(part.text);
    }
    const joined = parts.join("");
    if (joined !== "")
      return joined;
  }
  return void 0;
}
function buildPrompt(input) {
  const context = input.context ?? [];
  if (context.length === 0)
    return input.instruction;
  const blocks = context.map((entry, index2) => `<context index="${index2 + 1}">
${entry}
</context>`);
  return `${input.instruction}

<additional-context>
${blocks.join("\n")}
</additional-context>`;
}
function tail(text2, limit) {
  const trimmed = text2.trim();
  if (trimmed.length <= limit)
    return trimmed;
  return `...${trimmed.slice(trimmed.length - limit)}`;
}
function probeOnce(binaryPath, args) {
  return new Promise((resolve5) => {
    execFile2(binaryPath, [...args], { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER }, (error, stdout, stderr) => {
      const detail = `${String(stdout)}
${String(stderr)}`.trim();
      if (error === null) {
        resolve5({ ok: true, spawnFailed: false, detail });
        return;
      }
      const code = error.code;
      resolve5({
        ok: false,
        spawnFailed: typeof code === "string",
        detail: detail === "" ? error.message : detail
      });
    });
  });
}
async function probe(binaryPath, args) {
  const candidates = executableCandidates(binaryPath);
  let result = await probeOnce(candidates[0] ?? binaryPath, args);
  for (const candidate of candidates.slice(1)) {
    if (!result.spawnFailed)
      break;
    result = await probeOnce(candidate, args);
  }
  return result;
}
var CodexBackend = class {
  #options;
  constructor(options = {}) {
    this.#options = options;
  }
  async run(input, context) {
    const binary = this.#options.binaryPath ?? DEFAULT_BINARY;
    const timeoutMs = this.#options.timeoutMs;
    const args = this.#buildArgs(buildPrompt(input), context.workspacePath);
    const signals = [];
    if (context.signal !== void 0)
      signals.push(context.signal);
    const timeoutSignal = timeoutMs === void 0 ? void 0 : AbortSignal.timeout(timeoutMs);
    if (timeoutSignal !== void 0)
      signals.push(timeoutSignal);
    const signal = signals.length === 0 ? void 0 : AbortSignal.any(signals);
    const state = {
      lastAgentMessage: void 0,
      inputTokens: 0,
      outputTokens: 0,
      sawUsage: false,
      parsedEvents: 0,
      errors: [],
      rawLines: [],
      stderr: "",
      stderrTruncated: false
    };
    let queue = Promise.resolve();
    const emit2 = (type, data) => {
      const sink = this.#options.events;
      if (sink === void 0)
        return;
      const event2 = {
        id: crypto.randomUUID(),
        runId: context.runId,
        timestamp: Date.now(),
        type,
        ...context.taskId === void 0 ? {} : { taskId: context.taskId },
        data
      };
      queue = queue.then(async () => {
        try {
          await sink.emit(event2);
        } catch {
        }
      });
    };
    const finish = async (result) => {
      emit2("codex.completed", {
        status: result.status,
        exitCode: result.exitCode
      });
      await queue;
      return result;
    };
    const settle = (status, summary, exitCode2) => ({
      status,
      summary,
      ...state.lastAgentMessage === void 0 ? {} : { output: state.lastAgentMessage },
      exitCode: exitCode2,
      ...state.sawUsage ? {
        usage: {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens
        }
      } : {},
      events: state.parsedEvents
    });
    if (signal?.aborted === true) {
      return finish(settle("failed", "Codex run cancelled before it started.", null));
    }
    const candidates = executableCandidates(binary);
    let spawnOutcome = await this.#spawnCodex(candidates[0] ?? binary, args, context.workspacePath, signal, timeoutSignal, state, emit2);
    for (const candidate of candidates.slice(1)) {
      if (spawnOutcome.kind !== "spawn-error" || spawnOutcome.error.code !== "ENOENT") {
        break;
      }
      spawnOutcome = await this.#spawnCodex(candidate, args, context.workspacePath, signal, timeoutSignal, state, emit2);
    }
    if (spawnOutcome.kind === "spawn-error") {
      const error = spawnOutcome.error;
      const enoent = error.code === "ENOENT";
      const summary = enoent ? `Codex CLI not found (tried to run "${binary}"). ${INSTALL_HINT}` : `Failed to start the Codex CLI ("${binary}"): ${error.message}`;
      return finish(settle("failed", summary, null));
    }
    const { exitCode } = spawnOutcome;
    if (spawnOutcome.timedOut) {
      return finish(settle("failed", `Codex run timed out after ${String(timeoutMs)}ms and the process was terminated.`, exitCode));
    }
    if (spawnOutcome.aborted) {
      return finish(settle("failed", "Codex run cancelled; the process was terminated.", exitCode));
    }
    if (exitCode === 0) {
      const message = state.lastAgentMessage;
      return finish(settle("success", message ?? "Codex completed with no final message.", exitCode));
    }
    const reason = failureReason(state);
    return finish(settle("failed", `Codex exited with code ${String(exitCode)}: ${reason}`, exitCode));
  }
  #buildArgs(prompt, workspacePath) {
    const sandbox = this.#options.sandbox ?? DEFAULT_SANDBOX;
    const fullAuto = this.#options.fullAuto ?? true;
    const args = ["exec", "--json", "--cd", workspacePath];
    if (sandbox === "workspace-write" && fullAuto)
      args.push("--full-auto");
    else
      args.push("--sandbox", sandbox);
    const model = this.#options.model;
    if (model !== void 0)
      args.push("-m", model);
    const extra = this.#options.extraArgs;
    if (extra !== void 0)
      args.push(...extra);
    args.push(prompt);
    return args;
  }
  #spawnCodex(binary, args, workspacePath, signal, timeoutSignal, state, emit2) {
    return new Promise((resolve5) => {
      const child = spawn(binary, [...args], {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOptions()
      });
      let settled = false;
      let aborted = false;
      let killTimer;
      const killGroup = (sig) => {
        killProcessTree(child, sig);
      };
      const onAbort = () => {
        aborted = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        if (killTimer !== void 0)
          clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      let pending = "";
      const consumeLine = (line) => {
        const trimmed = line.replace(/\r$/, "");
        if (trimmed.trim() === "")
          return;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          state.rawLines.push(trimmed.slice(0, MAX_RAW_LINE_CHARS));
          if (state.rawLines.length > MAX_RAW_LINES)
            state.rawLines.shift();
          return;
        }
        if (!isRecord(parsed)) {
          state.rawLines.push(trimmed.slice(0, MAX_RAW_LINE_CHARS));
          if (state.rawLines.length > MAX_RAW_LINES)
            state.rawLines.shift();
          return;
        }
        state.parsedEvents += 1;
        applyEvent(parsed, state, emit2);
      };
      child.stdout?.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        let index2 = pending.indexOf("\n");
        while (index2 !== -1) {
          consumeLine(pending.slice(0, index2));
          pending = pending.slice(index2 + 1);
          index2 = pending.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk) => {
        if (state.stderrTruncated)
          return;
        state.stderr += chunk.toString("utf8");
        if (state.stderr.length > MAX_STDERR_CHARS) {
          state.stderr = state.stderr.slice(0, MAX_STDERR_CHARS);
          state.stderrTruncated = true;
        }
      });
      child.on("error", (error) => {
        if (settled)
          return;
        settled = true;
        cleanup();
        resolve5({ kind: "spawn-error", error });
      });
      child.on("close", (code) => {
        if (settled)
          return;
        settled = true;
        cleanup();
        if (pending !== "")
          consumeLine(pending);
        resolve5({
          kind: "exit",
          exitCode: code,
          aborted,
          timedOut: aborted && timeoutSignal?.aborted === true
        });
      });
    });
  }
  /**
   * Reports whether the Codex CLI is installed and whether the user has
   * completed `codex login`. Never throws: failures are encoded in `detail`.
   */
  static async checkAvailability(binaryPath) {
    const binary = binaryPath ?? DEFAULT_BINARY;
    const version = await probe(binary, ["--version"]);
    if (!version.ok) {
      const detail = version.spawnFailed ? `Could not run "${binary}". ${INSTALL_HINT}` : `\`${binary} --version\` failed: ${tail(version.detail, 500)}`;
      return { installed: false, loggedIn: false, detail };
    }
    const login = await probe(binary, ["login", "status"]);
    if (login.ok) {
      const detail = tail(`${version.detail}
${login.detail}`, 500);
      return {
        installed: true,
        loggedIn: true,
        ...detail === "" ? {} : { detail }
      };
    }
    const reason = login.detail === "" ? "" : ` (${tail(login.detail, 500)})`;
    return {
      installed: true,
      loggedIn: false,
      detail: `Codex CLI is installed but not logged in${reason}. Run \`codex login\` to authenticate with your ChatGPT account.`
    };
  }
};
function failureReason(state) {
  const reported = state.errors.at(-1);
  if (reported !== void 0)
    return reported;
  if (state.stderr.trim() !== "")
    return tail(state.stderr, 1e3);
  if (state.rawLines.length > 0)
    return state.rawLines.slice(-3).join("\n");
  return "no error details were reported";
}
function applyEvent(event2, state, emit2) {
  const source = isRecord(event2.msg) && typeof event2.msg.type === "string" ? event2.msg : event2;
  const kind = typeof source.type === "string" ? source.type : "unknown";
  emit2(`codex.${kind}`, event2);
  const item = isRecord(source.item) ? source.item : void 0;
  if (item !== void 0 && item.type === "agent_message") {
    const text2 = extractMessageText(item);
    if (text2 !== void 0)
      state.lastAgentMessage = text2;
  } else if (kind === "agent_message") {
    const text2 = extractMessageText(source);
    if (text2 !== void 0)
      state.lastAgentMessage = text2;
  }
  if (kind === "error") {
    state.errors.push(firstString(source.message, source.error, source.detail) ?? "Codex reported an error with no message");
  }
  const usage = isRecord(source.usage) ? source.usage : void 0;
  if (usage !== void 0) {
    const inputTokens = toCount(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = toCount(usage.output_tokens ?? usage.outputTokens);
    if (inputTokens !== 0 || outputTokens !== 0 || kind.startsWith("turn.")) {
      state.sawUsage = true;
      state.inputTokens += inputTokens;
      state.outputTokens += outputTokens;
    }
  }
}

// packages/coding-agent/dist/loop.js
var DEFAULT_MAX_ITERATIONS = 32;
var LoopAbortedError = class extends Error {
  constructor() {
    super("agent loop aborted");
    this.name = "LoopAbortedError";
  }
};
async function raceWithAbort(pending, signal) {
  if (signal.aborted) {
    pending.catch(() => void 0);
    throw new LoopAbortedError();
  }
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(new LoopAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort !== void 0)
      signal.removeEventListener("abort", onAbort);
  }
}
function serializeToolOutput(output) {
  if (typeof output === "string")
    return output;
  return JSON.stringify(output) ?? "";
}
function errorMessage(error) {
  if (error instanceof Error)
    return error.message;
  return String(error);
}
var ELISION_PREFIX = "[tool result elided during context compaction: ";
var DEFAULT_COMPACTION_MAX_MESSAGES = 60;
var DEFAULT_COMPACTION_PRESERVE_RECENT = 20;
var DEFAULT_COMPACTION_MIN_CONTENT_CHARS = 400;
function elisionMarker(originalLength) {
  return `${ELISION_PREFIX}${originalLength} chars]`;
}
function buildUserContent(input) {
  const context = input.context ?? [];
  if (context.length === 0)
    return input.instruction;
  const blocks = context.map((entry, index2) => `<context index="${index2 + 1}">
${entry}
</context>`);
  return `${input.instruction}

<additional-context>
${blocks.join("\n")}
</additional-context>`;
}
var AgentLoop = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  async run(input, context) {
    const { agent, tools } = this.#options;
    const maxIterations = this.#options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const timeoutMs = this.#options.timeoutMs;
    const signals = [];
    if (context.signal !== void 0)
      signals.push(context.signal);
    const timeoutSignal = timeoutMs === void 0 ? void 0 : AbortSignal.timeout(timeoutMs);
    if (timeoutSignal !== void 0)
      signals.push(timeoutSignal);
    const signal = signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals);
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    const definitions = tools.map((tool) => tool.definition());
    const toolContext = {
      runId: context.runId,
      workspacePath: context.workspacePath,
      signal,
      ...context.taskId === void 0 ? {} : { taskId: context.taskId }
    };
    const messages = [
      { role: "system", content: agent.systemPrompt },
      { role: "user", content: buildUserContent(input) }
    ];
    let iterations = 0;
    let toolCalls = 0;
    let lastNonEmptyText = "";
    await this.#emit(context, "loop.started", {
      agent: agent.name,
      model: agent.model.id,
      maxIterations
    });
    try {
      while (iterations < maxIterations) {
        iterations += 1;
        await this.#compact(messages, context);
        const request = {
          model: agent.model,
          messages: [...messages],
          ...definitions.length === 0 ? {} : { tools: definitions },
          ...this.#options.temperature === void 0 ? {} : { temperature: this.#options.temperature },
          ...this.#options.maxOutputTokens === void 0 ? {} : { maxOutputTokens: this.#options.maxOutputTokens }
        };
        const turn = await this.#runTurn(request, signal);
        if (turn.text.trim() !== "")
          lastNonEmptyText = turn.text;
        messages.push({
          role: "assistant",
          content: turn.text,
          ...turn.calls.length === 0 ? {} : { toolCalls: turn.calls }
        });
        await this.#emit(context, "model.turn.completed", {
          ...turn.text === "" ? {} : { text: turn.text },
          toolCallCount: turn.calls.length,
          ...turn.finishReason === void 0 ? {} : { finishReason: turn.finishReason }
        });
        if (turn.calls.length === 0) {
          const output = turn.text === "" ? lastNonEmptyText : turn.text;
          return await this.#complete(context, {
            status: "success",
            summary: output,
            output,
            iterations,
            toolCalls
          });
        }
        for (const call of turn.calls) {
          toolCalls += 1;
          messages.push(await this.#executeCall(call, toolsByName, toolContext, context, signal));
        }
      }
      return await this.#complete(context, {
        status: "partial",
        summary: `Stopped after the iteration budget of ${maxIterations} was exhausted while the model was still requesting tool calls.`,
        ...lastNonEmptyText === "" ? {} : { output: lastNonEmptyText },
        iterations,
        toolCalls
      });
    } catch (error) {
      if (error instanceof LoopAbortedError || signal.aborted) {
        const timedOut = timeoutSignal?.aborted === true || signal.reason instanceof Error && signal.reason.name === "TimeoutError";
        const summary = timedOut ? `Run timed out after ${String(timeoutMs)}ms.` : "Run cancelled before completion.";
        return await this.#complete(context, {
          status: "failed",
          summary,
          ...lastNonEmptyText === "" ? {} : { output: lastNonEmptyText },
          iterations,
          toolCalls
        });
      }
      return await this.#complete(context, {
        status: "failed",
        summary: `Model request failed: ${errorMessage(error)}`,
        ...lastNonEmptyText === "" ? {} : { output: lastNonEmptyText },
        iterations,
        toolCalls
      });
    }
  }
  async #runTurn(request, signal) {
    const stream = this.#options.provider.stream(request, signal);
    const iterator = stream[Symbol.asyncIterator]();
    let text2 = "";
    let finishReason;
    const calls = [];
    try {
      for (; ; ) {
        const next = await raceWithAbort(iterator.next(), signal);
        if (next.done === true)
          break;
        const event2 = next.value;
        switch (event2.type) {
          case "text.delta":
            text2 += event2.text;
            break;
          case "tool.call":
            calls.push({ id: event2.id, name: event2.name, input: event2.input });
            break;
          case "usage":
            this.#recordUsage(event2);
            break;
          case "done":
            finishReason = event2.finishReason;
            break;
        }
      }
    } catch (error) {
      void Promise.resolve(iterator.return?.()).catch(() => void 0);
      throw error;
    }
    return { text: text2, calls, finishReason };
  }
  #recordUsage(event2) {
    const recorder = this.#options.usage;
    if (recorder === void 0)
      return;
    const usage = {
      inputTokens: event2.inputTokens,
      outputTokens: event2.outputTokens,
      ...event2.cachedInputTokens === void 0 ? {} : { cachedInputTokens: event2.cachedInputTokens }
    };
    recorder.record(this.#options.agent.model, usage);
  }
  /**
   * Deterministic context compaction, run at the start of every iteration
   * before the request is built. No-op unless `compaction` was supplied.
   *
   * Walks `messages` from the beginning, skipping the system message, the
   * first user message, the last `preserveRecent` messages, and any tool
   * message already elided (its content already carries the elision
   * marker, which also keeps re-running this pass a no-op — but we still
   * skip on sight so the scan stays cheap). Assistant and user/system
   * messages are never touched: providers need the tool-call structure
   * intact, and the instruction must stay legible.
   */
  async #compact(messages, context) {
    const options = this.#options.compaction;
    if (options === void 0)
      return;
    const maxMessages = options.maxMessages ?? DEFAULT_COMPACTION_MAX_MESSAGES;
    if (messages.length <= maxMessages)
      return;
    const preserveRecent = options.preserveRecent ?? DEFAULT_COMPACTION_PRESERVE_RECENT;
    const minContentChars = options.minContentChars ?? DEFAULT_COMPACTION_MIN_CONTENT_CHARS;
    const systemIndex = messages.findIndex((m) => m.role === "system");
    const firstUserIndex = messages.findIndex((m) => m.role === "user");
    const preserveFrom = Math.max(0, messages.length - preserveRecent);
    let elided = 0;
    let savedChars = 0;
    for (let i = 0; i < preserveFrom; i += 1) {
      if (i === systemIndex || i === firstUserIndex)
        continue;
      const message = messages[i];
      if (message === void 0)
        continue;
      if (message.role !== "tool")
        continue;
      if (message.content.startsWith(ELISION_PREFIX))
        continue;
      if (message.content.length <= minContentChars)
        continue;
      const originalLength = message.content.length;
      const elidedContent = elisionMarker(originalLength);
      messages[i] = { ...message, content: elidedContent };
      elided += 1;
      savedChars += originalLength - elidedContent.length;
    }
    if (elided > 0) {
      await this.#emit(context, "context.compacted", {
        elided,
        savedChars,
        messages: messages.length
      });
    }
  }
  async #executeCall(call, toolsByName, toolContext, context, signal) {
    await this.#emit(context, "tool.execution.started", {
      tool: call.name,
      input: call.input
    });
    const tool = toolsByName.get(call.name);
    if (tool === void 0) {
      await this.#emit(context, "tool.execution.completed", {
        tool: call.name,
        ok: false
      });
      return {
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `Unknown tool: ${call.name}`
      };
    }
    const verdict = await this.#options.permissions.authorize({
      tool: call.name,
      input: call.input,
      agent: this.#options.agent.name
    });
    if (!verdict.allowed) {
      const reason = verdict.reason ?? "denied by policy";
      await this.#emit(context, "tool.execution.completed", {
        tool: call.name,
        ok: false,
        denied: true
      });
      return {
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `Tool "${call.name}" was not permitted: ${reason}`
      };
    }
    try {
      const output = await raceWithAbort(Promise.resolve(tool.execute(call.input, toolContext)), signal);
      await this.#emit(context, "tool.execution.completed", {
        tool: call.name,
        ok: true
      });
      return {
        role: "tool",
        toolCallId: call.id,
        content: serializeToolOutput(output)
      };
    } catch (error) {
      if (error instanceof LoopAbortedError)
        throw error;
      await this.#emit(context, "tool.execution.completed", {
        tool: call.name,
        ok: false
      });
      return {
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `Tool "${call.name}" failed: ${errorMessage(error)}`
      };
    }
  }
  async #complete(context, result) {
    await this.#emit(context, "loop.completed", {
      status: result.status,
      iterations: result.iterations,
      toolCalls: result.toolCalls
    });
    return result;
  }
  async #emit(context, type, data) {
    const sink = this.#options.events;
    if (sink === void 0)
      return;
    const event2 = {
      id: crypto.randomUUID(),
      runId: context.runId,
      timestamp: Date.now(),
      type,
      ...context.taskId === void 0 ? {} : { taskId: context.taskId },
      data
    };
    try {
      await sink.emit(event2);
    } catch {
    }
  }
};

// packages/coding-agent/dist/permissions.js
var DENIED_BY_POLICY = "denied by policy";
var NO_PROMPTER_AVAILABLE = "no prompter available in non-interactive mode";
var DENIED_BY_PROMPTER = "denied by prompter";
var PermissionEngine = class {
  #rules;
  #defaultDecision;
  #prompter;
  constructor(rules, options = {}) {
    this.#rules = { ...rules };
    this.#defaultDecision = options.defaultDecision ?? "ask";
    this.#prompter = options.prompter;
  }
  decisionFor(tool) {
    if (!Object.hasOwn(this.#rules, tool))
      return this.#defaultDecision;
    return this.#rules[tool] ?? this.#defaultDecision;
  }
  async authorize(request) {
    const decision = this.decisionFor(request.tool);
    if (decision === "allow")
      return { allowed: true, decision };
    if (decision === "deny")
      return { allowed: false, decision, reason: DENIED_BY_POLICY };
    const prompter = this.#prompter;
    if (prompter === void 0) {
      return { allowed: false, decision, reason: NO_PROMPTER_AVAILABLE };
    }
    const approved = await prompter.ask(request);
    return approved ? { allowed: true, decision } : { allowed: false, decision, reason: DENIED_BY_PROMPTER };
  }
};

// packages/coding-agent/dist/project/index.js
import { readFile as readFile4, stat } from "node:fs/promises";
import { join as join3 } from "node:path";

// packages/coding-agent/dist/project/agents.js
import { readdir, readFile as readFile2 } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z as z6 } from "zod";

// packages/coding-agent/dist/project/internal.js
function isNotFound(err) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
function formatZodIssues(error) {
  return error.issues.map((issue) => {
    const path10 = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path10}: ${issue.message}`;
  });
}

// packages/coding-agent/dist/project/agents.js
var AGENT_ROLES = /* @__PURE__ */ new Set([
  "orchestrator",
  "worker",
  "reviewer"
]);
var AgentFrontMatterSchema = z6.object({
  name: z6.string().min(1, "must not be empty"),
  model: z6.string().min(1, "must not be empty"),
  role: z6.string().min(1, "must not be empty"),
  tools: z6.array(z6.string()).default([])
}).strict();
function splitFrontMatter(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---")
    return void 0;
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1)
    return void 0;
  return {
    frontMatter: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n")
  };
}
function parseAgentFile(filePath, raw) {
  const stem = basename(filePath, extname(filePath));
  const split = splitFrontMatter(raw);
  if (!split) {
    return {
      problems: [
        `${filePath}: missing YAML front matter (file must start with a "---" line and include a closing "---" line)`
      ]
    };
  }
  let frontMatterValue;
  try {
    frontMatterValue = parseYaml(split.frontMatter);
  } catch (err) {
    return {
      problems: [
        `${filePath}: front matter YAML parse error: ${err.message}`
      ]
    };
  }
  const result = AgentFrontMatterSchema.safeParse(frontMatterValue);
  if (!result.success) {
    return {
      problems: formatZodIssues(result.error).map((problem) => `${filePath}: ${problem}`)
    };
  }
  const { name, model, role, tools } = result.data;
  const problems = [];
  if (name !== stem) {
    problems.push(`${filePath}: front matter name "${name}" does not match filename "${stem}"`);
  }
  if (!AGENT_ROLES.has(role)) {
    problems.push(`${filePath}: unknown role "${role}" (expected one of orchestrator, worker, reviewer)`);
  }
  if (problems.length > 0)
    return { problems, name };
  return {
    problems: [],
    name,
    agent: {
      name,
      modelAlias: model,
      role,
      tools,
      systemPrompt: split.body.trim(),
      sourcePath: filePath
    }
  };
}
async function loadProjectAgents(agentDir) {
  const agentsDir = join(agentDir, "agents");
  let entryNames;
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    entryNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
  } catch (err) {
    if (isNotFound(err))
      return { agents: [], problems: [] };
    throw err;
  }
  const agents = [];
  const problems = [];
  const seenNames = /* @__PURE__ */ new Map();
  for (const entryName of entryNames) {
    const filePath = join(agentsDir, entryName);
    const raw = await readFile2(filePath, "utf8");
    const result = parseAgentFile(filePath, raw);
    problems.push(...result.problems);
    let isDuplicate = false;
    if (result.name !== void 0) {
      const existingPath = seenNames.get(result.name);
      if (existingPath !== void 0) {
        isDuplicate = true;
        problems.push(`${filePath}: duplicate agent name "${result.name}" (already defined in ${existingPath})`);
      } else {
        seenNames.set(result.name, filePath);
      }
    }
    if (result.agent && !isDuplicate)
      agents.push(result.agent);
  }
  return { agents, problems };
}

// packages/coding-agent/dist/project/config.js
import { readFile as readFile3 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { parse as parseYaml2 } from "yaml";
import { z as z7 } from "zod";

// packages/coding-agent/dist/project/types.js
var DEFAULT_VALIDATOR_TIMEOUT_SECONDS = 600;
var ProjectConfigError = class extends Error {
  file;
  problems;
  constructor(file, problems) {
    super(`invalid .agent configuration in ${file}:
${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ProjectConfigError";
    this.file = file;
    this.problems = problems;
  }
};

// packages/coding-agent/dist/project/config.js
var ModelRefSchema = z7.object({
  provider: z7.string().min(1, "must not be empty"),
  model: z7.string().min(1, "must not be empty")
}).strict();
var ValidatorSchema = z7.object({
  name: z7.string().min(1, "must not be empty"),
  command: z7.string().min(1, "must not be empty"),
  timeoutSeconds: z7.number().int().positive().optional()
}).strict();
var ConfigFileSchema = z7.object({
  models: z7.record(z7.string(), ModelRefSchema).optional(),
  agents: z7.record(z7.string(), z7.string().min(1, "must not be empty")).optional(),
  validation: z7.array(ValidatorSchema).optional()
}).strict();
var EMPTY_CONFIG = {
  models: {},
  agentSlots: {},
  validators: []
};
async function loadProjectConfig(agentDir) {
  const filePath = join2(agentDir, "config.yaml");
  let raw;
  try {
    raw = await readFile3(filePath, "utf8");
  } catch (err) {
    if (isNotFound(err))
      return EMPTY_CONFIG;
    throw err;
  }
  let parsed;
  try {
    parsed = parseYaml2(raw);
  } catch (err) {
    throw new ProjectConfigError(filePath, [
      `YAML parse error: ${err.message}`
    ]);
  }
  if (parsed === null || parsed === void 0)
    return EMPTY_CONFIG;
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProjectConfigError(filePath, formatZodIssues(result.error));
  }
  const models = {};
  for (const [alias, ref] of Object.entries(result.data.models ?? {})) {
    models[alias] = { provider: ref.provider, model: ref.model };
  }
  const validators = (result.data.validation ?? []).map((entry) => ({
    name: entry.name,
    command: entry.command,
    timeoutSeconds: entry.timeoutSeconds ?? DEFAULT_VALIDATOR_TIMEOUT_SECONDS
  }));
  return {
    models,
    agentSlots: { ...result.data.agents ?? {} },
    validators
  };
}

// packages/coding-agent/dist/project/index.js
async function findAgentDir(workspaceRoot) {
  const dir = join3(workspaceRoot, ".agent");
  try {
    const info = await stat(dir);
    return info.isDirectory() ? dir : void 0;
  } catch (err) {
    if (isNotFound(err))
      return void 0;
    throw err;
  }
}
async function readOrchestrationMarkdown(agentDir) {
  try {
    return await readFile4(join3(agentDir, "orchestration.md"), "utf8");
  } catch (err) {
    if (isNotFound(err))
      return void 0;
    throw err;
  }
}
var AgentProjectImpl = class {
  root;
  config;
  agents;
  orchestrationMarkdown;
  #byName;
  constructor(root, config, agents, orchestrationMarkdown) {
    this.root = root;
    this.config = config;
    this.agents = agents;
    this.orchestrationMarkdown = orchestrationMarkdown;
    this.#byName = new Map(agents.map((agent) => [agent.name, agent]));
  }
  knownAgentNames() {
    return new Set(this.#byName.keys());
  }
  agent(name) {
    return this.#byName.get(name);
  }
};
async function loadAgentProject(workspaceRoot) {
  const agentDir = await findAgentDir(workspaceRoot);
  if (!agentDir)
    return void 0;
  const config = await loadProjectConfig(agentDir);
  const { agents, problems: agentProblems } = await loadProjectAgents(agentDir);
  const orchestrationMarkdown = await readOrchestrationMarkdown(agentDir);
  const problems = [...agentProblems];
  const agentNames = new Set(agents.map((agent) => agent.name));
  const hasModels = Object.keys(config.models).length > 0;
  if (hasModels) {
    for (const agent of agents) {
      if (!(agent.modelAlias in config.models)) {
        problems.push(`${agent.sourcePath}: model alias "${agent.modelAlias}" is not defined in config.yaml models`);
      }
    }
  }
  for (const [slot, agentName] of Object.entries(config.agentSlots)) {
    if (!agentNames.has(agentName)) {
      problems.push(`config.yaml: agents.${slot} references unknown agent "${agentName}"`);
    }
  }
  if (problems.length > 0) {
    throw new ProjectConfigError(agentDir, problems);
  }
  return new AgentProjectImpl(agentDir, config, agents, orchestrationMarkdown);
}

// packages/coding-agent/dist/tools/bash.js
import { spawn as spawn2 } from "node:child_process";
import { z as z9 } from "zod";

// packages/coding-agent/dist/tools/json-schema.js
import { z as z8 } from "zod";
function toInputSchema(schema) {
  const jsonSchema = z8.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

// packages/coding-agent/dist/tools/bash.js
var DEFAULT_TIMEOUT_MS = 12e4;
var MAX_TIMEOUT_MS = 6e5;
var MAX_OUTPUT_CHARS = 1e5;
var KILL_GRACE_MS2 = 2e3;
var InputSchema = z9.object({
  command: z9.string().min(1).describe("Shell command to run in the workspace (bash -lc on POSIX, cmd.exe /c on Windows)."),
  timeoutMs: z9.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe("Maximum time to allow the command to run, in milliseconds. Defaults to 120000, max 600000.")
}).strict();
function capText(text2) {
  if (text2.length <= MAX_OUTPUT_CHARS)
    return text2;
  return `${text2.slice(0, MAX_OUTPUT_CHARS)}
...[truncated, ${text2.length - MAX_OUTPUT_CHARS} more characters]`;
}
var BashTool = class {
  name = "bash";
  description = "Runs a shell command in the workspace directory through the platform shell (bash -lc on POSIX, cmd.exe on Windows) and returns its stdout, stderr, and exit code. On Windows, cmd syntax applies: && and || work, but export, backticks, and $(...) do not. Has a timeout (default 120s, max 600s) and is cancellable via the run's abort signal; stdout/stderr are each capped at 100,000 characters.";
  inputSchema = toInputSchema(InputSchema);
  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
  async execute(rawInput, context) {
    const input = InputSchema.parse(rawInput);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("aborted");
    }
    return new Promise((resolvePromise, reject) => {
      const shell = shellInvocationFor(input.command);
      const child = spawn2(shell.command, [...shell.args], {
        cwd: context.workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOptions()
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const killGroup = (signal) => {
        killProcessTree(child, signal);
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS2).unref();
      }, timeoutMs);
      timeoutTimer.unref();
      const onAbort = () => {
        aborted = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS2).unref();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        context.signal.removeEventListener("abort", onAbort);
      };
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled)
          return;
        settled = true;
        cleanup();
        reject(err);
      });
      child.on("close", (code) => {
        if (settled)
          return;
        settled = true;
        cleanup();
        if (aborted && !timedOut) {
          reject(context.signal.reason ?? new Error("aborted"));
          return;
        }
        resolvePromise({
          stdout: capText(stdout),
          stderr: capText(stderr),
          exitCode: code ?? -1,
          timedOut
        });
      });
    });
  }
};

// packages/coding-agent/dist/tools/edit-file.js
import { readFile as readFile5, writeFile } from "node:fs/promises";
import { z as z10 } from "zod";

// packages/coding-agent/dist/tools/paths.js
import { isAbsolute, relative, resolve, sep } from "node:path";
function resolveInWorkspace(workspacePath, userPath) {
  const resolved = resolve(workspacePath, userPath);
  const rel = relative(workspacePath, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new Error(`path escapes workspace: ${userPath}`);
  }
  return resolved;
}
function toWorkspaceRelative(workspacePath, absolutePath) {
  const rel = relative(workspacePath, absolutePath);
  return rel.split(sep).join("/");
}
function checkAbort(signal) {
  if (signal.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
}

// packages/coding-agent/dist/tools/edit-file.js
var InputSchema2 = z10.object({
  path: z10.string().min(1).describe("Workspace-relative path of the file to edit."),
  oldText: z10.string().min(1).describe("Exact, non-empty text to find in the file."),
  newText: z10.string().describe("Text to replace `oldText` with. Must differ from oldText."),
  replaceAll: z10.boolean().optional().describe("If true, replace every occurrence of oldText. If false/omitted, oldText must occur exactly once in the file.")
}).strict();
var EditFileTool = class {
  name = "edit_file";
  description = "Performs an exact text replacement within a workspace file. `oldText` must match exactly and, unless `replaceAll` is set, must occur exactly once in the file; otherwise the tool throws an error describing how many occurrences were found.";
  inputSchema = toInputSchema(InputSchema2);
  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
  async execute(rawInput, context) {
    const input = InputSchema2.parse(rawInput);
    if (input.oldText === input.newText) {
      throw new Error("oldText and newText must differ");
    }
    const target = resolveInWorkspace(context.workspacePath, input.path);
    checkAbort(context.signal);
    let raw;
    try {
      raw = await readFile5(target, "utf8");
    } catch (err) {
      throw new Error(`failed to read file "${input.path}": ${err.message}`);
    }
    const occurrences = raw.split(input.oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`oldText not found in "${input.path}"`);
    }
    if (!input.replaceAll && occurrences > 1) {
      throw new Error(`oldText occurs ${occurrences} times in "${input.path}"; pass replaceAll: true to replace all occurrences, or provide more surrounding context to make oldText unique`);
    }
    const replacements = input.replaceAll ? occurrences : 1;
    const newContent = input.replaceAll ? raw.split(input.oldText).join(input.newText) : raw.replace(input.oldText, input.newText);
    checkAbort(context.signal);
    await writeFile(target, newContent, "utf8");
    return { path: input.path, replacements };
  }
};

// packages/coding-agent/dist/tools/git-diff.js
import { execFile as execFile3 } from "node:child_process";
import { promisify } from "node:util";
import { z as z11 } from "zod";
var execFileAsync = promisify(execFile3);
var MAX_DIFF_CHARS = 2e5;
var MAX_BUFFER_BYTES = 10 * 1024 * 1024;
var InputSchema3 = z11.object({
  staged: z11.boolean().optional().describe("If true, diff the staged (index) changes via `git diff --cached`."),
  path: z11.string().optional().describe("Optional workspace-relative path to restrict the diff to.")
}).strict();
var GitDiffTool = class {
  name = "git_diff";
  description = "Runs `git diff` in the workspace and returns the unified diff text. Set `staged` to diff the index (`--cached`) instead of the working tree, and `path` (workspace-relative) to restrict the diff to one file or directory. Output is capped at 200,000 characters.";
  inputSchema = toInputSchema(InputSchema3);
  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
  async execute(rawInput, context) {
    const input = InputSchema3.parse(rawInput);
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("aborted");
    }
    const args = ["diff"];
    if (input.staged)
      args.push("--cached");
    if (input.path !== void 0) {
      resolveInWorkspace(context.workspacePath, input.path);
      args.push("--", input.path);
    }
    let stdout;
    try {
      const result = await execFileAsync("git", args, {
        cwd: context.workspacePath,
        signal: context.signal,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES
      });
      stdout = result.stdout;
    } catch (err) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("aborted");
      }
      throw new Error(`git diff failed: ${err.message}`);
    }
    let diff = stdout;
    let truncated = false;
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS);
      truncated = true;
    }
    return { diff, truncated };
  }
};

// packages/coding-agent/dist/tools/glob.js
import { readdir as readdir2 } from "node:fs/promises";
import { join as join4 } from "node:path";
import { z as z12 } from "zod";

// packages/coding-agent/dist/tools/glob-pattern.js
var REGEXP_SPECIAL = /* @__PURE__ */ new Set([
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\"
]);
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (REGEXP_SPECIAL.has(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

// packages/coding-agent/dist/tools/glob.js
var MAX_MATCHES = 2e3;
var SKIPPED_DIR_NAMES = /* @__PURE__ */ new Set(["node_modules", ".git"]);
var InputSchema4 = z12.object({
  pattern: z12.string().min(1).describe("Glob pattern to match, e.g. `src/**/*.ts`. Supports `*`, `**`, and `?`."),
  cwd: z12.string().optional().describe("Workspace-relative directory to search from. Defaults to the workspace root.")
}).strict();
function isPathExcluded(name) {
  return name.split("/").some((segment) => SKIPPED_DIR_NAMES.has(segment));
}
async function globViaNodeApi(glob, pattern, absoluteCwd, signal) {
  const results = [];
  for await (const match of glob(pattern, {
    cwd: absoluteCwd,
    exclude: isPathExcluded
  })) {
    checkAbort(signal);
    if (isPathExcluded(match))
      continue;
    results.push(match);
    if (results.length >= MAX_MATCHES)
      break;
  }
  return results;
}
async function safeReaddir(dir) {
  try {
    return await readdir2(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
async function walk(dir, signal, out) {
  checkAbort(signal);
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    if (SKIPPED_DIR_NAMES.has(entry.name))
      continue;
    const full = join4(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, signal, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}
async function globViaManualWalk(pattern, absoluteCwd, signal) {
  const regex = globToRegExp(pattern);
  const allFiles = [];
  await walk(absoluteCwd, signal, allFiles);
  const matches2 = [];
  for (const absolute of allFiles) {
    checkAbort(signal);
    const relativePath = toWorkspaceRelative(absoluteCwd, absolute);
    if (regex.test(relativePath)) {
      matches2.push(relativePath);
      if (matches2.length >= MAX_MATCHES)
        break;
    }
  }
  return matches2;
}
var GlobTool = class {
  name = "glob";
  description = "Finds files in the workspace matching a glob pattern (supports `*`, `**`, `?`). Returns workspace-relative paths, sorted. `node_modules` and `.git` are always skipped. Results are capped at 2000 matches; `truncated` indicates if the cap was hit.";
  inputSchema = toInputSchema(InputSchema4);
  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
  async execute(rawInput, context) {
    const input = InputSchema4.parse(rawInput);
    const absoluteCwd = resolveInWorkspace(context.workspacePath, input.cwd ?? ".");
    checkAbort(context.signal);
    const fsPromises = await import("node:fs/promises");
    const globFn = fsPromises.glob;
    let matches2;
    if (typeof globFn === "function") {
      matches2 = await globViaNodeApi(globFn.bind(fsPromises), input.pattern, absoluteCwd, context.signal);
    } else {
      matches2 = await globViaManualWalk(input.pattern, absoluteCwd, context.signal);
    }
    const truncated = matches2.length >= MAX_MATCHES;
    const relativeToWorkspace = matches2.map((m) => toWorkspaceRelative(context.workspacePath, join4(absoluteCwd, m))).sort();
    return { matches: relativeToWorkspace, truncated };
  }
};

// packages/coding-agent/dist/tools/grep.js
import { readdir as readdir3, readFile as readFile6, stat as stat2 } from "node:fs/promises";
import { basename as basename2, join as join5 } from "node:path";
import { z as z13 } from "zod";
var DEFAULT_MAX_MATCHES = 200;
var MAX_LINE_CHARS = 500;
var BINARY_SNIFF_BYTES = 8e3;
var SKIPPED_DIR_NAMES2 = /* @__PURE__ */ new Set(["node_modules", ".git"]);
var InputSchema5 = z13.object({
  pattern: z13.string().min(1).describe("JavaScript regular expression source to search for."),
  path: z13.string().optional().describe("Workspace-relative file or directory to search. Defaults to the workspace root."),
  glob: z13.string().optional().describe("Optional glob (e.g. `**/*.ts`) to restrict which files are searched."),
  ignoreCase: z13.boolean().optional().describe("Case-insensitive matching."),
  maxMatches: z13.number().int().positive().optional().describe("Maximum number of matches to return. Defaults to 200.")
}).strict();
function looksBinary(buf) {
  const sniffLen = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0)
      return true;
  }
  return false;
}
var GrepTool = class {
  name = "grep";
  description = "Recursively searches text files in the workspace for lines matching a JavaScript regular expression. `path` scopes the search to a workspace-relative file or directory; `glob` further filters filenames (matched against the full relative path or just the basename, e.g. `*.ts` or `src/**/*.ts`). Skips `node_modules`, `.git`, and binary-looking files. Returns up to `maxMatches` (default 200) matches, each line capped at 500 characters.";
  inputSchema = toInputSchema(InputSchema5);
  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
  async execute(rawInput, context) {
    const input = InputSchema5.parse(rawInput);
    let regex;
    try {
      regex = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
    } catch (err) {
      throw new Error(`invalid regex pattern: ${err.message}`);
    }
    const root = resolveInWorkspace(context.workspacePath, input.path ?? ".");
    checkAbort(context.signal);
    const maxMatches = input.maxMatches ?? DEFAULT_MAX_MATCHES;
    const globRegex = input.glob !== void 0 ? globToRegExp(input.glob) : void 0;
    const matches2 = [];
    let truncated = false;
    const searchFile = async (absoluteFile) => {
      const relFromWorkspace = toWorkspaceRelative(context.workspacePath, absoluteFile);
      if (globRegex !== void 0) {
        const relFromRoot = toWorkspaceRelative(root, absoluteFile);
        const base = basename2(absoluteFile);
        const isMatch = globRegex.test(relFromRoot) || globRegex.test(relFromWorkspace) || globRegex.test(base);
        if (!isMatch)
          return;
      }
      let buf;
      try {
        buf = await readFile6(absoluteFile);
      } catch {
        return;
      }
      if (looksBinary(buf))
        return;
      const text2 = buf.toString("utf8");
      const lines = text2.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches2.length >= maxMatches) {
          truncated = true;
          return;
        }
        const line = lines[i];
        if (regex.test(line)) {
          const capped = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
          matches2.push({ file: relFromWorkspace, line: i + 1, text: capped });
        }
      }
    };
    const safeReaddir2 = async (dir) => {
      try {
        return await readdir3(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    const walk2 = async (dir) => {
      checkAbort(context.signal);
      if (matches2.length >= maxMatches) {
        truncated = true;
        return;
      }
      const entries = await safeReaddir2(dir);
      for (const entry of entries) {
        if (matches2.length >= maxMatches) {
          truncated = true;
          return;
        }
        checkAbort(context.signal);
        if (SKIPPED_DIR_NAMES2.has(entry.name))
          continue;
        const full = join5(dir, entry.name);
        if (entry.isDirectory()) {
          await walk2(full);
        } else if (entry.isFile()) {
          await searchFile(full);
        }
      }
    };
    const rootStat = await stat2(root);
    if (rootStat.isDirectory()) {
      await walk2(root);
    } else {
      await searchFile(root);
    }
    return { matches: matches2, truncated };
  }
};

// packages/coding-agent/dist/tools/read-file.js
import { readFile as readFile7 } from "node:fs/promises";
import { z as z14 } from "zod";
var MAX_CONTENT_CHARS = 2e5;
var InputSchema6 = z14.object({
  path: z14.string().min(1).describe("Workspace-relative path of the file to read."),
  offset: z14.number().int().positive().optional().describe("1-based line number to start reading from. Defaults to the first line."),
  limit: z14.number().int().positive().optional().describe("Maximum number of lines to return.")
}).strict();
var ReadFileTool = class {
  name = "read_file";
  description = "Reads a UTF-8 text file from the workspace. The path must be workspace-relative. Optionally supply a 1-based `offset` line and a `limit` on the number of lines returned. Content is capped at 200,000 characters; if the result is cut short, `truncated` is true.";
  inputSchema = toInputSchema(InputSchema6);
  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
  async execute(rawInput, context) {
    const input = InputSchema6.parse(rawInput);
    const target = resolveInWorkspace(context.workspacePath, input.path);
    checkAbort(context.signal);
    let raw;
    try {
      raw = await readFile7(target, "utf8");
    } catch (err) {
      throw new Error(`failed to read file "${input.path}": ${err.message}`);
    }
    checkAbort(context.signal);
    const lines = raw.length === 0 ? [] : raw.split("\n");
    if (lines.length > 0 && raw.endsWith("\n")) {
      lines.pop();
    }
    const totalLines = lines.length;
    const startIndex = input.offset !== void 0 ? Math.max(0, input.offset - 1) : 0;
    const endIndex = input.limit !== void 0 ? startIndex + input.limit : lines.length;
    const selected = lines.slice(startIndex, endIndex);
    let content = selected.join("\n");
    let truncated = false;
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS);
      truncated = true;
    }
    return { path: input.path, content, totalLines, truncated };
  }
};

// packages/coding-agent/dist/tools/write-file.js
import { mkdir, stat as stat3, writeFile as writeFile2 } from "node:fs/promises";
import { dirname } from "node:path";
import { z as z15 } from "zod";
var InputSchema7 = z15.object({
  path: z15.string().min(1).describe("Workspace-relative path of the file to write."),
  content: z15.string().describe("The full UTF-8 text content to write to the file.")
}).strict();
var WriteFileTool = class {
  name = "write_file";
  description = "Writes UTF-8 text content to a file in the workspace, overwriting it if it already exists. The path must be workspace-relative; parent directories are created automatically.";
  inputSchema = toInputSchema(InputSchema7);
  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
  async execute(rawInput, context) {
    const input = InputSchema7.parse(rawInput);
    const target = resolveInWorkspace(context.workspacePath, input.path);
    checkAbort(context.signal);
    let created = true;
    try {
      await stat3(target);
      created = false;
    } catch {
      created = true;
    }
    await mkdir(dirname(target), { recursive: true });
    checkAbort(context.signal);
    await writeFile2(target, input.content, "utf8");
    const bytesWritten = Buffer.byteLength(input.content, "utf8");
    return { path: input.path, bytesWritten, created };
  }
};

// packages/coding-agent/dist/tools/index.js
function builtinTools() {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new GlobTool(),
    new GrepTool(),
    new BashTool(),
    new GitDiffTool()
  ];
}

// packages/coding-agent/dist/validation/runner.js
import { spawn as spawn3 } from "node:child_process";
var MAX_VALIDATOR_OUTPUT_CHARS = 2e4;
var TRUNCATION_MARKER = "...[earlier output truncated]\n";
var KILL_GRACE_MS3 = 2e3;
function capTail(text2, alreadyDropped) {
  if (!alreadyDropped && text2.length <= MAX_VALIDATOR_OUTPUT_CHARS)
    return text2;
  const budget = MAX_VALIDATOR_OUTPUT_CHARS - TRUNCATION_MARKER.length;
  return `${TRUNCATION_MARKER}${text2.slice(Math.max(0, text2.length - budget))}`;
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function runOne(validator, workspacePath, signal) {
  const timeoutMs = (validator.timeoutSeconds ?? DEFAULT_VALIDATOR_TIMEOUT_SECONDS) * 1e3;
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    let output = "";
    let dropped = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (fields) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      resolvePromise({
        name: validator.name,
        command: validator.command,
        passed: fields.passed,
        exitCode: fields.exitCode,
        output: capTail(fields.extra === void 0 ? output : `${output}${fields.extra}`, dropped),
        durationMs: Date.now() - startedAt,
        timedOut
      });
    };
    if (signal?.aborted === true) {
      resolvePromise({
        name: validator.name,
        command: validator.command,
        passed: false,
        exitCode: null,
        output: "Validation was cancelled before this validator started.",
        durationMs: 0,
        timedOut: false
      });
      return;
    }
    let child;
    try {
      const shell = shellInvocationFor(validator.command);
      child = spawn3(shell.command, [...shell.args], {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOptions()
      });
    } catch (error) {
      resolvePromise({
        name: validator.name,
        command: validator.command,
        passed: false,
        exitCode: null,
        output: `Could not start the validator: ${errorMessage2(error)}`,
        durationMs: Date.now() - startedAt,
        timedOut: false
      });
      return;
    }
    const killGroup = (killSignal) => {
      killProcessTree(child, killSignal);
    };
    const killHard = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS3).unref();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killHard();
    }, timeoutMs);
    timeoutTimer.unref();
    const onAbort = () => {
      aborted = true;
      killHard();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    function cleanup() {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
    }
    const append = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_VALIDATOR_OUTPUT_CHARS * 2) {
        output = output.slice(output.length - MAX_VALIDATOR_OUTPUT_CHARS);
        dropped = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      finish({
        passed: false,
        exitCode: null,
        extra: `
Could not run the validator: ${errorMessage2(error)}`
      });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({
          passed: false,
          exitCode: code,
          extra: `
[validator "${validator.name}" timed out after ${timeoutMs}ms and was killed]`
        });
        return;
      }
      if (aborted) {
        finish({
          passed: false,
          exitCode: code,
          extra: `
[validator "${validator.name}" was cancelled]`
        });
        return;
      }
      finish({ passed: code === 0, exitCode: code });
    });
  });
}
async function runValidators(validators, workspacePath, opts) {
  const outcomes = [];
  for (const validator of validators) {
    if (opts?.signal?.aborted === true)
      break;
    await emit(opts, "validation.started", {
      name: validator.name,
      command: validator.command
    });
    const outcome = await runOne(validator, workspacePath, opts?.signal);
    outcomes.push(outcome);
    await emit(opts, "validation.completed", {
      name: outcome.name,
      passed: outcome.passed,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs
    });
  }
  return {
    // A run cut short by an abort has fewer outcomes than validators, and an
    // unrun validator is not a passing one.
    passed: outcomes.length === validators.length && outcomes.every((outcome) => outcome.passed),
    outcomes
  };
}
async function emit(opts, type, data) {
  const sink = opts?.events;
  if (sink === void 0)
    return;
  try {
    await sink.emit({
      id: crypto.randomUUID(),
      runId: opts?.runId ?? "",
      timestamp: Date.now(),
      type,
      ...opts?.taskId === void 0 ? {} : { taskId: opts.taskId },
      data
    });
  } catch {
  }
}

// packages/coding-agent/dist/validation/validating-executor.js
var MAX_ISSUE_OUTPUT_CHARS = 1e3;
var FAILED_VALIDATION_CONFIDENCE = 0.2;
function errorMessage3(error) {
  return error instanceof Error ? error.message : String(error);
}
function truncate(text2, limit) {
  const trimmed = text2.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\u2026`;
}
function describeFailure(outcome) {
  const how = outcome.timedOut ? "timed out" : `exit code ${outcome.exitCode === null ? "unknown" : String(outcome.exitCode)}`;
  const output = outcome.output.trim() === "" ? "(no output)" : truncate(outcome.output, MAX_ISSUE_OUTPUT_CHARS);
  return `Validator "${outcome.name}" failed (${how}) running \`${outcome.command}\`: ${output}`;
}
function withFailedValidation(result, report) {
  const failures = report.outcomes.filter((outcome) => !outcome.passed);
  return {
    ...result,
    status: "failed",
    tests: {
      passed: report.outcomes.length - failures.length,
      failed: failures.length,
      commands: report.outcomes.map((outcome) => outcome.command)
    },
    unresolvedIssues: [
      ...result.unresolvedIssues,
      ...failures.map(describeFailure)
    ],
    confidence: FAILED_VALIDATION_CONFIDENCE
  };
}
function withPassedValidation(result, report) {
  return {
    ...result,
    tests: {
      passed: report.outcomes.length,
      failed: 0,
      commands: report.outcomes.map((outcome) => outcome.command)
    }
  };
}
var ValidatingExecutor = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  async execute(task, agent, signal, context) {
    const result = await this.#options.inner.execute(task, agent, signal, context);
    if (result.status !== "success")
      return result;
    if (!MUTATING_TASK_TYPES.has(task.spec.type))
      return result;
    let report;
    try {
      report = await runValidators(this.#options.validators, this.#options.workspacePath, {
        ...signal === void 0 ? {} : { signal },
        ...this.#options.events === void 0 ? {} : { events: this.#options.events },
        ...this.#options.runId === void 0 ? {} : { runId: this.#options.runId },
        taskId: task.spec.id
      });
    } catch (error) {
      return {
        ...result,
        status: "failed",
        unresolvedIssues: [
          ...result.unresolvedIssues,
          `Validation could not be run: ${errorMessage3(error)}`
        ],
        confidence: FAILED_VALIDATION_CONFIDENCE
      };
    }
    return report.passed ? withPassedValidation(result, report) : withFailedValidation(result, report);
  }
};

// packages/coding-agent/dist/workers/review.js
import { z as z16 } from "zod";
var REVIEW_VERDICT_TOOL_NAME = "submit_review_verdict";
var REJECTED_CONFIDENCE = 0.9;
var NO_VERDICT_CONFIDENCE = 0.1;
var NO_VERDICT_SUMMARY = "review completed without submitting a verdict";
var IssueSchema = z16.object({
  severity: z16.enum(["blocking", "advisory"]).describe("`blocking` means the change must not ship as-is; `advisory` is a suggestion."),
  description: z16.string().min(1).describe("What is wrong, specific enough to act on.")
}).strict();
var InputSchema8 = z16.object({
  approved: z16.boolean().describe("true only when the change is acceptable as it stands. Any blocking issue means false."),
  summary: z16.string().min(1).describe("One short paragraph explaining the decision."),
  issues: z16.array(IssueSchema).default([]).describe("Every problem found, blocking ones first.")
}).strict();
var ReviewVerdictTool = class {
  name = REVIEW_VERDICT_TOOL_NAME;
  description = "Submits the review decision for this task. Call this exactly once, after inspecting the changes: `approved` is false whenever any blocking issue exists. A review that finishes without calling this tool is treated as a failure.";
  inputSchema = toInputSchema(InputSchema8);
  #verdict;
  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
  /** The last verdict submitted, or `undefined` when none ever was. */
  verdict() {
    return this.#verdict;
  }
  async execute(rawInput, _context) {
    const input = InputSchema8.parse(rawInput);
    this.#verdict = {
      approved: input.approved,
      summary: input.summary,
      issues: input.issues.map((issue) => ({
        severity: issue.severity,
        description: issue.description
      }))
    };
    return { recorded: true };
  }
};
function describeIssue(issue) {
  return `${issue.severity}: ${issue.description}`;
}
function applyReviewVerdict(base, verdict) {
  if (verdict === void 0) {
    return {
      ...base,
      status: "failed",
      summary: base.status === "failed" ? `${NO_VERDICT_SUMMARY}: ${base.summary}` : NO_VERDICT_SUMMARY,
      confidence: NO_VERDICT_CONFIDENCE
    };
  }
  if (!verdict.approved) {
    return {
      ...base,
      status: "failed",
      summary: `Review rejected: ${verdict.summary}`,
      unresolvedIssues: [
        ...base.unresolvedIssues,
        ...verdict.issues.map(describeIssue)
      ],
      confidence: REJECTED_CONFIDENCE
    };
  }
  const failedAnyway = base.status === "failed";
  return {
    ...base,
    status: failedAnyway ? "failed" : "success",
    // A failed loop keeps its own summary: "the run timed out" explains the
    // result, "looks good to me" does not.
    summary: failedAnyway ? base.summary : verdict.summary,
    unresolvedIssues: [
      ...base.unresolvedIssues,
      ...verdict.issues.map(describeIssue)
    ]
  };
}

// packages/coding-agent/dist/workers/briefing.js
var MAX_DEPENDENCY_SUMMARY_CHARS = 400;
var MAX_DEPENDENCY_FILES = 20;
function truncate2(text2, limit) {
  const trimmed = text2.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\u2026`;
}
function dependencySection(results) {
  const lines = ["", "## Results from dependency tasks", ""];
  for (const result of results) {
    lines.push(`### ${result.taskId} \u2014 ${result.status}`);
    lines.push(truncate2(result.summary, MAX_DEPENDENCY_SUMMARY_CHARS));
    if (result.changedFiles.length > 0) {
      lines.push("Changed files:");
      for (const file of result.changedFiles.slice(0, MAX_DEPENDENCY_FILES)) {
        lines.push(`  - ${file}`);
      }
      const extra = result.changedFiles.length - MAX_DEPENDENCY_FILES;
      if (extra > 0)
        lines.push(`  - ... and ${extra} more`);
    }
    lines.push("");
  }
  return lines;
}
function reviewSection() {
  return [
    "",
    "## Review task \u2014 a verdict is required",
    "",
    "You are reviewing work that other tasks produced, not writing code yourself.",
    "Inspect the results of the tasks you depend on and the files they changed:",
    "read those files, and use a diff against the base to see exactly what moved.",
    "",
    `You MUST call the \`${REVIEW_VERDICT_TOOL_NAME}\` tool exactly once before you finish:`,
    "  - `approved: true` only when the change is acceptable as it stands;",
    "  - `approved: false` whenever you found anything that must be fixed first;",
    "  - list every problem in `issues`, marking each `blocking` or `advisory`.",
    "",
    "A blocking issue means the verdict is not approved. Finishing without calling",
    `\`${REVIEW_VERDICT_TOOL_NAME}\` fails this task \u2014 an undecided review does not pass.`
  ];
}
function buildTaskBriefing(task, agent, context) {
  const lines = [
    `You are acting as the "${agent}" worker on task ${task.id}.`,
    "",
    `Title: ${task.title}`,
    `Goal: ${task.goal}`,
    `Type: ${task.type} (complexity: ${task.complexity})`
  ];
  if (task.affectedAreas.length > 0) {
    lines.push("Affected areas \u2014 touch only these areas:", ...task.affectedAreas.map((area) => `  - ${area}`));
  } else {
    lines.push("Affected areas: none were declared \u2014 keep the change as narrow as possible.");
  }
  lines.push(`Risk level: ${task.risk.level}`);
  if (task.risk.categories.length > 0) {
    lines.push(`Risk categories: ${task.risk.categories.join(", ")}`);
  }
  if (task.dependencies.length > 0) {
    lines.push(`Depends on completed tasks: ${task.dependencies.join(", ")}`);
  }
  lines.push("", "Work directly in the current workspace. Return a short summary of what you changed.");
  const dependencyResults = context?.dependencyResults ?? [];
  if (dependencyResults.length > 0) {
    lines.push(...dependencySection(dependencyResults));
  }
  if (task.type === "review") {
    lines.push(...reviewSection());
  }
  return lines.join("\n");
}
var WORKER_SYSTEM_POSTAMBLE = [
  "## Execution context",
  "",
  "You are running as a headless worker inside an automated orchestration run.",
  "No human is watching this session: never ask for confirmation and never wait",
  "for input. Make the smallest reasonable change that satisfies the task and",
  "stay inside the affected areas named in the task briefing. Tool calls outside",
  "your granted permissions are rejected automatically \u2014 treat a denial as a",
  "constraint to work around, not something to retry. Finish by replying with a",
  "short prose summary of what you changed."
].join("\n");
function buildWorkerSystemPrompt(systemPrompt3) {
  const base = systemPrompt3.trim();
  return base === "" ? WORKER_SYSTEM_POSTAMBLE : `${base}

${WORKER_SYSTEM_POSTAMBLE}`;
}

// packages/coding-agent/dist/workers/normalize.js
import { execFile as execFile4 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile4);
var MAX_BUFFER_BYTES2 = 10 * 1024 * 1024;
var CONFIDENCE = {
  success: 0.8,
  partial: 0.4,
  failed: 0.1
};
var EMPTY_INSPECTION = { changedFiles: [] };
function runGit(args, cwd, signal) {
  return execFileAsync2("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES2,
    ...signal === void 0 ? {} : { signal }
  }).then((result) => result.stdout).catch(() => void 0);
}
function parsePorcelain(stdout) {
  const records = stdout.split("\0");
  const paths = /* @__PURE__ */ new Set();
  for (let index2 = 0; index2 < records.length; index2 += 1) {
    const record = records[index2];
    if (record === void 0 || record.length < 4)
      continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const path10 = record.slice(3);
    if (path10 !== "")
      paths.add(path10);
    if (x === "R" || x === "C" || y === "R" || y === "C")
      index2 += 1;
  }
  return [...paths].sort();
}
async function inspectWorkspaceChanges(workspacePath, signal) {
  const status = await runGit(["status", "--porcelain=v1", "-z", "-uall"], workspacePath, signal);
  if (status === void 0)
    return EMPTY_INSPECTION;
  const changedFiles = parsePorcelain(status);
  const head = await runGit(["rev-parse", "HEAD"], workspacePath, signal);
  const commit = head?.trim();
  return {
    changedFiles,
    ...commit === void 0 || commit === "" ? {} : { commit }
  };
}
function pickSummary(loop) {
  if (loop.summary.trim() !== "")
    return loop.summary;
  const output = loop.output;
  if (output !== void 0 && output.trim() !== "")
    return output;
  return "The worker returned no summary.";
}
function normalizeTaskResult(input) {
  const { taskId, loop, inspection } = input;
  return {
    taskId,
    status: loop.status,
    summary: pickSummary(loop),
    decisions: [],
    changedFiles: inspection.changedFiles,
    ...inspection.commit === void 0 ? {} : { commit: inspection.commit },
    tests: { passed: 0, failed: 0, commands: [] },
    unresolvedIssues: [],
    confidence: CONFIDENCE[loop.status]
  };
}
function failedTaskResult(taskId, summary, inspection = EMPTY_INSPECTION) {
  return normalizeTaskResult({
    taskId,
    loop: { status: "failed", summary },
    inspection
  });
}

// packages/coding-agent/dist/workers/agent-loop-executor.js
var DEFAULT_WORKER_PERMISSIONS = {
  read_file: "allow",
  glob: "allow",
  grep: "allow",
  git_diff: "allow",
  write_file: "allow",
  edit_file: "allow",
  bash: "allow"
};
var TEMPLATE_TOOL_ALIASES = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file"
};
function canonicalize(name) {
  return name.toLowerCase().replaceAll("_", ".");
}
function selectToolsForAgent(tools, patterns) {
  if (patterns.length === 0)
    return tools;
  const exact = /* @__PURE__ */ new Set();
  const prefixes = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === "")
      continue;
    if (trimmed.endsWith(".*") || trimmed.endsWith("_*")) {
      prefixes.push(canonicalize(trimmed.slice(0, -2)));
      continue;
    }
    const aliased = TEMPLATE_TOOL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
    exact.add(canonicalize(aliased));
  }
  return tools.filter((tool) => {
    const name = canonicalize(tool.name);
    if (exact.has(name))
      return true;
    return prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}.`));
  });
}
function errorMessage4(error) {
  return error instanceof Error ? error.message : String(error);
}
var AgentLoopWorkerExecutor = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  async execute(task, agent, signal, context) {
    const taskId = task.spec.id;
    const { project, workspacePath, runId } = this.#options;
    const projectAgent = project.agent(agent);
    if (projectAgent === void 0) {
      const known = [...project.knownAgentNames()].sort().join(", ");
      return failedTaskResult(taskId, `Unknown agent ${agent}. Known agents: ${known === "" ? "(none)" : known}`);
    }
    let resolved;
    try {
      resolved = this.#options.resolveModel(projectAgent.modelAlias);
    } catch (error) {
      return failedTaskResult(taskId, `Could not resolve model alias "${projectAgent.modelAlias}" for agent ${agent}: ${errorMessage4(error)}`);
    }
    const configuredPermissions = this.#options.permissionOverrides ?? DEFAULT_WORKER_PERMISSIONS;
    const selected = selectToolsForAgent(builtinTools(), projectAgent.tools);
    const isReview = task.spec.type === "review";
    const verdictTool = isReview ? new ReviewVerdictTool() : void 0;
    const tools = verdictTool === void 0 ? selected : [...selected, verdictTool];
    const permissions = verdictTool === void 0 ? configuredPermissions : { ...configuredPermissions, [REVIEW_VERDICT_TOOL_NAME]: "allow" };
    const definition = {
      name: projectAgent.name,
      role: projectAgent.role,
      model: resolved.model,
      systemPrompt: buildWorkerSystemPrompt(projectAgent.systemPrompt),
      tools: tools.map((tool) => tool.name),
      permissions
    };
    const loop = new AgentLoop({
      agent: definition,
      provider: resolved.provider,
      tools,
      permissions: new PermissionEngine(permissions, {
        // Headless: no prompter is wired up on purpose, and anything not
        // explicitly allowed is denied instead of silently escalating.
        defaultDecision: "deny"
      }),
      ...this.#options.events === void 0 ? {} : { events: this.#options.events },
      ...this.#options.usage === void 0 ? {} : { usage: this.#options.usage },
      ...this.#options.maxIterations === void 0 ? {} : { maxIterations: this.#options.maxIterations },
      ...this.#options.taskTimeoutMs === void 0 ? {} : { timeoutMs: this.#options.taskTimeoutMs }
    });
    let run;
    try {
      run = await loop.run({ instruction: buildTaskBriefing(task.spec, agent, context) }, {
        runId,
        taskId,
        workspacePath,
        ...signal === void 0 ? {} : { signal }
      });
    } catch (error) {
      run = {
        status: "failed",
        summary: `Agent loop crashed: ${errorMessage4(error)}`
      };
    }
    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    const result = normalizeTaskResult({ taskId, loop: run, inspection });
    return verdictTool === void 0 ? result : applyReviewVerdict(result, verdictTool.verdict());
  }
};

// packages/coding-agent/dist/workers/child-process-executor.js
import { spawn as spawn4 } from "node:child_process";

// packages/coding-agent/dist/workers/protocol.js
import { z as z17 } from "zod";
var PlannedTaskSchema2 = z17.object({
  id: z17.string(),
  title: z17.string(),
  goal: z17.string(),
  type: z17.enum([
    "exploration",
    "architecture",
    "implementation",
    "testing",
    "review",
    "documentation"
  ]),
  complexity: z17.enum(["trivial", "normal", "complex", "architectural"]),
  dependencies: z17.array(z17.string()),
  suggestedAgent: z17.string().optional(),
  affectedAreas: z17.array(z17.string()),
  risk: z17.object({
    level: z17.enum(["low", "medium", "high"]),
    categories: z17.array(z17.string())
  })
});
var TaskResultSchema = z17.object({
  taskId: z17.string(),
  status: z17.enum(["success", "failed", "partial"]),
  summary: z17.string(),
  decisions: z17.array(z17.string()),
  changedFiles: z17.array(z17.string()),
  commit: z17.string().optional(),
  tests: z17.object({
    passed: z17.number(),
    failed: z17.number(),
    commands: z17.array(z17.string())
  }),
  unresolvedIssues: z17.array(z17.string()),
  confidence: z17.number()
});
var WorkerRequestSchema = z17.object({
  type: z17.literal("task"),
  task: PlannedTaskSchema2,
  agent: z17.string(),
  runId: z17.string(),
  workspacePath: z17.string(),
  timeoutMs: z17.number().optional(),
  /**
   * Results of the task's direct dependencies, in dependency-declaration order.
   * Optional on purpose: a parent that predates dependency context (or a task
   * with no dependencies) sends a request without it, and that stays valid.
   */
  dependencyResults: z17.array(TaskResultSchema).optional()
});
var WorkerEventLineSchema = z17.object({
  type: z17.literal("event"),
  event: AgentEventSchema
});
var WorkerResultLineSchema = z17.object({
  type: z17.literal("result"),
  result: TaskResultSchema
});
var WorkerStdoutLineSchema = z17.discriminatedUnion("type", [
  WorkerEventLineSchema,
  WorkerResultLineSchema
]);
function toPlannedTask2(parsed) {
  const { suggestedAgent, ...rest } = parsed;
  return {
    ...rest,
    ...suggestedAgent === void 0 ? {} : { suggestedAgent }
  };
}
function toWorkerExecutionContext(request) {
  const results = request.dependencyResults;
  if (results === void 0 || results.length === 0)
    return void 0;
  return { dependencyResults: results.map(toTaskResult) };
}
function toTaskResult(parsed) {
  const { commit, ...rest } = parsed;
  return { ...rest, ...commit === void 0 ? {} : { commit } };
}
function encodeWorkerLine(line) {
  return JSON.stringify(line);
}
function parseWorkerStdoutLine(line) {
  const trimmed = line.trim();
  if (trimmed === "")
    return void 0;
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return void 0;
  }
  const parsed = WorkerStdoutLineSchema.safeParse(json);
  return parsed.success ? parsed.data : void 0;
}
function readFirstLine(stream) {
  return new Promise((resolve5) => {
    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onEnd);
      resolve5(value);
    };
    const onData = (chunk) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const index2 = buffer.indexOf("\n");
      if (index2 !== -1)
        finish(buffer.slice(0, index2));
    };
    const onEnd = () => finish(buffer);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onEnd);
  });
}
function write(stdout, line) {
  stdout.write(`${encodeWorkerLine(line)}
`);
}
async function serveWorkerRequest(io, handler, options = {}) {
  const emitEvents = options.events !== false;
  const raw = await readFirstLine(io.stdin);
  let request;
  try {
    request = WorkerRequestSchema.parse(JSON.parse(raw));
  } catch {
    return 1;
  }
  const sink = {
    emit(event2) {
      if (emitEvents)
        write(io.stdout, { type: "event", event: event2 });
    }
  };
  try {
    const result = await handler(request, sink);
    write(io.stdout, { type: "result", result });
    return 0;
  } catch (error) {
    write(io.stdout, {
      type: "result",
      result: {
        taskId: request.task.id,
        status: "failed",
        summary: `Worker handler failed: ${error instanceof Error ? error.message : String(error)}`,
        decisions: [],
        changedFiles: [],
        tests: { passed: 0, failed: 0, commands: [] },
        unresolvedIssues: [],
        confidence: 0.1
      }
    });
    return 1;
  }
}

// packages/coding-agent/dist/workers/child-process-executor.js
var KILL_GRACE_MS4 = 2e3;
var MAX_STDERR_CHARS2 = 5e4;
var STDERR_TAIL_CHARS = 2e3;
function tail2(text2, limit) {
  const trimmed = text2.trim();
  if (trimmed.length <= limit)
    return trimmed;
  return `...${trimmed.slice(trimmed.length - limit)}`;
}
function describe(command) {
  return command.join(" ");
}
var ChildProcessWorkerExecutor = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  async execute(task, agent, signal, context) {
    const taskId = task.spec.id;
    const { command, runId, workspacePath, taskTimeoutMs } = this.#options;
    const executable = command[0];
    if (executable === void 0) {
      return failedTaskResult(taskId, "No worker command was configured (empty command argv).");
    }
    const signals = [];
    if (signal !== void 0)
      signals.push(signal);
    const timeoutSignal = taskTimeoutMs === void 0 ? void 0 : AbortSignal.timeout(taskTimeoutMs);
    if (timeoutSignal !== void 0)
      signals.push(timeoutSignal);
    const combined = signals.length === 0 ? void 0 : AbortSignal.any(signals);
    if (combined?.aborted === true) {
      return failedTaskResult(taskId, "Worker cancelled before the process was started.");
    }
    const dependencyResults = context?.dependencyResults ?? [];
    const request = JSON.stringify({
      type: "task",
      task: task.spec,
      agent,
      runId,
      workspacePath,
      ...taskTimeoutMs === void 0 ? {} : { timeoutMs: taskTimeoutMs },
      ...dependencyResults.length === 0 ? {} : { dependencyResults }
    });
    let queue = Promise.resolve();
    const forward = (event2) => {
      const sink = this.#options.events;
      if (sink === void 0)
        return;
      queue = queue.then(async () => {
        try {
          await sink.emit(event2);
        } catch {
        }
      });
    };
    let result;
    let stderr = "";
    let stderrTruncated = false;
    const outcome = await new Promise((resolve5) => {
      const child = spawn4(executable, [...command.slice(1)], {
        cwd: workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
        ...detachedSpawnOptions(),
        env: { ...process.env, ...this.#options.env }
      });
      let settled = false;
      let aborted = false;
      let killTimer;
      const killGroup = (sig) => {
        killProcessTree(child, sig);
      };
      const onAbort = () => {
        aborted = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS4);
        killTimer.unref();
      };
      combined?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        if (killTimer !== void 0)
          clearTimeout(killTimer);
        combined?.removeEventListener("abort", onAbort);
      };
      let pending = "";
      const consumeLine = (line) => {
        const parsed = parseWorkerStdoutLine(line.replace(/\r$/, ""));
        if (parsed === void 0)
          return;
        if (parsed.type === "event") {
          forward(parsed.event);
          return;
        }
        if (result === void 0)
          result = toTaskResult(parsed.result);
      };
      child.stdout?.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        let index2 = pending.indexOf("\n");
        while (index2 !== -1) {
          consumeLine(pending.slice(0, index2));
          pending = pending.slice(index2 + 1);
          index2 = pending.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk) => {
        if (stderrTruncated)
          return;
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_STDERR_CHARS2) {
          stderr = stderr.slice(0, MAX_STDERR_CHARS2);
          stderrTruncated = true;
        }
      });
      child.stdin?.on("error", () => void 0);
      child.stdin?.end(`${request}
`);
      child.on("error", (error) => {
        if (settled)
          return;
        settled = true;
        cleanup();
        resolve5({ kind: "spawn-error", error });
      });
      child.on("close", (code) => {
        if (settled)
          return;
        settled = true;
        cleanup();
        if (pending !== "")
          consumeLine(pending);
        resolve5({
          kind: "exit",
          exitCode: code,
          aborted,
          timedOut: aborted && timeoutSignal?.aborted === true
        });
      });
    });
    await queue;
    if (outcome.kind === "spawn-error") {
      const error = outcome.error;
      const code = error?.code;
      const detail = error?.message ?? "unknown error";
      return failedTaskResult(taskId, code === "ENOENT" ? `Worker command not found: "${describe(command)}".` : `Failed to start the worker process "${describe(command)}": ${detail}`);
    }
    if (result !== void 0) {
      return result.taskId === taskId ? result : { ...result, taskId };
    }
    const stderrTail = stderr.trim() === "" ? "" : ` stderr: ${tail2(stderr, STDERR_TAIL_CHARS)}`;
    if (outcome.timedOut === true) {
      return failedTaskResult(taskId, `Worker process timed out after ${String(taskTimeoutMs)}ms and was terminated.${stderrTail}`);
    }
    if (outcome.aborted === true) {
      return failedTaskResult(taskId, `Worker process was cancelled and terminated.${stderrTail}`);
    }
    return failedTaskResult(taskId, `Worker process exited with code ${String(outcome.exitCode)} without returning a result.${stderrTail}`);
  }
};

// packages/coding-agent/dist/workers/codex-executor.js
var CodexWorkerExecutor = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  async execute(task, agent, signal, context) {
    const taskId = task.spec.id;
    const { workspacePath, runId } = this.#options;
    const backend = new CodexBackend({
      ...this.#options.backendOptions,
      ...this.#options.events === void 0 ? {} : { events: this.#options.events },
      ...this.#options.taskTimeoutMs === void 0 ? {} : { timeoutMs: this.#options.taskTimeoutMs }
    });
    let run;
    try {
      run = await backend.run({ instruction: buildTaskBriefing(task.spec, agent, context) }, {
        runId,
        taskId,
        workspacePath,
        ...signal === void 0 ? {} : { signal }
      });
    } catch (error) {
      run = {
        status: "failed",
        summary: `Codex backend crashed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    return normalizeTaskResult({ taskId, loop: run, inspection });
  }
};

// packages/workspace/dist/index.js
import { execFile as execFile6 } from "node:child_process";
import { promisify as promisify4 } from "node:util";

// packages/workspace/dist/worktrees.js
import { mkdir as mkdir2, rm, rmdir } from "node:fs/promises";
import { dirname as dirname2, isAbsolute as isAbsolute3, join as join6, relative as relative3, resolve as resolve3, sep as sep3 } from "node:path";

// packages/workspace/dist/git.js
import { execFile as execFile5 } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute as isAbsolute2, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
import { promisify as promisify3 } from "node:util";
var execFileAsync3 = promisify3(execFile5);
var MAX_BUFFER_BYTES3 = 64 * 1024 * 1024;
var MAX_SEGMENT_LENGTH = 100;
var WorktreeError = class extends Error {
  operation;
  stderr;
  constructor(init) {
    super(init.message, init.cause === void 0 ? void 0 : { cause: init.cause });
    this.name = "WorktreeError";
    this.operation = init.operation;
    this.stderr = init.stderr;
  }
};
function isAbortError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = error.code;
  return error.name === "AbortError" || code === "ABORT_ERR";
}
async function tryGit(args, options) {
  try {
    const result = await execFileAsync3("git", [...args], {
      cwd: options.cwd,
      signal: options.signal,
      env: options.env,
      maxBuffer: MAX_BUFFER_BYTES3,
      windowsHide: true
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const value = error;
    if (typeof value.code !== "number") {
      throw new WorktreeError({
        operation: options.operation,
        message: `git ${args.join(" ")} could not be executed: ${String(error)}`,
        stderr: value.stderr ?? void 0,
        cause: error
      });
    }
    return {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
      exitCode: value.code
    };
  }
}
async function runGit2(args, options) {
  const result = await tryGit(args, options);
  if (result.exitCode !== 0) {
    throw new WorktreeError({
      operation: options.operation,
      message: `git ${args.join(" ")} failed with exit code ${result.exitCode}`,
      stderr: result.stderr.trim() || void 0
    });
  }
  return result;
}
function sanitizeWorktreeSegment(raw, label) {
  let value = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/\.{2,}/g, ".").slice(0, MAX_SEGMENT_LENGTH).replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  while (value.toLowerCase().endsWith(".lock")) {
    value = value.slice(0, -".lock".length).replace(/[-.]+$/, "");
  }
  if (value.length === 0) {
    throw new WorktreeError({
      operation: "sanitize",
      message: `cannot derive a branch-safe ${label} from ${JSON.stringify(raw)}`
    });
  }
  return value;
}
function splitNul(stdout) {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}
function splitLines(stdout) {
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}
function parseWorktreeList(stdout) {
  const entries = [];
  let path10;
  let branch;
  const flush = () => {
    if (path10 !== void 0) {
      entries.push({ path: path10, branch });
    }
    path10 = void 0;
    branch = void 0;
  };
  for (const line of stdout.split("\n")) {
    const value = line.trimEnd();
    if (value.startsWith("worktree ")) {
      flush();
      path10 = value.slice("worktree ".length);
    } else if (value.startsWith("branch refs/heads/")) {
      branch = value.slice("branch refs/heads/".length);
    }
  }
  flush();
  return entries;
}
async function realPathOrSelf(path10) {
  try {
    return await realpath(path10);
  } catch {
    return resolve2(path10);
  }
}
function isUnder(parent, child) {
  const rel = relative2(parent, child);
  return rel === "" || !rel.startsWith(`..${sep2}`) && rel !== ".." && !isAbsolute2(rel);
}

// packages/workspace/dist/worktrees.js
var WORKTREE_BRANCH_PREFIX = "agent-task";
var DEFAULT_WORKTREES_DIR = join6(".agent", "worktrees");
var MAX_DIFF_CHARS2 = 4e5;
var COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "AGENT",
  GIT_AUTHOR_EMAIL: "agent@localhost",
  GIT_COMMITTER_NAME: "AGENT",
  GIT_COMMITTER_EMAIL: "agent@localhost"
};
function commitEnv() {
  return { ...process.env, ...COMMIT_IDENTITY };
}
var TaskWorktreeManager = class {
  repoRoot;
  worktreesDir;
  /** Tail of the integrate queue; never rejects. */
  #integrateQueue = Promise.resolve();
  constructor(options) {
    this.repoRoot = resolve3(options.repoRoot);
    this.worktreesDir = options.worktreesDir === void 0 ? join6(this.repoRoot, DEFAULT_WORKTREES_DIR) : resolve3(options.worktreesDir);
  }
  /**
   * Creates an isolated checkout of the current repository HEAD on a fresh
   * `agent-task/<runId>/<taskId>` branch. Leftovers from a previous attempt
   * (stale directory and/or branch) are removed first so retries start clean.
   */
  async create(runId, taskId, signal) {
    const safeRunId = sanitizeWorktreeSegment(runId, "runId");
    const safeTaskId = sanitizeWorktreeSegment(taskId, "taskId");
    const branch = `${WORKTREE_BRANCH_PREFIX}/${safeRunId}/${safeTaskId}`;
    const path10 = join6(this.worktreesDir, safeRunId, safeTaskId);
    const baseCommit = await this.#requireRepoHead(signal);
    await this.#removeLeftovers(path10, branch, signal);
    await mkdir2(dirname2(path10), { recursive: true });
    await runGit2(["worktree", "add", path10, "-b", branch, baseCommit], {
      cwd: this.repoRoot,
      operation: "create",
      signal
    });
    return { path: path10, branch, baseCommit, runId: safeRunId, taskId: safeTaskId };
  }
  /**
   * Stages everything in the worktree and commits it with an inline agent
   * identity (no dependency on global git config), then reports the changed
   * files and unified diff relative to the base commit.
   */
  async collect(worktree, message, signal) {
    const cwd = worktree.path;
    await runGit2(["add", "-A"], { cwd, operation: "collect.add", signal });
    const staged = await tryGit(["diff", "--cached", "--quiet"], {
      cwd,
      operation: "collect.status",
      signal
    });
    if (staged.exitCode === 0) {
      return { committed: false, changedFiles: [], diff: "" };
    }
    if (staged.exitCode !== 1) {
      throw new WorktreeError({
        operation: "collect.status",
        message: `git diff --cached failed with exit code ${staged.exitCode}`,
        stderr: staged.stderr.trim() || void 0
      });
    }
    const commitMessage = message ?? `agent task ${worktree.taskId}`;
    await runGit2(["commit", "--no-verify", "-m", commitMessage], {
      cwd,
      operation: "collect.commit",
      signal,
      env: commitEnv()
    });
    const head = await runGit2(["rev-parse", "HEAD"], {
      cwd,
      operation: "collect.head",
      signal
    });
    const range = `${worktree.baseCommit}..HEAD`;
    const names = await runGit2(["diff", "--name-only", range], {
      cwd,
      operation: "collect.changed-files",
      signal
    });
    const diff = await runGit2(["diff", range], {
      cwd,
      operation: "collect.diff",
      signal
    });
    return {
      committed: true,
      commit: head.stdout.trim(),
      changedFiles: splitLines(names.stdout),
      diff: truncateDiff(diff.stdout)
    };
  }
  /**
   * Merges a task branch back into the repository's checked-out base branch.
   * Serialized per manager; refuses to run against a dirty base; aborts and
   * reports conflicts instead of leaving a merge in progress.
   */
  async integrate(worktree, signal) {
    const run = this.#integrateQueue.then(() => this.#integrateLocked(worktree, signal));
    this.#integrateQueue = run.then(() => void 0, () => void 0);
    return run;
  }
  async #integrateLocked(worktree, signal) {
    const cwd = this.repoRoot;
    const branchExists = await tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`], { cwd, operation: "integrate.verify", signal });
    if (branchExists.exitCode !== 0) {
      return {
        merged: false,
        conflictFiles: [],
        reason: "error",
        detail: `branch ${worktree.branch} does not exist`
      };
    }
    const ahead = await runGit2(["rev-list", "--count", `${worktree.baseCommit}..${worktree.branch}`], { cwd, operation: "integrate.rev-list", signal });
    if (Number.parseInt(ahead.stdout.trim(), 10) === 0) {
      const head = await runGit2(["rev-parse", "HEAD"], {
        cwd,
        operation: "integrate.head",
        signal
      });
      return { merged: true, commit: head.stdout.trim(), conflictFiles: [] };
    }
    const dirty = await this.#dirtyPaths(signal);
    if (dirty.length > 0) {
      return {
        merged: false,
        conflictFiles: [],
        reason: "dirty-base",
        detail: `base working tree has uncommitted changes: ${dirty.slice(0, 10).join(", ")}`
      };
    }
    const merge = await tryGit([
      "merge",
      "--no-ff",
      "-m",
      `merge agent task ${worktree.taskId}`,
      worktree.branch
    ], { cwd, operation: "integrate.merge", signal, env: commitEnv() });
    if (merge.exitCode === 0) {
      const head = await runGit2(["rev-parse", "HEAD"], {
        cwd,
        operation: "integrate.head",
        signal
      });
      return { merged: true, commit: head.stdout.trim(), conflictFiles: [] };
    }
    const unmerged = await tryGit(["diff", "--name-only", "--diff-filter=U"], {
      cwd,
      operation: "integrate.conflicts",
      signal
    });
    const conflictFiles = splitLines(unmerged.stdout);
    await tryGit(["merge", "--abort"], {
      cwd,
      operation: "integrate.abort",
      signal
    });
    const detail = `${merge.stdout}${merge.stderr}`.trim();
    if (conflictFiles.length > 0 || merge.stdout.includes("CONFLICT")) {
      return {
        merged: false,
        conflictFiles,
        reason: "conflicts",
        ...detail === "" ? {} : { detail }
      };
    }
    return {
      merged: false,
      conflictFiles: [],
      reason: "error",
      ...detail === "" ? {} : { detail }
    };
  }
  /**
   * Unregisters and deletes the checkout, and (unless `keepBranch`) deletes the
   * task branch. Already-removed worktrees and branches are tolerated.
   */
  async remove(worktree, opts, signal) {
    const cwd = this.repoRoot;
    await tryGit(["worktree", "remove", "--force", worktree.path], {
      cwd,
      operation: "remove.worktree",
      signal
    });
    await rm(worktree.path, { recursive: true, force: true });
    await tryGit(["worktree", "prune"], {
      cwd,
      operation: "remove.prune",
      signal
    });
    if (opts?.keepBranch !== true) {
      await tryGit(["branch", "-D", worktree.branch], {
        cwd,
        operation: "remove.branch",
        signal
      });
    }
    await rmdir(dirname2(worktree.path)).catch(() => void 0);
  }
  /**
   * Crash cleanup: prunes stale registrations, removes every worktree under the
   * worktrees directory, and reports `agent-task/*` branches — deleting the ones
   * that are no longer checked out when `removeBranches` is set. Branches outside
   * the `agent-task/` namespace are never touched.
   */
  static async recover(repoRoot, opts) {
    const cwd = resolve3(repoRoot);
    const worktreesDir = opts?.worktreesDir === void 0 ? join6(cwd, DEFAULT_WORKTREES_DIR) : resolve3(opts.worktreesDir);
    const realWorktreesDir = await realPathOrSelf(worktreesDir);
    const realRepoRoot = await realPathOrSelf(cwd);
    await runGit2(["worktree", "prune"], { cwd, operation: "recover.prune" });
    const listed = await runGit2(["worktree", "list", "--porcelain"], {
      cwd,
      operation: "recover.list"
    });
    const prunedWorktrees = [];
    for (const entry of parseWorktreeList(listed.stdout)) {
      const real = await realPathOrSelf(entry.path);
      if (real === realRepoRoot || !isUnder(realWorktreesDir, real)) {
        continue;
      }
      await tryGit(["worktree", "remove", "--force", entry.path], {
        cwd,
        operation: "recover.remove"
      });
      await rm(entry.path, { recursive: true, force: true });
      prunedWorktrees.push(entry.path);
    }
    await runGit2(["worktree", "prune"], { cwd, operation: "recover.prune" });
    const refs = await runGit2([
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${WORKTREE_BRANCH_PREFIX}/`
    ], { cwd, operation: "recover.branches" });
    const remaining = await runGit2(["worktree", "list", "--porcelain"], {
      cwd,
      operation: "recover.list"
    });
    const checkedOut = new Set(parseWorktreeList(remaining.stdout).map((entry) => entry.branch).filter((branch) => branch !== void 0));
    const removedBranches = [];
    const kept = [];
    for (const branch of splitLines(refs.stdout)) {
      if (opts?.removeBranches !== true || checkedOut.has(branch)) {
        kept.push(branch);
        continue;
      }
      const deleted = await tryGit(["branch", "-D", branch], {
        cwd,
        operation: "recover.branch-delete"
      });
      if (deleted.exitCode === 0) {
        removedBranches.push(branch);
      } else {
        kept.push(branch);
      }
    }
    return { prunedWorktrees, removedBranches, kept };
  }
  async #requireRepoHead(signal) {
    const inside = await tryGit(["rev-parse", "--git-dir"], {
      cwd: this.repoRoot,
      operation: "create.verify-repo",
      signal
    });
    if (inside.exitCode !== 0) {
      throw new WorktreeError({
        operation: "create.verify-repo",
        message: `${this.repoRoot} is not a git repository`,
        stderr: inside.stderr.trim() || void 0
      });
    }
    const head = await tryGit(["rev-parse", "HEAD"], {
      cwd: this.repoRoot,
      operation: "create.head",
      signal
    });
    if (head.exitCode !== 0) {
      throw new WorktreeError({
        operation: "create.head",
        message: `${this.repoRoot} has no commits yet; commit before creating task worktrees`,
        stderr: head.stderr.trim() || void 0
      });
    }
    return head.stdout.trim();
  }
  async #removeLeftovers(path10, branch, signal) {
    await tryGit(["worktree", "remove", "--force", path10], {
      cwd: this.repoRoot,
      operation: "create.cleanup-worktree",
      signal
    });
    await rm(path10, { recursive: true, force: true });
    await tryGit(["worktree", "prune"], {
      cwd: this.repoRoot,
      operation: "create.prune",
      signal
    });
    await tryGit(["branch", "-D", branch], {
      cwd: this.repoRoot,
      operation: "create.cleanup-branch",
      signal
    });
  }
  /**
   * Uncommitted paths in the base checkout, excluding the worktrees directory —
   * task checkouts nested inside the repository always look untracked to git.
   */
  async #dirtyPaths(signal) {
    const status = await runGit2(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: this.repoRoot, operation: "integrate.status", signal });
    const ignored = this.#worktreesPrefix();
    const paths = [];
    for (const record of splitNul(status.stdout)) {
      const path10 = record.length > 3 && record[2] === " " ? record.slice(3) : record;
      if (ignored !== void 0 && path10.startsWith(ignored)) {
        continue;
      }
      paths.push(path10);
    }
    return paths;
  }
  /** Repo-relative, slash-separated prefix of the worktrees dir, when nested inside. */
  #worktreesPrefix() {
    const rel = relative3(this.repoRoot, this.worktreesDir);
    if (rel === "" || rel.startsWith("..") || isAbsolute3(rel)) {
      return void 0;
    }
    return `${rel.split(sep3).join("/")}/`;
  }
};
function truncateDiff(diff) {
  if (diff.length <= MAX_DIFF_CHARS2) {
    return diff;
  }
  return `${diff.slice(0, MAX_DIFF_CHARS2)}
[diff truncated after ${MAX_DIFF_CHARS2} characters]
`;
}

// packages/workspace/dist/index.js
var execFileAsync4 = promisify4(execFile6);

// packages/coding-agent/dist/workers/worktree-executor.js
var MAX_LISTED_FILES = 10;
function errorMessage5(error) {
  return error instanceof Error ? error.message : String(error);
}
function listFiles(files) {
  if (files.length === 0)
    return "(no files reported)";
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");
  return files.length <= MAX_LISTED_FILES ? shown : `${shown} (and ${files.length - MAX_LISTED_FILES} more)`;
}
function keptBranchIssue(branch) {
  return `The task branch ${branch} was kept for inspection; merge or delete it by hand.`;
}
function finalize(inner, outcome) {
  const issues = outcome.issues ?? [];
  return {
    taskId: inner.taskId,
    status: outcome.status ?? inner.status,
    summary: inner.summary,
    decisions: inner.decisions,
    changedFiles: outcome.changedFiles,
    ...outcome.commit === void 0 ? {} : { commit: outcome.commit },
    tests: inner.tests,
    unresolvedIssues: issues.length === 0 ? inner.unresolvedIssues : [...inner.unresolvedIssues, ...issues],
    confidence: inner.confidence
  };
}
var WorktreeIsolatedExecutor = class {
  #options;
  #manager;
  constructor(options) {
    this.#options = options;
    this.#manager = options.manager ?? new TaskWorktreeManager({ repoRoot: options.repoRoot });
  }
  async execute(task, agent, signal, context) {
    const taskId = task.spec.id;
    if (!MUTATING_TASK_TYPES.has(task.spec.type)) {
      return this.#options.createExecutor(this.#options.repoRoot).execute(task, agent, signal, context);
    }
    let worktree;
    try {
      worktree = await this.#manager.create(this.#options.runId, taskId, signal);
    } catch (error) {
      return failedTaskResult(taskId, `Could not create an isolated worktree for ${taskId}: ${errorMessage5(error)}`);
    }
    await this.#emit("worktree.created", taskId, {
      taskId,
      branch: worktree.branch,
      path: worktree.path
    });
    const inner = await this.#runInner(task, agent, worktree, signal, context);
    return this.#collectAndIntegrate(taskId, task.spec.title, worktree, inner);
  }
  /** Runs the inner executor against the checkout, never letting it throw out. */
  async #runInner(task, agent, worktree, signal, context) {
    try {
      return await this.#options.createExecutor(worktree.path).execute(task, agent, signal, context);
    } catch (error) {
      return failedTaskResult(task.spec.id, `Worker crashed inside the task worktree: ${errorMessage5(error)}`);
    }
  }
  /**
   * The tail every mutating task runs through: commit whatever is in the
   * checkout, merge it back when the task succeeded, and clean up.
   *
   * The abort signal is deliberately not forwarded past `create`: once a worker
   * has run, collecting and merging its work is exactly what a cancelled run
   * still needs to do, and a git call that aborts halfway would strand the
   * checkout instead of tidying it.
   */
  async #collectAndIntegrate(taskId, title, worktree, inner) {
    let collected;
    try {
      collected = await this.#manager.collect(worktree, `agent task ${taskId}: ${title}`);
    } catch (error) {
      return finalize(inner, {
        status: inner.status === "failed" ? "failed" : "partial",
        changedFiles: [],
        issues: [
          `Could not collect the task worktree: ${errorMessage5(error)}`,
          `The checkout at ${worktree.path} (branch ${worktree.branch}) was left in place.`
        ]
      });
    }
    if (inner.status !== "success" || !collected.committed) {
      return this.#withoutMerge(taskId, worktree, inner, collected);
    }
    let integrated;
    try {
      integrated = await this.#manager.integrate(worktree);
    } catch (error) {
      await this.#remove(taskId, worktree, true);
      return finalize(inner, {
        status: "partial",
        changedFiles: collected.changedFiles,
        commit: collected.commit,
        issues: [
          `Could not merge the task branch into the base: ${errorMessage5(error)}`,
          keptBranchIssue(worktree.branch)
        ]
      });
    }
    if (integrated.merged) {
      await this.#emit("worktree.integrated", taskId, {
        taskId,
        merged: true,
        ...integrated.commit === void 0 ? {} : { commit: integrated.commit }
      });
      await this.#remove(taskId, worktree, false);
      return finalize(inner, {
        changedFiles: collected.changedFiles,
        commit: integrated.commit ?? collected.commit
      });
    }
    await this.#emit("worktree.integrated", taskId, {
      taskId,
      merged: false,
      conflictFiles: integrated.conflictFiles,
      ...integrated.reason === void 0 ? {} : { reason: integrated.reason }
    });
    await this.#remove(taskId, worktree, true);
    return finalize(inner, {
      status: "partial",
      changedFiles: collected.changedFiles,
      commit: collected.commit,
      issues: [
        integrated.reason === "conflicts" ? `merge conflict with base in: ${listFiles(integrated.conflictFiles)}` : `The task branch could not be merged (${integrated.reason ?? "unknown reason"}): ${integrated.detail ?? "no detail reported"}`,
        keptBranchIssue(worktree.branch)
      ]
    });
  }
  /**
   * Finishes a task whose work is not going to be merged: the worker failed,
   * came back partial, or produced nothing at all. A commit that exists is
   * evidence, so its branch survives; an empty checkout leaves nothing behind.
   */
  async #withoutMerge(taskId, worktree, inner, collected) {
    if (!collected.committed) {
      await this.#remove(taskId, worktree, false);
      return finalize(inner, { changedFiles: [] });
    }
    await this.#remove(taskId, worktree, true);
    return finalize(inner, {
      changedFiles: collected.changedFiles,
      commit: collected.commit,
      issues: [
        `The task did not succeed, so its changes were not merged: ${listFiles(collected.changedFiles)}`,
        keptBranchIssue(worktree.branch)
      ]
    });
  }
  /** Best-effort cleanup: a leaked checkout is recoverable, a thrown error is not. */
  async #remove(taskId, worktree, keepBranch) {
    try {
      await this.#manager.remove(worktree, { keepBranch });
    } catch {
    }
    await this.#emit("worktree.removed", taskId, {
      taskId,
      keptBranch: keepBranch,
      branch: worktree.branch
    });
  }
  async #emit(type, taskId, data) {
    const sink = this.#options.events;
    if (sink === void 0)
      return;
    try {
      await sink.emit({
        id: crypto.randomUUID(),
        runId: this.#options.runId,
        timestamp: Date.now(),
        type,
        taskId,
        data
      });
    } catch {
    }
  }
};

// apps/cli/dist/plan.js
import { readFile as readFile8 } from "node:fs/promises";
import path3 from "node:path";

// packages/ai/dist/catalog.js
var FULL_CAPABILITIES = {
  tools: true,
  reasoning: true,
  vision: true,
  structuredOutput: true
};
function claude(id, inputPerMTok, outputPerMTok, contextWindow, maxOutputTokens) {
  return {
    provider: "anthropic",
    id,
    contextWindow,
    maxOutputTokens,
    capabilities: FULL_CAPABILITIES,
    pricing: {
      inputPerMTok,
      outputPerMTok,
      cachedInputPerMTok: Number((inputPerMTok * 0.1).toFixed(4))
    }
  };
}
var MILLION = 1e6;
var K128 = 128e3;
function defaultModelCatalog() {
  return {
    // --- Anthropic -------------------------------------------------------
    "claude-fable-5": claude("claude-fable-5", 10, 50, MILLION, K128),
    "claude-opus-5": claude("claude-opus-5", 5, 25, MILLION, K128),
    "claude-opus-4-8": claude("claude-opus-4-8", 5, 25, MILLION, K128),
    "claude-opus-4-7": claude("claude-opus-4-7", 5, 25, MILLION, K128),
    "claude-opus-4-6": claude("claude-opus-4-6", 5, 25, MILLION, K128),
    // Sonnet 5 has promotional pricing of $2/$10 per MTok through 2026-08-31;
    // the standard rate below is what applies afterwards.
    "claude-sonnet-5": claude("claude-sonnet-5", 3, 15, MILLION, K128),
    "claude-sonnet-4-6": claude("claude-sonnet-4-6", 3, 15, MILLION, K128),
    "claude-haiku-4-5": claude("claude-haiku-4-5", 1, 5, 2e5, 64e3),
    // --- OpenAI ----------------------------------------------------------
    // No pricing shipped: OpenAI rates are not verified here. Override
    // `pricing` on these entries to get non-zero cost accounting.
    "gpt-5.1": {
      provider: "openai",
      id: "gpt-5.1",
      capabilities: FULL_CAPABILITIES
    },
    "gpt-5-mini": {
      provider: "openai",
      id: "gpt-5-mini",
      capabilities: FULL_CAPABILITIES
    }
  };
}

// packages/ai/dist/sse.js
async function* parseSse(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName;
  let dataLines = [];
  const takePending = () => {
    if (dataLines.length === 0) {
      eventName = void 0;
      return void 0;
    }
    const message = {
      event: eventName,
      data: dataLines.join("\n")
    };
    eventName = void 0;
    dataLines = [];
    return message;
  };
  const consumeLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "")
      return takePending();
    if (line.startsWith(":"))
      return void 0;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" "))
      value = value.slice(1);
    if (field === "event")
      eventName = value;
    else if (field === "data")
      dataLines.push(value);
    return void 0;
  };
  const onAbort = () => {
    void reader.cancel().catch(() => void 0);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted)
        return;
      const { done, value } = await reader.read();
      if (signal?.aborted)
        return;
      if (done)
        break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = consumeLine(rawLine);
        if (message !== void 0)
          yield message;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") {
      const message = consumeLine(buffer);
      if (message !== void 0)
        yield message;
      buffer = "";
    }
    const trailing = takePending();
    if (trailing !== void 0)
      yield trailing;
  } catch (error) {
    if (signal?.aborted)
      return;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
    }
  }
}

// packages/ai/dist/providers/errors.js
var ProviderError = class extends Error {
  provider;
  status;
  body;
  constructor(init) {
    super(init.message);
    this.name = "ProviderError";
    this.provider = init.provider;
    this.status = init.status;
    this.body = init.body;
  }
};

// packages/ai/dist/providers/anthropic.js
var OAUTH_BETA = "oauth-2025-04-20";
var DEFAULT_BASE_URL = "https://api.anthropic.com";
var ANTHROPIC_VERSION = "2023-06-01";
var DEFAULT_MAX_TOKENS = 4096;
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function parseToolInput(raw) {
  const trimmed = raw.trim();
  if (trimmed === "")
    return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}
function toWireTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  };
}
function toWireToolChoice(choice) {
  switch (choice.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}
function mapMessages(messages) {
  const systemParts = [];
  const wire = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        if (message.content !== "")
          systemParts.push(message.content);
        break;
      case "user":
        wire.push({ role: "user", content: message.content });
        break;
      case "tool": {
        const block = {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: message.content
        };
        if (message.isError === true)
          block.is_error = true;
        wire.push({ role: "user", content: [block] });
        break;
      }
      case "assistant": {
        const calls = message.toolCalls ?? [];
        if (calls.length === 0) {
          wire.push({ role: "assistant", content: message.content });
          break;
        }
        const blocks = [];
        if (message.content !== "")
          blocks.push({ type: "text", text: message.content });
        for (const call of calls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input
          });
        }
        wire.push({ role: "assistant", content: blocks });
        break;
      }
    }
  }
  return {
    system: systemParts.length === 0 ? void 0 : systemParts.join("\n\n"),
    messages: wire
  };
}
var AnthropicProvider = class {
  id = "anthropic";
  #credential;
  #baseUrl;
  constructor(options) {
    const { apiKey, authToken } = options;
    if (apiKey !== void 0 && authToken !== void 0) {
      throw new Error("AnthropicProvider: pass either `apiKey` or `authToken`, not both.");
    }
    if (apiKey === void 0 && authToken === void 0) {
      throw new Error("AnthropicProvider: pass either `apiKey` or `authToken`.");
    }
    this.#credential = apiKey !== void 0 ? { kind: "api-key", value: apiKey } : { kind: "auth-token", value: authToken };
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }
  /**
   * Base request headers plus credential headers: `x-api-key` for an API
   * key, or `authorization: Bearer <token>` plus the OAuth beta flag for an
   * auth token (never both `x-api-key` and `authorization` — the API
   * rejects requests carrying both). The OAuth beta flag is comma-joined
   * onto `anthropic-beta` rather than overwriting it, in case a future
   * feature already populated that header for this request.
   */
  #headers() {
    const headers = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      accept: "text/event-stream"
    };
    if (this.#credential.kind === "api-key") {
      headers["x-api-key"] = this.#credential.value;
      return headers;
    }
    headers.authorization = `Bearer ${this.#credential.value}`;
    const existingBeta = headers["anthropic-beta"];
    headers["anthropic-beta"] = existingBeta === void 0 || existingBeta === "" ? OAUTH_BETA : `${existingBeta},${OAUTH_BETA}`;
    return headers;
  }
  supports(model) {
    return model.provider === "anthropic";
  }
  #buildBody(request) {
    const { system, messages } = mapMessages(request.messages);
    const body = {
      model: request.model.id,
      max_tokens: request.maxOutputTokens ?? request.model.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      messages
    };
    if (system !== void 0)
      body.system = system;
    if (request.tools !== void 0 && request.tools.length > 0) {
      body.tools = request.tools.map(toWireTool);
    }
    if (request.toolChoice !== void 0) {
      body.tool_choice = toWireToolChoice(request.toolChoice);
    }
    if (request.temperature !== void 0)
      body.temperature = request.temperature;
    return body;
  }
  async *stream(request, signal) {
    const response = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(this.#buildBody(request)),
      signal: signal ?? null
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError({
        provider: this.id,
        status: response.status,
        message: `Anthropic request failed with status ${response.status}`,
        body
      });
    }
    if (response.body === null) {
      throw new ProviderError({
        provider: this.id,
        status: response.status,
        message: "Anthropic response had no body"
      });
    }
    const blocks = /* @__PURE__ */ new Map();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let finishReason = "end_turn";
    const readUsage = (usage) => {
      if (!isRecord2(usage))
        return;
      if (typeof usage.input_tokens === "number")
        inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number")
        outputTokens = usage.output_tokens;
      if (typeof usage.cache_read_input_tokens === "number") {
        cachedInputTokens = usage.cache_read_input_tokens;
      }
    };
    const finalEvents = () => [
      {
        type: "usage",
        inputTokens,
        outputTokens,
        ...cachedInputTokens > 0 ? { cachedInputTokens } : {}
      },
      { type: "done", finishReason }
    ];
    for await (const message of parseSse(response.body, signal)) {
      if (signal?.aborted)
        return;
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch {
        continue;
      }
      if (!isRecord2(payload))
        continue;
      const type = typeof payload.type === "string" ? payload.type : message.event ?? "";
      if (type === "error") {
        const error = isRecord2(payload.error) ? payload.error : void 0;
        const detail = error !== void 0 && typeof error.message === "string" ? error.message : "Anthropic stream error";
        throw new ProviderError({
          provider: this.id,
          status: response.status,
          message: detail,
          body: message.data
        });
      }
      if (type === "message_start") {
        const wrapped = isRecord2(payload.message) ? payload.message : void 0;
        if (wrapped !== void 0)
          readUsage(wrapped.usage);
        continue;
      }
      if (type === "content_block_start") {
        const index2 = asNumber(payload.index);
        const block = isRecord2(payload.content_block) ? payload.content_block : void 0;
        if (block !== void 0 && block.type === "tool_use") {
          blocks.set(index2, {
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "",
            json: ""
          });
        }
        continue;
      }
      if (type === "content_block_delta") {
        const index2 = asNumber(payload.index);
        const delta = isRecord2(payload.delta) ? payload.delta : void 0;
        if (delta === void 0)
          continue;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (delta.text !== "")
            yield { type: "text.delta", text: delta.text };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const pendingBlock = blocks.get(index2);
          if (pendingBlock !== void 0)
            pendingBlock.json += delta.partial_json;
        }
        continue;
      }
      if (type === "content_block_stop") {
        const index2 = asNumber(payload.index);
        const pendingBlock = blocks.get(index2);
        if (pendingBlock !== void 0) {
          blocks.delete(index2);
          yield {
            type: "tool.call",
            id: pendingBlock.id,
            name: pendingBlock.name,
            input: parseToolInput(pendingBlock.json)
          };
        }
        continue;
      }
      if (type === "message_delta") {
        const delta = isRecord2(payload.delta) ? payload.delta : void 0;
        if (delta !== void 0 && typeof delta.stop_reason === "string") {
          finishReason = delta.stop_reason;
        }
        readUsage(payload.usage);
        continue;
      }
      if (type === "message_stop") {
        for (const event2 of finalEvents())
          yield event2;
        return;
      }
    }
    if (signal?.aborted)
      return;
    for (const event2 of finalEvents())
      yield event2;
  }
};

// packages/ai/dist/providers/openai.js
var DEFAULT_BASE_URL2 = "https://api.openai.com/v1";
function isRecord3(value) {
  return typeof value === "object" && value !== null;
}
function asNumber2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function toWireMessage(message) {
  switch (message.role) {
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? ""
      };
    case "assistant": {
      const calls = message.toolCalls ?? [];
      if (calls.length === 0)
        return { role: "assistant", content: message.content };
      return {
        role: "assistant",
        content: message.content === "" ? null : message.content,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) }
        }))
      };
    }
    default:
      return { role: message.role, content: message.content };
  }
}
function toWireTool2(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  };
}
function toWireToolChoice2(choice) {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}
function parseArguments(raw) {
  const trimmed = raw.trim();
  if (trimmed === "")
    return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}
var OpenAIProvider = class {
  id = "openai";
  #apiKey;
  #baseUrl;
  constructor(options) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL2).replace(/\/+$/, "");
  }
  supports(model) {
    return model.provider === "openai" || model.provider === "openai-compatible";
  }
  #buildBody(request) {
    const body = {
      model: request.model.id,
      stream: true,
      stream_options: { include_usage: true },
      messages: request.messages.map(toWireMessage)
    };
    if (request.tools !== void 0 && request.tools.length > 0) {
      body.tools = request.tools.map(toWireTool2);
    }
    if (request.toolChoice !== void 0) {
      body.tool_choice = toWireToolChoice2(request.toolChoice);
    }
    if (request.temperature !== void 0)
      body.temperature = request.temperature;
    if (request.maxOutputTokens !== void 0) {
      body.max_completion_tokens = request.maxOutputTokens;
    }
    return body;
  }
  async *stream(request, signal) {
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
        accept: "text/event-stream"
      },
      body: JSON.stringify(this.#buildBody(request)),
      signal: signal ?? null
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError({
        provider: this.id,
        status: response.status,
        message: `OpenAI request failed with status ${response.status}`,
        body
      });
    }
    if (response.body === null) {
      throw new ProviderError({
        provider: this.id,
        status: response.status,
        message: "OpenAI response had no body"
      });
    }
    const pending = /* @__PURE__ */ new Map();
    let finishReason = "stop";
    let emittedToolCalls = false;
    const flushToolCalls = () => {
      if (emittedToolCalls)
        return [];
      emittedToolCalls = true;
      const indexes = [...pending.keys()].sort((a, b) => a - b);
      const events2 = [];
      for (const index2 of indexes) {
        const call = pending.get(index2);
        if (call === void 0)
          continue;
        events2.push({
          type: "tool.call",
          id: call.id,
          name: call.name,
          input: parseArguments(call.args)
        });
      }
      return events2;
    };
    for await (const message of parseSse(response.body, signal)) {
      if (signal?.aborted)
        return;
      if (message.data === "[DONE]")
        break;
      let chunk;
      try {
        chunk = JSON.parse(message.data);
      } catch {
        continue;
      }
      if (!isRecord3(chunk))
        continue;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = choices[0];
      if (isRecord3(choice)) {
        const delta = isRecord3(choice.delta) ? choice.delta : void 0;
        if (delta !== void 0 && typeof delta.content === "string" && delta.content !== "") {
          yield { type: "text.delta", text: delta.content };
        }
        if (delta !== void 0 && Array.isArray(delta.tool_calls)) {
          for (const entry of delta.tool_calls) {
            if (!isRecord3(entry))
              continue;
            const index2 = typeof entry.index === "number" ? entry.index : 0;
            let call = pending.get(index2);
            if (call === void 0) {
              call = { id: "", name: "", args: "" };
              pending.set(index2, call);
            }
            if (typeof entry.id === "string")
              call.id = entry.id;
            const fn = isRecord3(entry.function) ? entry.function : void 0;
            if (fn !== void 0) {
              if (typeof fn.name === "string")
                call.name = fn.name;
              if (typeof fn.arguments === "string")
                call.args += fn.arguments;
            }
          }
        }
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
          for (const event2 of flushToolCalls())
            yield event2;
        }
      }
      if (isRecord3(chunk.usage)) {
        const usage = chunk.usage;
        const details = isRecord3(usage.prompt_tokens_details) ? usage.prompt_tokens_details : void 0;
        const cached = details === void 0 ? 0 : asNumber2(details.cached_tokens);
        yield {
          type: "usage",
          inputTokens: asNumber2(usage.prompt_tokens),
          outputTokens: asNumber2(usage.completion_tokens),
          ...cached > 0 ? { cachedInputTokens: cached } : {}
        };
      }
    }
    if (signal?.aborted)
      return;
    for (const event2 of flushToolCalls())
      yield event2;
    yield { type: "done", finishReason };
  }
};

// packages/ai/dist/registry.js
var StaticModelRegistry = class {
  #models;
  #providers;
  constructor(models, providers) {
    this.#models = models;
    this.#providers = providers;
  }
  get(alias) {
    const model = this.#models[alias];
    if (model === void 0) {
      const known = Object.keys(this.#models).sort().join(", ");
      throw new Error(`Unknown model alias "${alias}". Known aliases: ${known === "" ? "(none registered)" : known}`);
    }
    return model;
  }
  providerFor(model) {
    const provider = this.#providers.find((candidate) => candidate.supports(model));
    if (provider === void 0) {
      const known = this.#providers.map((candidate) => candidate.id).join(", ");
      throw new Error(`No provider supports model "${model.provider}/${model.id}". Registered providers: ${known === "" ? "(none registered)" : known}`);
    }
    return provider;
  }
  aliases() {
    return Object.keys(this.#models);
  }
};

// packages/ai/dist/usage.js
var PER_MILLION = 1e6;
function newBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    hasCached: false,
    costUsd: 0
  };
}
function usageCostUsd(pricing, usage) {
  if (pricing === void 0)
    return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const total = usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok + cached * cachedRate;
  return total / PER_MILLION;
}
function toUsage(bucket) {
  return {
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    ...bucket.hasCached ? { cachedInputTokens: bucket.cachedInputTokens } : {}
  };
}
var UsageTracker = class {
  #byModel = /* @__PURE__ */ new Map();
  #total = newBucket();
  record(model, usage) {
    const key = `${model.provider}/${model.id}`;
    let bucket = this.#byModel.get(key);
    if (bucket === void 0) {
      bucket = newBucket();
      this.#byModel.set(key, bucket);
    }
    const cached = usage.cachedInputTokens ?? 0;
    const cost = usageCostUsd(model.pricing, usage);
    for (const target of [bucket, this.#total]) {
      target.inputTokens += usage.inputTokens;
      target.outputTokens += usage.outputTokens;
      target.cachedInputTokens += cached;
      target.hasCached = target.hasCached || usage.cachedInputTokens !== void 0;
      target.costUsd += cost;
    }
  }
  totals() {
    return { usage: toUsage(this.#total), costUsd: this.#total.costUsd };
  }
  byModel() {
    const out = /* @__PURE__ */ new Map();
    for (const [key, bucket] of this.#byModel) {
      out.set(key, { usage: toUsage(bucket), costUsd: bucket.costUsd });
    }
    return out;
  }
};

// apps/cli/dist/auth.js
import { execFile as execFileCb } from "node:child_process";
var defaultExecFile = (file, args, options) => new Promise((resolve5, reject) => {
  execFileCb(file, args, { timeout: options.timeout, env: options.env }, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve5({ stdout, stderr });
  });
});
var OAUTH_TIMEOUT_MS = 5e3;
async function resolveAnthropicCredential(env, opts) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey !== void 0 && apiKey !== "") {
    return { kind: "api-key", apiKey };
  }
  const authToken = env.ANTHROPIC_AUTH_TOKEN;
  if (authToken !== void 0 && authToken !== "") {
    return { kind: "auth-token", authToken, source: "env" };
  }
  if (opts?.allowProfile === false)
    return void 0;
  const execFile8 = opts?.execFile ?? defaultExecFile;
  try {
    const { stdout } = await execFile8("ant", ["auth", "print-credentials", "--access-token"], { timeout: OAUTH_TIMEOUT_MS, env });
    const token = stdout.trim();
    if (token === "" || token.includes("\n"))
      return void 0;
    return { kind: "auth-token", authToken: token, source: "oauth-profile" };
  } catch {
    return void 0;
  }
}

// apps/cli/dist/models.js
var DEFAULT_MODEL_ALIAS = "claude-sonnet-5";
function resolveModelAlias(env, flag) {
  if (flag !== void 0 && flag !== "")
    return flag;
  const fromEnv = env.AGENT_MODEL;
  if (fromEnv !== void 0 && fromEnv !== "")
    return fromEnv;
  return DEFAULT_MODEL_ALIAS;
}
function envVarForProvider(provider) {
  if (provider === "anthropic")
    return "ANTHROPIC_API_KEY";
  if (provider === "openai" || provider === "openai-compatible") {
    return "OPENAI_API_KEY";
  }
  return void 0;
}
async function buildProviders(env, opts) {
  const providers = [];
  const anthropicCredential = opts?.anthropicCredential ?? await resolveAnthropicCredential(env, {
    ...opts?.allowProfile === void 0 ? {} : { allowProfile: opts.allowProfile }
  });
  if (anthropicCredential !== void 0) {
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const credentialOptions = anthropicCredential.kind === "api-key" ? { apiKey: anthropicCredential.apiKey } : { authToken: anthropicCredential.authToken };
    providers.push(new AnthropicProvider({
      ...credentialOptions,
      ...baseUrl !== void 0 && baseUrl !== "" ? { baseUrl } : {}
    }));
  }
  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey !== void 0 && openaiKey !== "") {
    const baseUrl = env.OPENAI_BASE_URL;
    providers.push(new OpenAIProvider({
      apiKey: openaiKey,
      ...baseUrl !== void 0 && baseUrl !== "" ? { baseUrl } : {}
    }));
  }
  return providers;
}
async function buildRegistry(env, opts) {
  return new StaticModelRegistry(defaultModelCatalog(), await buildProviders(env, opts));
}
function hasApiKey(env, provider) {
  const envVar = envVarForProvider(provider);
  if (envVar === void 0)
    return false;
  const value = env[envVar];
  return value !== void 0 && value !== "";
}
function credentialHintForProvider(provider) {
  if (provider === "anthropic") {
    return "set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in your shell environment or in a .env file in the workspace, or log in with the Anthropic CLI: `ant auth login`";
  }
  const envVar = envVarForProvider(provider);
  return envVar === void 0 ? `no provider is configured for "${provider}"` : `set ${envVar} in your shell environment or in a .env file in the workspace`;
}
function formatAnthropicCredentialStatus(credential) {
  if (credential === void 0)
    return "\u2717";
  if (credential.kind === "api-key")
    return "api key";
  return credential.source === "env" ? "auth token" : "oauth (ant)";
}
async function listModels(env, opts) {
  const anthropicCredential = await resolveAnthropicCredential(env, opts);
  const registry = await buildRegistry(env, {
    ...anthropicCredential === void 0 ? {} : { anthropicCredential }
  });
  return registry.aliases().slice().sort().map((alias) => {
    const model = registry.get(alias);
    if (model.provider === "anthropic") {
      return {
        alias,
        provider: model.provider,
        hasKey: anthropicCredential !== void 0,
        credentialStatus: formatAnthropicCredentialStatus(anthropicCredential)
      };
    }
    const hasKey = hasApiKey(env, model.provider);
    return {
      alias,
      provider: model.provider,
      hasKey,
      credentialStatus: hasKey ? "\u2713" : "\u2717"
    };
  });
}

// apps/cli/dist/project-models.js
var ASSUMED_CAPABILITIES = {
  tools: true,
  reasoning: true,
  vision: false,
  structuredOutput: true
};
function modelDefinitionFor(ref) {
  for (const definition of Object.values(defaultModelCatalog())) {
    if (definition.id === ref.model && definition.provider === ref.provider) {
      return definition;
    }
  }
  return {
    provider: ref.provider,
    id: ref.model,
    capabilities: ASSUMED_CAPABILITIES
  };
}
function knownAliases(project) {
  const aliases = Object.keys(project.config.models).sort();
  return aliases.length === 0 ? "(none defined)" : aliases.join(", ");
}
async function createProjectModelResolver(project, env) {
  const providers = await buildProviders(env);
  return (modelAlias) => {
    const ref = project.config.models[modelAlias];
    if (ref === void 0) {
      throw new Error(`Model alias "${modelAlias}" is not defined in ${project.root}/config.yaml. Known aliases: ${knownAliases(project)}.`);
    }
    const model = modelDefinitionFor(ref);
    const provider = providers.find((candidate) => candidate.supports(model));
    if (provider === void 0) {
      throw new Error(`Model alias "${modelAlias}" (${ref.provider}/${ref.model}) requires the "${ref.provider}" provider, which is not configured: ${credentialHintForProvider(ref.provider)}.`);
    }
    return { provider, model };
  };
}

// apps/cli/dist/run.js
import path2 from "node:path";

// apps/cli/dist/permissions.js
var DEFAULT_PERMISSIONS = {
  read_file: "allow",
  glob: "allow",
  grep: "allow",
  git_diff: "allow",
  write_file: "ask",
  edit_file: "ask",
  bash: "ask"
};

// apps/cli/dist/prompter.js
import * as readline from "node:readline";
var PREVIEW_MAX = 120;
function createPromptState() {
  return { active: false };
}
function previewInput(input) {
  let text2;
  try {
    text2 = JSON.stringify(input) ?? String(input);
  } catch {
    text2 = String(input);
  }
  if (text2.length <= PREVIEW_MAX)
    return text2;
  return `${text2.slice(0, PREVIEW_MAX - 3)}...`;
}
function createPrompter(options) {
  if (options.yes) {
    return { ask: async () => true };
  }
  if (!options.interactive) {
    return void 0;
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const state = options.state;
  return {
    ask: async (request) => {
      state.active = true;
      try {
        return await askOnce(request, input, output);
      } finally {
        state.active = false;
      }
    }
  };
}
function askOnce(request, input, output) {
  const rl = readline.createInterface({ input, output, terminal: true });
  const preview = previewInput(request.input);
  return new Promise((resolve5) => {
    let settled = false;
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      rl.close();
      resolve5(value);
    };
    rl.on("SIGINT", () => finish(false));
    rl.question(`allow ${request.tool}? ${preview} [y/N] `, (answer) => {
      const normalized = answer.trim().toLowerCase();
      finish(normalized === "y" || normalized === "yes");
    });
  });
}

// apps/cli/dist/render.js
function isRecord4(value) {
  return typeof value === "object" && value !== null;
}
function isCodexResult(result) {
  return "events" in result;
}
var CODEX_PREFIX = "codex.";
function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "")
      return value;
  }
  return void 0;
}
function codexItemFrom(data) {
  if (isRecord4(data.item))
    return data.item;
  if (isRecord4(data.msg) && isRecord4(data.msg.item))
    return data.msg.item;
  return void 0;
}
function codexMessageText(item) {
  const direct = firstNonEmptyString(item.text, item.message);
  if (direct !== void 0)
    return direct;
  const content = item.content;
  if (typeof content === "string" && content.trim() !== "")
    return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string")
        parts.push(part);
      else if (isRecord4(part) && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    const joined = parts.join("");
    if (joined !== "")
      return joined;
  }
  return void 0;
}
function codexCommandText(item) {
  const direct = firstNonEmptyString(item.command, item.cmd);
  if (direct !== void 0)
    return direct;
  const argv = item.argv ?? item.command;
  if (Array.isArray(argv)) {
    const parts = argv.filter((part) => typeof part === "string");
    if (parts.length > 0)
      return parts.join(" ");
  }
  return void 0;
}
function codexFileChangeText(item) {
  const direct = firstNonEmptyString(item.path, item.file, item.summary);
  if (direct !== void 0)
    return direct;
  const changes = item.changes;
  if (Array.isArray(changes)) {
    const paths = [];
    for (const change of changes) {
      if (typeof change === "string")
        paths.push(change);
      else if (isRecord4(change)) {
        const p = firstNonEmptyString(change.path, change.file);
        if (p !== void 0)
          paths.push(p);
      }
    }
    if (paths.length > 0)
      return paths.join(", ");
  }
  return void 0;
}
function truncate3(text2, limit) {
  return text2.length <= limit ? text2 : `${text2.slice(0, limit - 1)}\u2026`;
}
function taskIdOf(event2, data) {
  return event2.taskId ?? stringOrUndefined(data.taskId) ?? "?";
}
function stringOrUndefined(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function firstLine(text2) {
  if (typeof text2 !== "string")
    return "(no summary)";
  const line = text2.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === void 0 ? "(no summary)" : truncate3(line, 120);
}
function ansi(code, text2, enabled) {
  return enabled ? `\x1B[${code}m${text2}\x1B[0m` : text2;
}
var EXIT_LABEL = {
  success: "success",
  partial: "partial",
  failed: "failed"
};
var TextRenderer = class {
  #output;
  #color;
  constructor(output = process.stdout) {
    this.#output = output;
    this.#color = "isTTY" in output && output.isTTY === true;
  }
  #write(line) {
    this.#output.write(`${line}
`);
  }
  #dim(text2) {
    return ansi("2", text2, this.#color);
  }
  #bold(text2) {
    return ansi("1", text2, this.#color);
  }
  emit(event2) {
    const data = isRecord4(event2.data) ? event2.data : {};
    if (event2.type.startsWith(CODEX_PREFIX)) {
      this.#emitCodex(data);
      return;
    }
    switch (event2.type) {
      case "model.turn.completed": {
        const text2 = typeof data.text === "string" ? data.text : "";
        if (text2 !== "")
          this.#write(text2);
        break;
      }
      case "tool.execution.started": {
        const tool = typeof data.tool === "string" ? data.tool : "?";
        this.#write(`${this.#dim("\u2192")} ${tool} ${this.#dim(previewInput(data.input))}`);
        break;
      }
      case "tool.execution.completed": {
        const ok = data.ok === true;
        const denied = data.denied === true;
        this.#write(ok ? "  \u2713" : `  \u2717 (${denied ? "denied" : "error"})`);
        break;
      }
      case "task.started":
      case "task.completed":
      case "task.escalated":
      case "task.cancelled":
      case "task.low_confidence":
        this.#emitTaskLifecycle(event2.type, taskIdOf(event2, data), data);
        break;
      case "worktree.created":
      case "worktree.integrated":
      case "worktree.removed":
        this.#emitWorktree(event2.type, taskIdOf(event2, data), data);
        break;
      case "validation.started":
      case "validation.completed":
        this.#emitValidation(event2.type, taskIdOf(event2, data), data);
        break;
      default:
        break;
    }
  }
  /**
   * Renders the scheduler's `task.*` events — the orchestration run's spine.
   *
   * These share the sink with the worker loop's own events, so a task line has
   * to be identifiable on its own: every one of them leads with the task id.
   */
  #emitTaskLifecycle(type, taskId, data) {
    switch (type) {
      case "task.started": {
        const agent = stringOrUndefined(data.agent) ?? "?";
        const attempt = typeof data.attempt === "number" ? data.attempt : 1;
        this.#write(`\u25B6 ${taskId} \u2192 ${agent} (attempt ${attempt})`);
        break;
      }
      case "task.completed": {
        const result = isRecord4(data.result) ? data.result : {};
        const ok = result.status === "success";
        const retrying = data.final === false;
        const suffix = retrying ? this.#dim(" (retrying)") : "";
        this.#write(`${ok ? "\u2714" : "\u2716"} ${taskId} \u2014 ${firstLine(result.summary)}${suffix}`);
        break;
      }
      case "task.escalated": {
        const from = stringOrUndefined(data.from) ?? "(unassigned)";
        const to = stringOrUndefined(data.to) ?? "?";
        this.#write(`\u2191 ${taskId} rerouted ${from} \u2192 ${to}`);
        break;
      }
      case "task.cancelled": {
        const reason = stringOrUndefined(data.reason) ?? "cancelled";
        this.#write(`\u2298 ${taskId} (${reason})`);
        break;
      }
      case "task.low_confidence": {
        const confidence = typeof data.confidence === "number" ? data.confidence : 0;
        const threshold = typeof data.threshold === "number" ? data.threshold : 0;
        const verdict = data.accepted === true ? "accepted (attempts exhausted)" : "redoing";
        this.#write(`\u21BB ${taskId} low confidence ${confidence.toFixed(2)} < ${threshold.toFixed(2)} \u2014 ${verdict}`);
        break;
      }
      default:
        break;
    }
  }
  /**
   * Renders the worktree isolation layer's `worktree.*` events.
   *
   * Only the moments that change what is in the repository get a line: a task
   * got its own checkout, its work landed (or did not), and a branch outlived
   * the run and is waiting for a human. A clean removal is the expected case
   * and stays silent.
   */
  #emitWorktree(type, taskId, data) {
    switch (type) {
      case "worktree.created": {
        const branch = stringOrUndefined(data.branch) ?? "?";
        this.#write(`\u2387 ${taskId} worktree created (${branch})`);
        break;
      }
      case "worktree.integrated": {
        if (data.merged === true) {
          const commit = stringOrUndefined(data.commit);
          const suffix = commit === void 0 ? "" : ` \u2192 ${commit.slice(0, 8)}`;
          this.#write(`\u21E1 ${taskId} merged${suffix}`);
          break;
        }
        const files = Array.isArray(data.conflictFiles) ? data.conflictFiles.filter((file) => typeof file === "string") : [];
        this.#write(files.length === 0 ? `\u26A0 ${taskId} not merged (${stringOrUndefined(data.reason) ?? "unknown reason"})` : `\u26A0 ${taskId} merge conflict: ${files.join(", ")}`);
        break;
      }
      case "worktree.removed": {
        if (data.keptBranch !== true)
          break;
        const branch = stringOrUndefined(data.branch) ?? "?";
        this.#write(this.#dim(`\u2387 ${taskId} branch kept: ${branch}`));
        break;
      }
      default:
        break;
    }
  }
  /**
   * Renders the `validation.*` events {@link ValidatingExecutor} emits around
   * each configured validator command.
   *
   * Kept quiet and dim on the way in — a validator starting is background
   * noise most of the time — but its result always lands, pass or fail, since
   * that is what decides whether the task's work is going to be kept.
   */
  #emitValidation(type, taskId, data) {
    switch (type) {
      case "validation.started": {
        const name = stringOrUndefined(data.name) ?? "?";
        this.#write(this.#dim(`\u2699 ${taskId} validator ${name}\u2026`));
        break;
      }
      case "validation.completed": {
        const name = stringOrUndefined(data.name) ?? "?";
        const passed = data.passed === true;
        const seconds = typeof data.durationMs === "number" ? data.durationMs / 1e3 : 0;
        const duration = `${seconds.toFixed(1)}s`;
        if (passed) {
          this.#write(`  \u2713 ${name} (${duration})`);
          break;
        }
        const exitCode = typeof data.exitCode === "number" ? String(data.exitCode) : "unknown";
        this.#write(`  \u2717 ${name} (exit ${exitCode}, ${duration})`);
        break;
      }
      default:
        break;
    }
  }
  /**
   * Renders a normalized `codex.*` event. Only `item.*` events whose nested
   * item is `agent_message` / `command_execution` / `file_change` produce
   * output — everything else (`turn.completed` usage rollups, the synthetic
   * `codex.completed` marker, and any event type this wrapper doesn't
   * recognize yet) stays quiet, matching the native renderer's silence on
   * unknown event types.
   */
  #emitCodex(data) {
    const item = codexItemFrom(data);
    if (item === void 0)
      return;
    const itemType = typeof item.type === "string" ? item.type : void 0;
    switch (itemType) {
      case "agent_message": {
        const text2 = codexMessageText(item);
        if (text2 !== void 0 && text2.trim() !== "")
          this.#write(text2);
        break;
      }
      case "command_execution": {
        const command = codexCommandText(item);
        if (command !== void 0) {
          this.#write(`\u2192 codex: ${truncate3(command, 120)}`);
        }
        break;
      }
      case "file_change": {
        const summary = codexFileChangeText(item);
        if (summary !== void 0)
          this.#write(`\u270E ${summary}`);
        break;
      }
      default:
        break;
    }
  }
  result(result, usage) {
    this.#write("");
    this.#write(this.#bold(`status: ${EXIT_LABEL[result.status]}`));
    this.#write(result.summary);
    if (isCodexResult(result)) {
      if (result.exitCode !== null && result.exitCode !== 0) {
        this.#write(this.#dim(`exit code: ${result.exitCode}`));
      }
      if (result.usage !== void 0) {
        this.#write(this.#dim(`tokens \u2014 input: ${result.usage.inputTokens}, output: ${result.usage.outputTokens}`));
      }
      return;
    }
    this.#write(this.#dim(`iterations: ${result.iterations}  tool calls: ${result.toolCalls}`));
    const { usage: totals, costUsd } = usage;
    const tokenParts = [
      `input: ${totals.inputTokens}`,
      `output: ${totals.outputTokens}`
    ];
    if (totals.cachedInputTokens !== void 0) {
      tokenParts.push(`cached: ${totals.cachedInputTokens}`);
    }
    let usageLine2 = `tokens \u2014 ${tokenParts.join(", ")}`;
    if (costUsd > 0)
      usageLine2 += `  (~$${costUsd.toFixed(4)})`;
    this.#write(this.#dim(usageLine2));
  }
};
var JsonRenderer = class {
  #output;
  constructor(output = process.stdout) {
    this.#output = output;
  }
  emit(event2) {
    this.#output.write(`${JSON.stringify(event2)}
`);
  }
  result(result, usage) {
    const trackerIsEmpty = usage.usage.inputTokens === 0 && usage.usage.outputTokens === 0;
    const reported = trackerIsEmpty && "usage" in result && result.usage !== void 0 ? result.usage : usage.usage;
    const line = {
      type: "result",
      ...result,
      usage: reported,
      costUsd: usage.costUsd
    };
    this.#output.write(`${JSON.stringify(line)}
`);
  }
};

// apps/cli/dist/run.js
function defaultSystemPrompt(workspaceRoot) {
  return [
    `You are a coding agent operating in the repository at ${workspaceRoot}.`,
    "Use the provided tools to inspect and modify the repository; you cannot",
    "see or touch anything outside of it.",
    "",
    "Guidelines:",
    "- Refer to files by their path relative to the workspace root.",
    "- Read enough of the surrounding code to understand context before editing.",
    "- Prefer minimal, targeted changes over broad rewrites.",
    "- When useful, run relevant checks (build, lint, tests) via the bash tool",
    "  to verify your changes.",
    "- Finish by giving a short summary of what changed and why."
  ].join("\n");
}
function errorMessage6(error) {
  return error instanceof Error ? error.message : String(error);
}
async function resolveModelAndProvider(env, alias) {
  const registry = await buildRegistry(env);
  let model;
  try {
    model = registry.get(alias);
  } catch (error) {
    return { error: errorMessage6(error) };
  }
  try {
    const provider = registry.providerFor(model);
    return { model, provider };
  } catch {
    const hint = credentialHintForProvider(model.provider);
    return {
      error: `Model "${alias}" requires the "${model.provider}" provider, which is not configured: ${hint}.`
    };
  }
}
async function runObjective(objective, options) {
  const workspacePath = path2.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const alias = resolveModelAlias(process.env, options.model);
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved) {
    console.error(resolved.error);
    return 1;
  }
  const { model, provider } = resolved;
  const renderer = options.json ? new JsonRenderer() : new TextRenderer();
  const promptState = createPromptState();
  const prompter = createPrompter({
    yes: options.yes,
    interactive: process.stdin.isTTY === true && !options.json,
    state: promptState
  });
  const permissions = new PermissionEngine(DEFAULT_PERMISSIONS, {
    defaultDecision: "ask",
    ...prompter === void 0 ? {} : { prompter }
  });
  const usage = new UsageTracker();
  const agent = {
    name: "agent",
    role: "worker",
    model,
    systemPrompt: options.system ?? defaultSystemPrompt(workspacePath),
    tools: builtinTools().map((tool) => tool.name),
    permissions: DEFAULT_PERMISSIONS
  };
  const controller = new AbortController();
  const onSigint = () => {
    if (promptState.active)
      return;
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    const loop = new AgentLoop({
      agent,
      provider,
      tools: builtinTools(),
      permissions,
      usage,
      events: renderer,
      maxIterations: options.maxIterations,
      ...options.timeoutSeconds === void 0 ? {} : { timeoutMs: options.timeoutSeconds * 1e3 }
    });
    const result = await loop.run({ instruction: objective }, {
      runId: crypto.randomUUID(),
      workspacePath,
      signal: controller.signal
    });
    const totals = usage.totals();
    renderer.result(result, totals);
    if (result.status === "success")
      return 0;
    if (result.status === "partial")
      return 2;
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// apps/cli/dist/plan.js
var consoleOutput = {
  log: (line) => console.log(line),
  error: (line) => console.error(line)
};
var defaultPlannerFactory = (args) => new LlmPlanner(args);
var LOCK_FILE_NAME = "orchestration.lock.json";
function jsonLine(output, value) {
  output.log(JSON.stringify(value));
}
function fail(output, json, message, extra = {}) {
  if (json)
    jsonLine(output, { ok: false, error: message, ...extra });
  else
    output.error(message);
  return { exitCode: 1 };
}
function errorMessage7(error) {
  return error instanceof Error ? error.message : String(error);
}
async function readOptionalFile(filePath) {
  try {
    return await readFile8(filePath, "utf8");
  } catch {
    return void 0;
  }
}
function printBulletList(output, label, items) {
  if (items.length === 0)
    return;
  output.log(`${label}:`);
  for (const item of items)
    output.log(`  - ${item}`);
}
function formatTable(headers, rows) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const render2 = (cells) => cells.map((cell, column) => column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  return [render2(headers), ...rows.map(render2)];
}
async function resolvePlannerModel(project, policy, options, output) {
  if (options.model === void 0 || options.model === "") {
    try {
      const orchestrator = project.agent(policy.orchestrator);
      if (orchestrator === void 0) {
        throw new Error(`the policy's orchestrator "${policy.orchestrator}" is not one of this project's agents`);
      }
      const resolve5 = await createProjectModelResolver(project, process.env);
      const resolved = resolve5(orchestrator.modelAlias);
      return { model: resolved.model, provider: resolved.provider };
    } catch (error) {
      output.error(`Note: planning with the default model instead of the orchestrator agent "${policy.orchestrator}" \u2014 ${errorMessage7(error)}`);
    }
  }
  const alias = resolveModelAlias(process.env, options.model);
  return resolveModelAndProvider(process.env, alias);
}
async function preparePlan(objective, options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const { json } = options;
  const workspacePath = path3.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  let project;
  try {
    project = await loadAgentProject(workspacePath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      return fail(output, json, error.message, {
        file: error.file,
        problems: error.problems
      });
    }
    throw error;
  }
  if (project === void 0) {
    return fail(output, json, "No .agent directory found \u2014 run `kapel init` first");
  }
  const markdown = project.orchestrationMarkdown;
  if (markdown === void 0 || markdown.trim() === "") {
    return fail(output, json, "No orchestration policy found \u2014 .agent/orchestration.md is missing or empty");
  }
  const lockPath = path3.join(project.root, LOCK_FILE_NAME);
  const status = checkLock(markdown, await readOptionalFile(lockPath));
  if (!status.fresh) {
    if (status.reason === "missing") {
      return fail(output, json, `No policy lock found at ${lockPath}. Run \`kapel policy compile\` before planning.`, { reason: status.reason });
    }
    if (status.reason === "stale-source") {
      return fail(output, json, "orchestration.md has changed since the policy lock was compiled. Run `kapel policy compile` to refresh it before planning.", { reason: status.reason });
    }
    return fail(output, json, `Invalid policy lock at ${lockPath}: ${status.detail ?? "unknown error"}. Run \`kapel policy compile\` to recreate it.`, { reason: status.reason });
  }
  const policy = status.lock.policy;
  const resolved = await resolvePlannerModel(project, policy, options, output);
  if ("error" in resolved)
    return fail(output, json, resolved.error);
  const { model, provider } = resolved;
  const knownAgents = [...project.knownAgentNames()];
  const plannerFactory = deps.plannerFactory ?? defaultPlannerFactory;
  const planner = plannerFactory({ provider, model, knownAgents });
  let planned;
  try {
    planned = await planner.plan(objective, policy);
  } catch (error) {
    if (error instanceof PlanError) {
      const issues = (error.lastIssues ?? []).map((issue) => `${issue.path}: ${issue.message}`);
      if (json) {
        jsonLine(output, {
          ok: false,
          error: error.message,
          attempts: error.attempts,
          issues
        });
      } else {
        output.error(error.message);
        output.error(`Attempts: ${error.attempts}`);
        for (const issue of issues)
          output.error(`  - ${issue}`);
      }
      return { exitCode: 1 };
    }
    throw error;
  }
  const rewrite = applyPolicyToPlan(planned, policy, project.knownAgentNames());
  if (rewrite.issues.length > 0) {
    if (json) {
      jsonLine(output, {
        ok: false,
        error: "The plan cannot be executed under this policy.",
        issues: rewrite.issues,
        notes: rewrite.notes
      });
    } else {
      output.error("The plan cannot be executed under this policy:");
      for (const issue of rewrite.issues)
        output.error(`  - ${issue}`);
    }
    return { exitCode: 1 };
  }
  const router = new PolicyRouter();
  const routes = {};
  for (const task of rewrite.plan.tasks) {
    routes[task.id] = router.route(task, policy);
  }
  return {
    project,
    workspacePath,
    policy,
    plan: rewrite.plan,
    injectedReviews: rewrite.injectedReviews,
    notes: rewrite.notes,
    routes,
    plannerModel: model
  };
}
function taskRow(task, routes) {
  return [
    task.id,
    task.type,
    task.complexity,
    routes[task.id] ?? "?",
    task.dependencies.length === 0 ? "-" : task.dependencies.join(","),
    task.title
  ];
}
function renderPlan(prepared, output, json) {
  if (json) {
    jsonLine(output, {
      plan: prepared.plan,
      injectedReviews: prepared.injectedReviews,
      notes: prepared.notes,
      routes: prepared.routes
    });
    return;
  }
  output.log(`Objective: ${prepared.plan.objective}`);
  output.log(`Planner: ${prepared.plannerModel.id} (${prepared.plannerModel.provider})`);
  output.log(`Tasks: ${prepared.plan.tasks.length} (max concurrency ${prepared.policy.maxConcurrency})`);
  output.log("");
  const lines = formatTable(["ID", "TYPE", "COMPLEXITY", "AGENT", "DEPS", "TITLE"], prepared.plan.tasks.map((task) => taskRow(task, prepared.routes)));
  for (const line of lines)
    output.log(line);
  if (prepared.injectedReviews.length > 0) {
    output.log("");
    output.log(`Injected reviews: ${prepared.injectedReviews.join(", ")}`);
  }
  if (prepared.notes.length > 0) {
    output.log("");
    printBulletList(output, "Notes", prepared.notes);
  }
}
async function runPlan(objective, options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const prepared = await preparePlan(objective, options, deps);
  if ("exitCode" in prepared)
    return prepared.exitCode;
  renderPlan(prepared, output, options.json);
  return 0;
}

// apps/cli/dist/sessions.js
import { existsSync } from "node:fs";
import path4 from "node:path";

// packages/session/dist/schema.js
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
var RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled"
];
var TASK_RESULT_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "partial",
  "cancelled"
];
var runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  objective: text("objective").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  status: text("status", { enum: RUN_STATUSES }).notNull(),
  policyJson: text("policy_json").notNull(),
  planJson: text("plan_json")
});
var events = sqliteTable("events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  timestamp: integer("timestamp").notNull(),
  type: text("type").notNull(),
  taskId: text("task_id"),
  workerId: text("worker_id"),
  dataJson: text("data_json")
}, (table) => [
  index("events_run_id_idx").on(table.runId),
  index("events_run_id_type_idx").on(table.runId, table.type)
]);
var taskResults = sqliteTable("task_results", {
  runId: text("run_id").notNull(),
  taskId: text("task_id").notNull(),
  agent: text("agent"),
  attempts: integer("attempts").notNull(),
  status: text("status", { enum: TASK_RESULT_STATUSES }).notNull(),
  resultJson: text("result_json"),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.runId, table.taskId] }),
  index("task_results_run_id_idx").on(table.runId)
]);
var BOOTSTRAP_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  plan_json TEXT
);
CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs (created_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  task_id TEXT,
  worker_id TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS events_run_id_idx ON events (run_id);
CREATE INDEX IF NOT EXISTS events_run_id_type_idx ON events (run_id, type);
CREATE INDEX IF NOT EXISTS events_run_id_task_id_idx ON events (run_id, task_id);

CREATE TABLE IF NOT EXISTS task_results (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent TEXT,
  attempts INTEGER NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, task_id)
);
CREATE INDEX IF NOT EXISTS task_results_run_id_idx ON task_results (run_id);
`;
var eventRowid = sql`rowid`;

// packages/session/dist/sqlite.js
import { join as join7 } from "node:path";
import Database from "better-sqlite3";
import { and, asc, desc, eq, sql as sql2 } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
function defaultSessionDbPath(agentDir) {
  return join7(agentDir, "sessions.db");
}
function parseJson(raw) {
  if (raw === null || raw === void 0)
    return void 0;
  try {
    return JSON.parse(raw);
  } catch {
    return void 0;
  }
}
function stringifyJson(value) {
  if (value === void 0)
    return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded === void 0 ? null : encoded;
  } catch {
    return null;
  }
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function asString(value) {
  return typeof value === "string" ? value : void 0;
}
function asAttempts(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : void 0;
}
var TASK_RESULT_STATUSES2 = /* @__PURE__ */ new Set([
  "pending",
  "running",
  "success",
  "failed",
  "partial",
  "cancelled"
]);
function toTaskResultStatus(value) {
  return typeof value === "string" && TASK_RESULT_STATUSES2.has(value) ? value : void 0;
}
function taskResultPatchFor(event2) {
  const data = asRecord(event2.data);
  switch (event2.type) {
    case "task.started": {
      const agent = asString(data?.agent);
      const attempts = asAttempts(data?.attempts) ?? asAttempts(data?.attempt);
      return {
        status: "running",
        ...agent === void 0 ? {} : { agent },
        ...attempts === void 0 ? {} : { attempts }
      };
    }
    case "task.completed": {
      const agent = asString(data?.agent);
      const attempts = asAttempts(data?.attempts) ?? asAttempts(data?.attempt);
      const result = asRecord(data?.result);
      const status = toTaskResultStatus(result?.status);
      return {
        ...status === void 0 ? {} : { status },
        ...agent === void 0 ? {} : { agent },
        ...attempts === void 0 ? {} : { attempts },
        ...result === void 0 ? {} : { resultJson: stringifyJson(result) }
      };
    }
    case "task.escalated": {
      const agent = asString(data?.to);
      return agent === void 0 ? {} : { agent };
    }
    case "task.cancelled":
      return { status: "cancelled" };
    default:
      return void 0;
  }
}
var SqliteSessionStore = class {
  #sqlite;
  #db;
  constructor(options) {
    this.#sqlite = new Database(options.path);
    if (options.path !== ":memory:") {
      this.#sqlite.pragma("journal_mode = WAL");
    }
    this.#sqlite.exec(BOOTSTRAP_DDL);
    this.#db = drizzle(this.#sqlite);
  }
  // --- SessionStore -------------------------------------------------------
  async createRun(run) {
    this.#db.insert(runs).values({
      id: run.id,
      objective: run.objective,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      status: "running",
      policyJson: stringifyJson(run.policySnapshot) ?? "null",
      planJson: null
    }).onConflictDoNothing().run();
  }
  /**
   * Appends an event and folds it into `task_results` in one transaction, so
   * a reader never sees an event whose task summary has not landed yet.
   */
  async appendEvent(event2) {
    const patch = event2.taskId === void 0 ? void 0 : taskResultPatchFor(event2);
    const taskId = event2.taskId;
    this.#db.transaction((tx) => {
      tx.insert(events).values({
        id: event2.id,
        runId: event2.runId,
        timestamp: event2.timestamp,
        type: event2.type,
        taskId: event2.taskId ?? null,
        workerId: event2.workerId ?? null,
        dataJson: stringifyJson(event2.data)
      }).onConflictDoNothing().run();
      if (patch === void 0 || taskId === void 0)
        return;
      tx.insert(taskResults).values({
        runId: event2.runId,
        taskId,
        agent: patch.agent ?? null,
        attempts: patch.attempts ?? 0,
        status: patch.status ?? "pending",
        resultJson: patch.resultJson ?? null,
        updatedAt: event2.timestamp
      }).onConflictDoUpdate({
        target: [taskResults.runId, taskResults.taskId],
        set: {
          updatedAt: event2.timestamp,
          ...patch.agent === void 0 ? {} : { agent: patch.agent },
          ...patch.attempts === void 0 ? {} : { attempts: patch.attempts },
          ...patch.status === void 0 ? {} : { status: patch.status },
          ...patch.resultJson === void 0 ? {} : { resultJson: patch.resultJson }
        }
      }).run();
    });
  }
  async listEvents(runId) {
    const rows = this.#db.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.timestamp), asc(eventRowid)).all();
    return rows.map(toAgentEvent);
  }
  // --- Extensions ---------------------------------------------------------
  async savePlan(runId, plan) {
    this.#db.update(runs).set({ planJson: stringifyJson(plan), updatedAt: Date.now() }).where(eq(runs.id, runId)).run();
  }
  async setRunStatus(runId, status) {
    this.#db.update(runs).set({ status, updatedAt: Date.now() }).where(eq(runs.id, runId)).run();
  }
  async getRun(runId) {
    const row = this.#db.select().from(runs).where(eq(runs.id, runId)).limit(1).get();
    if (row === void 0)
      return void 0;
    const policy = parseJson(row.policyJson);
    const plan = parseJson(row.planJson);
    return {
      id: row.id,
      objective: row.objective,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      status: row.status,
      // A corrupt policy blob must not make the run unreadable; callers get
      // an empty object rather than a throw from deep inside a read path.
      policy: policy ?? {},
      ...plan === void 0 ? {} : { plan }
    };
  }
  async listRuns(options) {
    const limit = options?.limit;
    const base = this.#db.select({
      id: runs.id,
      objective: runs.objective,
      createdAt: runs.createdAt,
      status: runs.status,
      planJson: runs.planJson
    }).from(runs).orderBy(desc(runs.createdAt), desc(runs.id));
    const rows = limit === void 0 ? base.all() : base.limit(Math.max(0, limit)).all();
    return rows.map((row) => {
      const counts = this.#db.select({ status: taskResults.status, n: sql2`count(*)` }).from(taskResults).where(eq(taskResults.runId, row.id)).groupBy(taskResults.status).all();
      const by = new Map(counts.map((c) => [c.status, Number(c.n)]));
      const total = parseJson(row.planJson)?.tasks?.length;
      return {
        id: row.id,
        objective: row.objective,
        createdAt: row.createdAt,
        status: row.status,
        taskCounts: {
          completed: by.get("success") ?? 0,
          failed: by.get("failed") ?? 0,
          cancelled: by.get("cancelled") ?? 0,
          ...typeof total === "number" ? { total } : {}
        }
      };
    });
  }
  async taskResults(runId) {
    const rows = this.#db.select().from(taskResults).where(eq(taskResults.runId, runId)).orderBy(asc(taskResults.taskId)).all();
    const out = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const result = parseJson(row.resultJson);
      out.set(row.taskId, {
        taskId: row.taskId,
        attempts: row.attempts,
        status: row.status,
        ...row.agent === null ? {} : { agent: row.agent },
        ...result === void 0 ? {} : { result }
      });
    }
    return out;
  }
  async taskEvents(runId, taskId) {
    const rows = this.#db.select().from(events).where(and(eq(events.runId, runId), eq(events.taskId, taskId))).orderBy(asc(events.timestamp), asc(eventRowid)).all();
    return rows.map(toAgentEvent);
  }
  close() {
    this.#sqlite.close();
  }
};
function toAgentEvent(row) {
  const data = parseJson(row.dataJson);
  return {
    id: row.id,
    runId: row.runId,
    timestamp: row.timestamp,
    type: row.type,
    ...row.taskId === null ? {} : { taskId: row.taskId },
    ...row.workerId === null ? {} : { workerId: row.workerId },
    ...data === void 0 ? {} : { data }
  };
}
async function reconstructRun(store, runId) {
  const run = await store.getRun(runId);
  if (run === void 0)
    return void 0;
  const persisted = await store.taskResults(runId);
  const completed = /* @__PURE__ */ new Map();
  for (const [taskId, entry] of persisted) {
    if (entry.status !== "success" || entry.result === void 0)
      continue;
    completed.set(taskId, entry.result);
  }
  const planned = run.plan?.tasks ?? [];
  const incompleteTaskIds = planned.map((task) => task.id).filter((id) => !completed.has(id));
  return { run, completed, incompleteTaskIds };
}

// apps/cli/dist/sessions.js
function fanOutSink(...sinks) {
  const active = sinks.filter((sink) => sink !== void 0);
  return {
    emit(event2) {
      const pending = [];
      for (const sink of active) {
        try {
          const settled = sink.emit(event2);
          if (settled !== void 0) {
            pending.push(Promise.resolve(settled).then(() => void 0, () => void 0));
          }
        } catch {
        }
      }
      if (pending.length === 0)
        return void 0;
      return Promise.all(pending).then(() => void 0);
    }
  };
}
function storeSink(store) {
  return {
    emit(event2) {
      return store.appendEvent(event2).then(() => void 0, () => void 0);
    }
  };
}
function sessionDbPathFor(workspacePath) {
  return defaultSessionDbPath(path4.join(path4.resolve(workspacePath), ".agent"));
}
async function openRunStore(workspacePath) {
  const agentDir = await findAgentDir(path4.resolve(workspacePath));
  if (agentDir === void 0)
    return void 0;
  try {
    return new SqliteSessionStore({ path: defaultSessionDbPath(agentDir) });
  } catch {
    return void 0;
  }
}
function openExistingRunStore(workspacePath) {
  const dbPath = sessionDbPathFor(workspacePath);
  if (!existsSync(dbPath))
    return void 0;
  try {
    return new SqliteSessionStore({ path: dbPath });
  } catch {
    return void 0;
  }
}
function runStatusFor(tasks, aborted) {
  if (aborted)
    return "cancelled";
  return tasks.every((task) => task.status === "completed") ? "completed" : "failed";
}
async function bestEffort(action) {
  try {
    await action();
  } catch {
  }
}
async function recordRunStatus(store, runId, status) {
  if (store === void 0)
    return;
  await bestEffort(() => store.setRunStatus(runId, status));
}
function closeRunStore(store) {
  if (store === void 0)
    return;
  try {
    store.close();
  } catch {
  }
}
function isoTime(epochMs) {
  return new Date(epochMs).toISOString();
}

// apps/cli/dist/explain-cmd.js
function isRecord5(value) {
  return typeof value === "object" && value !== null;
}
function str(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function firstLine2(text2) {
  if (typeof text2 !== "string")
    return "(no summary)";
  const line = text2.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === void 0 ? "(no summary)" : line;
}
function ruleMatches3(rule, task) {
  const matches2 = (expected, actual) => {
    if (expected.length === 0)
      return true;
    const values = typeof actual === "string" ? [actual] : actual;
    return expected.some((value) => values.includes(value));
  };
  return matches2(rule.taskTypes, task.type) && matches2(rule.riskCategories, task.risk.categories) && matches2(rule.complexity, task.complexity);
}
function winningRule(task, policy) {
  const candidates = (policy.routing ?? []).filter((rule) => ruleMatches3(rule, task));
  const hard = candidates.filter((rule) => rule.strength === "hard");
  const pool = hard.length > 0 ? hard : candidates;
  return [...pool].sort((a, b) => a.weight !== b.weight ? b.weight - a.weight : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
}
function explainRoute(task, policy) {
  const agent = new PolicyRouter().route(task, policy);
  const rule = winningRule(task, policy);
  if (rule !== void 0)
    return { agent, rule: rule.id };
  return {
    agent,
    fallback: task.suggestedAgent === void 0 ? "orchestrator" : "suggestedAgent"
  };
}
function routeSentence(route) {
  if (route.rule !== void 0) {
    return `routed to ${route.agent} by rule ${route.rule}`;
  }
  return route.fallback === "suggestedAgent" ? `routed to ${route.agent} \u2014 no routing rule matched, so the plan's suggestedAgent was used` : `routed to ${route.agent} \u2014 no routing rule matched and the task suggested no agent, so it fell back to the policy's orchestrator`;
}
function digestEvent(event2) {
  const data = isRecord5(event2.data) ? event2.data : {};
  switch (event2.type) {
    case "task.held": {
      const blocker = str(data.conflictsWith);
      return blocker === void 0 ? "held \u2014 waiting for a free slot" : `held \u2014 serialized behind ${blocker} (their affected areas overlap)`;
    }
    case "task.started":
      return `started \u2014 agent ${str(data.agent) ?? "?"}, attempt ${num(data.attempt) ?? 1}`;
    case "task.escalated":
      return `escalated \u2014 ${str(data.from) ?? "(unassigned)"} \u2192 ${str(data.to) ?? "?"} by rule ${str(data.rule) ?? "?"}`;
    case "task.low_confidence": {
      const confidence = num(data.confidence) ?? 0;
      const threshold = num(data.threshold) ?? 0;
      const verdict = data.accepted === true ? "accepted (attempts exhausted)" : "redoing";
      return `low confidence \u2014 ${confidence.toFixed(2)} < ${threshold.toFixed(2)}, ${verdict}`;
    }
    case "validation.completed": {
      if (data.passed === true)
        return void 0;
      const exitCode = num(data.exitCode);
      return `validator failed \u2014 ${str(data.name) ?? "?"} (exit ${exitCode === void 0 ? "unknown" : exitCode})`;
    }
    case "worktree.integrated": {
      if (data.merged === true) {
        const commit = str(data.commit);
        return `merged${commit === void 0 ? "" : ` \u2192 ${commit.slice(0, 8)}`}`;
      }
      const files = Array.isArray(data.conflictFiles) ? data.conflictFiles.filter((file) => typeof file === "string") : [];
      return files.length === 0 ? `not merged \u2014 ${str(data.reason) ?? "unknown reason"}` : `not merged \u2014 conflicts in ${files.join(", ")}`;
    }
    case "task.completed": {
      const result = isRecord5(data.result) ? data.result : {};
      const status = str(result.status) ?? "?";
      const retrying = data.final === false ? " (retrying)" : "";
      return `completed \u2014 ${status}: ${firstLine2(result.summary)}${retrying}`;
    }
    case "task.cancelled":
      return `cancelled \u2014 ${str(data.reason) ?? "cancelled"}`;
    default:
      return void 0;
  }
}
function digestEvents(events2) {
  const digest = [];
  for (const event2 of events2) {
    const detail = digestEvent(event2);
    if (detail === void 0)
      continue;
    digest.push({ timestamp: event2.timestamp, type: event2.type, detail });
  }
  return digest;
}
async function resolveRun(store, runId) {
  if (runId !== void 0)
    return store.getRun(runId);
  const [latest] = await store.listRuns({ limit: 1 });
  return latest === void 0 ? void 0 : store.getRun(latest.id);
}
function renderText(output, run, taskId, spec, entry, route, digest) {
  output.log(spec === void 0 ? `Task ${taskId}` : `Task ${taskId} \u2014 ${spec.title}`);
  output.log(`Run ${run.id} (started ${isoTime(run.createdAt)}, ${run.status})`);
  const agent = entry?.agent ?? "(never dispatched)";
  const attempts = entry?.attempts ?? 0;
  const status = entry?.status ?? "unknown";
  output.log(`Agent: ${agent} \u2014 ${attempts} attempt${attempts === 1 ? "" : "s"}, ${status}`);
  output.log(route === void 0 ? "Routing: unavailable \u2014 this run has no saved plan to re-route from" : `Routing: ${routeSentence(route)}`);
  output.log("");
  if (digest.length === 0) {
    output.log("No decisions were recorded for this task.");
    return;
  }
  for (const item of digest) {
    output.log(`${isoTime(item.timestamp)}  ${item.detail}`);
  }
}
async function runExplainCommand(taskId, options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const fail2 = (message) => {
    if (options.json)
      output.log(JSON.stringify({ ok: false, error: message }));
    else
      output.error(message);
    return 1;
  };
  const store = openExistingRunStore(options.cwd);
  if (store === void 0) {
    return fail2(`No runs recorded yet \u2014 nothing at ${sessionDbPathFor(options.cwd)}.`);
  }
  try {
    const run = await resolveRun(store, options.run);
    if (run === void 0) {
      return fail2(options.run === void 0 ? "No runs recorded yet." : `Unknown run ${options.run}. Run \`kapel runs\` to see the recorded ones.`);
    }
    const spec = run.plan?.tasks.find((task) => task.id === taskId);
    const results = await store.taskResults(run.id);
    const entry = results.get(taskId);
    const events2 = await store.taskEvents(run.id, taskId);
    if (spec === void 0 && entry === void 0 && events2.length === 0) {
      const known = run.plan?.tasks.map((task) => task.id) ?? [
        ...results.keys()
      ];
      return fail2(`Run ${run.id} has no task ${taskId}.${known.length === 0 ? "" : ` Known tasks: ${known.join(", ")}.`}`);
    }
    const route = spec === void 0 ? void 0 : explainRoute(spec, run.policy);
    const digest = digestEvents(events2);
    if (options.json) {
      output.log(JSON.stringify({
        task: spec ?? { id: taskId },
        agent: entry?.agent ?? null,
        attempts: entry?.attempts ?? 0,
        status: entry?.status ?? null,
        run: { id: run.id, status: run.status, createdAt: run.createdAt },
        events: digest,
        route: route ?? null
      }));
      return 0;
    }
    renderText(output, run, taskId, spec, entry, route, digest);
    return 0;
  } finally {
    closeRunStore(store);
  }
}

// apps/cli/dist/init.js
import { cp, rm as rm2, stat as stat4 } from "node:fs/promises";
import path5 from "node:path";
import { fileURLToPath } from "node:url";
var TEMPLATE_RELATIVE = ["templates", "default", ".agent"];
var MAX_WALK_LEVELS = 6;
async function pathExists(candidate) {
  try {
    await stat4(candidate);
    return true;
  } catch {
    return false;
  }
}
async function locateTemplate(startDir, maxLevels = MAX_WALK_LEVELS) {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level += 1) {
    const candidate = path5.join(dir, ...TEMPLATE_RELATIVE);
    if (await pathExists(candidate))
      return candidate;
    const parent = path5.dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  throw new Error(`Could not find ${TEMPLATE_RELATIVE.join("/")} by walking up from ${startDir} (searched ${maxLevels} levels up). Is this CLI running from within the multi-model-orchestration-agent repo?`);
}
async function runInit(options) {
  const entryDir = path5.dirname(fileURLToPath(options.entryUrl ?? import.meta.url));
  let templateDir;
  try {
    templateDir = await locateTemplate(entryDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const target = path5.join(options.cwd, ".agent");
  const exists = await pathExists(target);
  if (exists && options.force !== true) {
    console.error(`${target} already exists. Re-run with --force to overwrite it.`);
    return 1;
  }
  if (exists)
    await rm2(target, { recursive: true, force: true });
  await cp(templateDir, target, { recursive: true });
  console.log(`Created ${target}`);
  console.log(`  (from ${templateDir})`);
  return 0;
}

// apps/cli/dist/orchestrate.js
import { execFile as execFile7 } from "node:child_process";
import { resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { promisify as promisify5 } from "node:util";
var WORKER_MODES = ["in-process", "child"];
var DEFAULT_WORKER_MODE = "in-process";
function validateWorkerMode(raw) {
  if (WORKER_MODES.includes(raw))
    return raw;
  throw new Error(`Invalid --worker-mode value "${raw}": expected one of ${WORKER_MODES.join(", ")}.`);
}
var ISOLATION_MODES = ["worktree", "none"];
var DEFAULT_ISOLATION = "worktree";
function validateIsolation(raw) {
  if (ISOLATION_MODES.includes(raw))
    return raw;
  throw new Error(`Invalid --isolation value "${raw}": expected one of ${ISOLATION_MODES.join(", ")}.`);
}
var execFileAsync5 = promisify5(execFile7);
async function worktreeIsolationError(workspacePath) {
  try {
    await execFileAsync5("git", ["rev-parse", "HEAD"], { cwd: workspacePath });
    return void 0;
  } catch {
    return `--isolation worktree needs ${workspacePath} to be a git repository with at least one commit, and \`git rev-parse HEAD\` failed there. Commit something first, or re-run with --isolation none.`;
  }
}
function cliEntryPath() {
  return fileURLToPath2(new URL("./index.js", import.meta.url));
}
async function workspaceExecutorFactory(args) {
  const { runId, events: events2, taskTimeoutMs } = args;
  if (args.backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    if (!availability.installed) {
      throw new Error(codexInstallGuidance(availability));
    }
    if (!availability.loggedIn) {
      throw new Error(codexLoginGuidance(availability));
    }
    return (workspacePath) => new CodexWorkerExecutor({
      workspacePath,
      runId,
      events: events2,
      ...taskTimeoutMs === void 0 ? {} : { taskTimeoutMs }
    });
  }
  if (args.workerMode === "child") {
    return (workspacePath) => new ChildProcessWorkerExecutor({
      command: [process.execPath, cliEntryPath(), "worker"],
      runId,
      workspacePath,
      events: events2,
      ...taskTimeoutMs === void 0 ? {} : { taskTimeoutMs }
    });
  }
  const resolveModel = await createProjectModelResolver(args.project, process.env);
  return (workspacePath) => new AgentLoopWorkerExecutor({
    project: args.project,
    resolveModel,
    workspacePath,
    runId,
    events: events2,
    usage: args.usage,
    ...taskTimeoutMs === void 0 ? {} : { taskTimeoutMs },
    ...args.maxIterations === void 0 ? {} : { maxIterations: args.maxIterations }
  });
}
function shouldRunValidators(project, backend, validate) {
  return backend !== "codex" && validate && project.config.validators.length > 0;
}
function withValidation(base, args) {
  if (!shouldRunValidators(args.project, args.backend, args.validate)) {
    return base;
  }
  const validators = args.project.config.validators;
  return (workspacePath) => new ValidatingExecutor({
    inner: base(workspacePath),
    validators,
    workspacePath,
    events: args.events,
    runId: args.runId
  });
}
var defaultExecutorFactory = async (args) => {
  const base = args.baseExecutorFactory ?? await workspaceExecutorFactory(args);
  const createExecutor = withValidation(base, args);
  if (args.isolation === "none")
    return createExecutor(args.workspacePath);
  return new WorktreeIsolatedExecutor({
    repoRoot: args.workspacePath,
    createExecutor,
    events: args.events,
    runId: args.runId
  });
};
var defaultTuiFactory = async (init) => {
  const { startOrchestrationTui: startOrchestrationTui2 } = await Promise.resolve().then(() => (init_dist(), dist_exports));
  return startOrchestrationTui2(init);
};
function jsonLine2(output, value) {
  output.log(JSON.stringify(value));
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function tuiJsonConflict(options) {
  return options.tui === true && options.json ? "--tui cannot be combined with --json: the dashboard owns the terminal, so there is nowhere for the JSON stream to go. Pick one." : void 0;
}
function usageLine(totals) {
  const parts = [
    `input: ${totals.usage.inputTokens}`,
    `output: ${totals.usage.outputTokens}`
  ];
  if (totals.usage.cachedInputTokens !== void 0) {
    parts.push(`cached: ${totals.usage.cachedInputTokens}`);
  }
  const line = `tokens \u2014 ${parts.join(", ")}`;
  return totals.costUsd > 0 ? `${line}  (~$${totals.costUsd.toFixed(4)})` : line;
}
function summaryRow(task) {
  return [
    task.status,
    task.spec.id,
    task.assignedAgent ?? "-",
    String(task.attempts),
    task.spec.title
  ];
}
function renderRunSummary(runId, tasks, totals, output, json) {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const ok = completed === tasks.length;
  if (json) {
    jsonLine2(output, {
      type: "run.summary",
      runId,
      ok,
      tasks: tasks.map((task) => ({
        id: task.spec.id,
        status: task.status,
        agent: task.assignedAgent,
        attempts: task.attempts,
        ...task.result === void 0 ? {} : { result: task.result }
      })),
      usage: totals.usage,
      costUsd: totals.costUsd
    });
    return ok ? 0 : 1;
  }
  output.log("");
  for (const line of formatTable(["STATUS", "ID", "AGENT", "TRIES", "TITLE"], tasks.map(summaryRow))) {
    output.log(line);
  }
  output.log("");
  output.log(`${completed}/${tasks.length} tasks completed`);
  output.log(usageLine(totals));
  return ok ? 0 : 1;
}
function outcomeLine(tasks) {
  const completed = tasks.filter((task) => task.status === "completed").length;
  if (completed === tasks.length) {
    return `completed ${completed}/${tasks.length} tasks`;
  }
  const failed = tasks.filter((task) => task.status === "failed").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const parts = [];
  if (failed > 0)
    parts.push(`${failed} task${failed === 1 ? "" : "s"} failed`);
  if (cancelled > 0)
    parts.push(`${cancelled} cancelled`);
  if (parts.length === 0)
    parts.push(`${completed}/${tasks.length} completed`);
  return `failed: ${parts.join(", ")}`;
}
async function closeTui(tui, outcome) {
  if (tui === void 0)
    return;
  try {
    tui.finish(outcome);
    await tui.unmount();
  } catch {
  }
}
async function executePreparedPlan(request, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const { runId, plan, policy, graph, store, options } = request;
  let tui;
  if (options.tui && !options.json) {
    try {
      tui = await (deps.tuiFactory ?? defaultTuiFactory)({
        objective: request.objective,
        taskIds: plan.tasks.map((task) => ({
          id: task.id,
          title: task.title
        }))
      });
    } catch (error) {
      output.error(`Note: showing plain output \u2014 the dashboard could not start (${errorText(error)})`);
    }
  }
  const renderer = tui !== void 0 ? void 0 : deps.renderer ?? (options.json ? new JsonRenderer() : new TextRenderer());
  const events2 = fanOutSink(renderer, tui?.sink, store === void 0 ? void 0 : storeSink(store));
  const usage = new UsageTracker();
  const taskTimeoutMs = options.timeoutSeconds === void 0 ? void 0 : options.timeoutSeconds * 1e3;
  const fail2 = async (message) => {
    await closeTui(tui, "failed to run");
    if (options.json)
      jsonLine2(output, { ok: false, error: message });
    else
      output.error(message);
    await recordRunStatus(store, runId, "failed");
    return 1;
  };
  let executor;
  try {
    executor = await (deps.executorFactory ?? defaultExecutorFactory)({
      project: request.project,
      workspacePath: request.workspacePath,
      runId,
      events: events2,
      usage,
      workerMode: options.workerMode,
      backend: options.backend,
      isolation: options.isolation,
      validate: options.validate,
      ...taskTimeoutMs === void 0 ? {} : { taskTimeoutMs },
      ...options.maxIterations === void 0 ? {} : { maxIterations: options.maxIterations }
    });
  } catch (error) {
    return await fail2(errorText(error));
  }
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  if (!options.json && tui === void 0) {
    output.log(request.leadLine ?? `Run ${runId} \u2014 ${plan.tasks.length} tasks, up to ${policy.maxConcurrency} at a time`);
    if (shouldRunValidators(request.project, options.backend, options.validate)) {
      const names = request.project.config.validators.map((validator) => validator.name).join(", ");
      output.log(`validators: ${names}`);
    }
  }
  try {
    await new DeterministicScheduler(new PolicyRouter(), executor, events2).run(runId, graph, policy, controller.signal);
  } catch (error) {
    return await fail2(errorText(error));
  } finally {
    process.off("SIGINT", onSigint);
  }
  const tasks = graph.all();
  await recordRunStatus(store, runId, runStatusFor(tasks, controller.signal.aborted));
  await closeTui(tui, outcomeLine(tasks));
  return renderRunSummary(runId, tasks, usage.totals(), output, options.json);
}
async function runOrchestrate(objective, options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const isolation = options.isolation ?? DEFAULT_ISOLATION;
  const conflict = tuiJsonConflict(options);
  if (conflict !== void 0) {
    output.error(conflict);
    return 1;
  }
  if (isolation === "worktree" && !options.dryRun) {
    const problem = await worktreeIsolationError(resolve4(options.cwd));
    if (problem !== void 0) {
      if (options.json)
        jsonLine2(output, { ok: false, error: problem });
      else
        output.error(problem);
      return 1;
    }
  }
  const prepared = await preparePlan(objective, options, deps);
  if ("exitCode" in prepared)
    return prepared.exitCode;
  if (options.dryRun) {
    renderPlan(prepared, output, options.json);
    return 0;
  }
  const runId = crypto.randomUUID();
  const store = options.save === false ? void 0 : await openRunStore(prepared.workspacePath);
  try {
    if (store !== void 0) {
      await bestEffort(() => store.createRun({
        id: runId,
        objective,
        createdAt: Date.now(),
        policySnapshot: prepared.policy
      }));
      await bestEffort(() => store.savePlan(runId, prepared.plan));
    }
    return await executePreparedPlan({
      runId,
      objective,
      project: prepared.project,
      workspacePath: prepared.workspacePath,
      policy: prepared.policy,
      plan: prepared.plan,
      graph: new TaskGraph(prepared.plan),
      options: {
        json: options.json,
        workerMode: options.workerMode,
        backend: options.backend,
        isolation,
        validate: options.validate ?? true,
        tui: options.tui === true,
        ...options.timeoutSeconds === void 0 ? {} : { timeoutSeconds: options.timeoutSeconds },
        ...options.maxIterations === void 0 ? {} : { maxIterations: options.maxIterations }
      },
      ...store === void 0 ? {} : { store }
    }, deps);
  } finally {
    closeRunStore(store);
  }
}

// apps/cli/dist/policy.js
import { readFile as readFile9, writeFile as writeFile3 } from "node:fs/promises";
import path6 from "node:path";
var consoleOutput2 = {
  log: (line) => console.log(line),
  error: (line) => console.error(line)
};
var LOCK_FILE_NAME2 = "orchestration.lock.json";
var defaultCompilerFactory = (args) => new LlmPolicyCompiler(args);
function jsonLine3(output, value) {
  output.log(JSON.stringify(value));
}
async function readOptionalFile2(filePath) {
  try {
    return await readFile9(filePath, "utf8");
  } catch {
    return void 0;
  }
}
function printBulletList2(output, label, items) {
  if (items.length === 0)
    return;
  output.log(`${label}:`);
  for (const item of items)
    output.log(`  - ${item}`);
}
async function loadProjectForPolicy(workspacePath, output, json) {
  let project;
  try {
    project = await loadAgentProject(workspacePath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      if (json) {
        jsonLine3(output, {
          ok: false,
          error: error.message,
          file: error.file,
          problems: error.problems
        });
      } else {
        output.error(error.message);
      }
      return { exitCode: 1 };
    }
    throw error;
  }
  if (project === void 0) {
    const message = "No .agent directory found \u2014 run `kapel init` first";
    if (json)
      jsonLine3(output, { ok: false, error: message });
    else
      output.error(message);
    return { exitCode: 1 };
  }
  const markdown = project.orchestrationMarkdown;
  if (markdown === void 0 || markdown.trim() === "") {
    const message = "No orchestration policy found \u2014 .agent/orchestration.md is missing or empty";
    if (json)
      jsonLine3(output, { ok: false, error: message });
    else
      output.error(message);
    return { exitCode: 1 };
  }
  return { project, markdown };
}
async function runPolicyCompile(options, deps = {}) {
  const output = deps.output ?? consoleOutput2;
  const workspacePath = path6.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const loaded = await loadProjectForPolicy(workspacePath, output, options.json);
  if ("exitCode" in loaded)
    return loaded.exitCode;
  const { project, markdown } = loaded;
  const alias = resolveModelAlias(process.env, options.model);
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved) {
    if (options.json)
      jsonLine3(output, { ok: false, error: resolved.error });
    else
      output.error(resolved.error);
    return 1;
  }
  const { model, provider } = resolved;
  const knownAgents = [...project.knownAgentNames()];
  const compilerFactory = deps.compilerFactory ?? defaultCompilerFactory;
  const compiler = compilerFactory({ provider, model, knownAgents });
  let result;
  try {
    result = await compiler.compile(markdown);
  } catch (error) {
    if (error instanceof PolicyCompileError) {
      if (options.json) {
        jsonLine3(output, {
          ok: false,
          error: error.message,
          attempts: error.attempts,
          issues: (error.lastIssues ?? []).map((issue) => `${issue.path}: ${issue.message}`)
        });
      } else {
        output.error(error.message);
      }
      return 1;
    }
    throw error;
  }
  const validation = validatePolicy(result.policy, project.knownAgentNames());
  const validationErrors = validation.filter((issue) => issue.severity === "error");
  const validationWarnings = validation.filter((issue) => issue.severity === "warning");
  if (validationErrors.length > 0) {
    if (options.json) {
      jsonLine3(output, {
        ok: false,
        errors: validationErrors.map((issue) => issue.message)
      });
    } else {
      output.error("Policy validation failed \u2014 no lock was written:");
      for (const issue of validationErrors)
        output.error(`  - ${issue.message}`);
    }
    return 1;
  }
  const lock = createLockfile({ markdown, result, model: model.id });
  const serialized = serializeLockfile(lock);
  const lockPath = path6.join(project.root, LOCK_FILE_NAME2);
  await writeFile3(lockPath, serialized, "utf8");
  const warnings = [
    ...result.warnings,
    ...validationWarnings.map((issue) => issue.message)
  ];
  const ambiguities = result.ambiguities;
  if (options.json) {
    jsonLine3(output, {
      ok: true,
      lockPath,
      policy: result.policy,
      warnings,
      ambiguities
    });
    return 0;
  }
  output.log(`Compiled policy using ${model.id} (${model.provider})`);
  output.log(`Lock written to ${lockPath}`);
  output.log(`Routing rules: ${result.policy.routing.length}, review rules: ${result.policy.review.length}, escalation rules: ${result.policy.escalation.length}`);
  printBulletList2(output, "Warnings", warnings);
  printBulletList2(output, "Ambiguities", ambiguities);
  return 0;
}
async function runPolicyCheck(options, deps = {}) {
  const output = deps.output ?? consoleOutput2;
  const workspacePath = path6.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const loaded = await loadProjectForPolicy(workspacePath, output, options.json);
  if ("exitCode" in loaded)
    return loaded.exitCode;
  const { project, markdown } = loaded;
  const lockPath = path6.join(project.root, LOCK_FILE_NAME2);
  const lockContent = await readOptionalFile2(lockPath);
  const status = checkLock(markdown, lockContent);
  if (!status.fresh) {
    if (options.json) {
      jsonLine3(output, {
        fresh: false,
        reason: status.reason,
        ...status.detail === void 0 ? {} : { detail: status.detail }
      });
    } else if (status.reason === "missing") {
      output.error(`No policy lock found at ${lockPath}. Run \`kapel policy compile\` to create one.`);
    } else if (status.reason === "stale-source") {
      output.error("orchestration.md has changed since the policy lock was compiled. Run `kapel policy compile` to refresh it.");
    } else {
      output.error(`Invalid policy lock at ${lockPath}: ${status.detail ?? "unknown error"}`);
    }
    return 1;
  }
  const validation = validatePolicy(status.lock.policy, project.knownAgentNames());
  const validationErrors = validation.filter((issue) => issue.severity === "error");
  if (validationErrors.length > 0) {
    if (options.json) {
      jsonLine3(output, {
        fresh: true,
        errors: validationErrors.map((issue) => issue.message)
      });
    } else {
      output.error("Policy lock matches orchestration.md but is no longer valid against the current agents:");
      for (const issue of validationErrors)
        output.error(`  - ${issue.message}`);
    }
    return 1;
  }
  const warningCount = status.lock.warnings.length;
  if (options.json) {
    jsonLine3(output, { fresh: true, warnings: warningCount });
    return 0;
  }
  output.log(warningCount > 0 ? `policy lock is up to date (${warningCount} warning${warningCount === 1 ? "" : "s"})` : "policy lock is up to date");
  return 0;
}
async function runPolicyExplain(options, deps = {}) {
  const output = deps.output ?? consoleOutput2;
  const workspacePath = path6.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const loaded = await loadProjectForPolicy(workspacePath, output, options.json);
  if ("exitCode" in loaded)
    return loaded.exitCode;
  const { project, markdown } = loaded;
  const lockPath = path6.join(project.root, LOCK_FILE_NAME2);
  const lockContent = await readOptionalFile2(lockPath);
  const status = checkLock(markdown, lockContent);
  let lock;
  if (status.fresh) {
    lock = status.lock;
  } else if (status.reason === "stale-source" && status.lock !== void 0) {
    lock = status.lock;
  } else if (status.reason === "missing") {
    const message = `No policy lock found at ${lockPath}. Run \`kapel policy compile\` to create one.`;
    if (options.json)
      jsonLine3(output, { ok: false, error: message });
    else
      output.error(message);
    return 1;
  } else {
    const message = `Invalid policy lock at ${lockPath}: ${status.detail ?? "unknown error"}. Run \`kapel policy compile\` to recreate it.`;
    if (options.json)
      jsonLine3(output, { ok: false, error: message });
    else
      output.error(message);
    return 1;
  }
  if (!status.fresh && !options.json) {
    output.error("Warning: orchestration.md has changed since this lock was compiled \u2014 this explanation may be stale. Run `kapel policy compile` to refresh it.");
  }
  const description = describePolicy(lock.policy);
  if (options.json) {
    jsonLine3(output, {
      policy: lock.policy,
      description,
      warnings: lock.warnings,
      ambiguities: lock.ambiguities,
      fresh: status.fresh
    });
    return 0;
  }
  output.log(description);
  printBulletList2(output, "Warnings", lock.warnings);
  printBulletList2(output, "Ambiguities", lock.ambiguities);
  return 0;
}

// apps/cli/dist/resume-cmd.js
import { readFile as readFile10 } from "node:fs/promises";
import path7 from "node:path";
var LOCK_FILE_NAME3 = "orchestration.lock.json";
async function readOptionalFile3(filePath) {
  try {
    return await readFile10(filePath, "utf8");
  } catch {
    return void 0;
  }
}
function stableJson(value) {
  const sort = (input) => {
    if (Array.isArray(input))
      return input.map(sort);
    if (typeof input !== "object" || input === null)
      return input;
    const entries = Object.entries(input).filter(([, item]) => item !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const out = {};
    for (const [key, item] of entries)
      out[key] = sort(item);
    return out;
  };
  return JSON.stringify(sort(value));
}
async function policyDriftWarning(project, snapshot) {
  const markdown = project.orchestrationMarkdown ?? "";
  const raw = await readOptionalFile3(path7.join(project.root, LOCK_FILE_NAME3));
  const status = checkLock(markdown, raw);
  const tail3 = "Resuming under the policy snapshot recorded with the run \u2014 start a new `kapel orchestrate` to plan under the current one.";
  if (!status.fresh) {
    return `Warning: this project's policy lock is ${status.reason} (\`kapel policy compile\` would refresh it). ${tail3}`;
  }
  if (stableJson(status.lock.policy) !== stableJson(snapshot)) {
    return `Warning: this project's policy has changed since run started. ${tail3}`;
  }
  return void 0;
}
async function rebuildGraph(store, runId, plan, completed) {
  const graph = new TaskGraph(plan);
  const persisted = await store.taskResults(runId);
  for (const task of graph.all()) {
    const result = completed.get(task.spec.id);
    if (result === void 0)
      continue;
    task.status = "completed";
    task.result = result;
    const entry = persisted.get(task.spec.id);
    if (entry !== void 0) {
      task.attempts = entry.attempts;
      if (entry.agent !== void 0)
        task.assignedAgent = entry.agent;
    }
  }
  return graph;
}
async function runResume(runId, options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const workspacePath = path7.resolve(options.cwd);
  const isolation = options.isolation ?? DEFAULT_ISOLATION;
  const fail2 = (message) => {
    if (options.json)
      output.log(JSON.stringify({ ok: false, error: message }));
    else
      output.error(message);
    return 1;
  };
  const conflict = tuiJsonConflict(options);
  if (conflict !== void 0) {
    output.error(conflict);
    return 1;
  }
  const store = openExistingRunStore(workspacePath);
  if (store === void 0) {
    return fail2(`No runs recorded yet \u2014 nothing at ${sessionDbPathFor(workspacePath)}.`);
  }
  try {
    const reconstruction = await reconstructRun(store, runId);
    if (reconstruction === void 0) {
      return fail2(`Unknown run ${runId}. Run \`kapel runs\` to see the recorded ones.`);
    }
    const { run, completed, incompleteTaskIds } = reconstruction;
    const plan = run.plan;
    if (plan === void 0) {
      return fail2(`Run ${run.id} has no saved plan \u2014 it never got past planning, so there is nothing to resume.`);
    }
    if (incompleteTaskIds.length === 0) {
      const message = `Nothing to resume: all ${plan.tasks.length} tasks of run ${run.id} already completed.`;
      if (options.json)
        output.log(JSON.stringify({ ok: true, message }));
      else
        output.log(message);
      return 0;
    }
    await loadDotEnvFile(workspacePath);
    let project;
    try {
      project = await loadAgentProject(workspacePath);
    } catch (error) {
      if (error instanceof ProjectConfigError)
        return fail2(error.message);
      throw error;
    }
    if (project === void 0) {
      return fail2("No .agent directory found \u2014 run `kapel init` first");
    }
    if (isolation === "worktree") {
      const problem = await worktreeIsolationError(workspacePath);
      if (problem !== void 0)
        return fail2(problem);
    }
    const drift = await policyDriftWarning(project, run.policy);
    if (drift !== void 0)
      output.error(drift);
    const graph = await rebuildGraph(store, run.id, plan, completed);
    return await executePreparedPlan({
      runId: run.id,
      objective: run.objective,
      project,
      workspacePath,
      // The run's own snapshot, not the current lock: see policyDriftWarning.
      policy: run.policy,
      plan,
      graph,
      store,
      leadLine: `Resuming run ${run.id} \u2014 ${incompleteTaskIds.length} of ${plan.tasks.length} tasks left, up to ${run.policy.maxConcurrency} at a time`,
      options: {
        json: options.json,
        workerMode: options.workerMode,
        backend: options.backend,
        isolation,
        validate: options.validate ?? true,
        tui: options.tui === true,
        ...options.timeoutSeconds === void 0 ? {} : { timeoutSeconds: options.timeoutSeconds },
        ...options.maxIterations === void 0 ? {} : { maxIterations: options.maxIterations }
      }
    }, deps);
  } finally {
    closeRunStore(store);
  }
}

// apps/cli/dist/run-codex.js
import path8 from "node:path";
async function runCodexObjective(objective, options) {
  const workspacePath = path8.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const availability = await CodexBackend.checkAvailability();
  if (!availability.installed) {
    console.error(codexInstallGuidance(availability));
    return 1;
  }
  if (!availability.loggedIn) {
    console.error(codexLoginGuidance(availability));
    return 1;
  }
  const renderer = options.json ? new JsonRenderer() : new TextRenderer();
  const backend = new CodexBackend({
    ...options.model === void 0 ? {} : { model: options.model },
    sandbox: options.sandbox,
    fullAuto: options.fullAuto,
    events: renderer,
    ...options.timeoutSeconds === void 0 ? {} : { timeoutMs: options.timeoutSeconds * 1e3 }
  });
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    const result = await backend.run({ instruction: objective }, {
      runId: crypto.randomUUID(),
      workspacePath,
      signal: controller.signal
    });
    renderer.result(result, new UsageTracker().totals());
    if (result.status === "success")
      return 0;
    if (result.status === "partial")
      return 2;
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// apps/cli/dist/runs-cmd.js
var DEFAULT_RUNS_LIMIT = 20;
var OBJECTIVE_WIDTH = 60;
function truncate5(text2, limit) {
  return text2.length <= limit ? text2 : `${text2.slice(0, limit - 1)}\u2026`;
}
function taskCountsCell(counts) {
  const seen = counts.completed + counts.failed + counts.cancelled;
  const total = counts.total ?? seen;
  const problems = [];
  if (counts.failed > 0)
    problems.push(`${counts.failed} failed`);
  if (counts.cancelled > 0)
    problems.push(`${counts.cancelled} cancelled`);
  const cell = `${counts.completed}/${total}`;
  return problems.length === 0 ? cell : `${cell} (${problems.join(", ")})`;
}
function summaryRow2(run) {
  return [
    run.id,
    run.status,
    isoTime(run.createdAt),
    taskCountsCell(run.taskCounts),
    truncate5(run.objective, OBJECTIVE_WIDTH)
  ];
}
async function runRunsCommand(options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const store = openExistingRunStore(options.cwd);
  if (store === void 0) {
    if (options.json)
      output.log(JSON.stringify([]));
    else {
      output.log(`No runs recorded yet \u2014 nothing at ${sessionDbPathFor(options.cwd)}.`);
    }
    return 0;
  }
  try {
    const runs2 = await store.listRuns({
      limit: options.limit ?? DEFAULT_RUNS_LIMIT
    });
    if (options.json) {
      output.log(JSON.stringify(runs2.map((run) => ({
        id: run.id,
        status: run.status,
        objective: run.objective,
        createdAt: run.createdAt,
        startedAt: isoTime(run.createdAt),
        taskCounts: run.taskCounts
      }))));
      return 0;
    }
    if (runs2.length === 0) {
      output.log("No runs recorded yet.");
      return 0;
    }
    for (const line of formatTable(["ID", "STATUS", "STARTED", "TASKS", "OBJECTIVE"], runs2.map(summaryRow2))) {
      output.log(line);
    }
    return 0;
  } finally {
    closeRunStore(store);
  }
}

// apps/cli/dist/worker-cmd.js
var defaultWorkerExecutorFactory = async (args) => {
  const resolveModel = await createProjectModelResolver(args.project, process.env);
  return new AgentLoopWorkerExecutor({
    project: args.project,
    resolveModel,
    workspacePath: args.workspacePath,
    runId: args.runId,
    events: args.events,
    ...args.taskTimeoutMs === void 0 ? {} : { taskTimeoutMs: args.taskTimeoutMs }
  });
};
async function runWorkerCommand(deps = {}) {
  const io = deps.io ?? {
    stdin: process.stdin,
    stdout: process.stdout
  };
  const error = deps.error ?? ((line) => console.error(line));
  const executorFactory = deps.executorFactory ?? defaultWorkerExecutorFactory;
  return serveWorkerRequest(io, async (request, events2) => {
    try {
      await loadDotEnvFile(request.workspacePath);
      const project = await loadAgentProject(request.workspacePath);
      if (project === void 0) {
        throw new Error(`No .agent directory found in ${request.workspacePath} \u2014 run \`kapel init\` there first`);
      }
      const executor = await executorFactory({
        project,
        workspacePath: request.workspacePath,
        runId: request.runId,
        events: events2,
        ...request.timeoutMs === void 0 ? {} : { taskTimeoutMs: request.timeoutMs }
      });
      const task = {
        spec: toPlannedTask2(request.task),
        status: "running",
        attempts: 1
      };
      error(`worker: ${task.spec.id} as ${request.agent}`);
      return await executor.execute(task, request.agent, void 0, toWorkerExecutionContext(request));
    } catch (failure) {
      error(`worker: ${failure instanceof Error ? failure.message : String(failure)}`);
      throw failure;
    }
  });
}

// apps/cli/dist/index.js
function parsePositive(raw, flag, integer2) {
  const value = integer2 ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${flag} value "${raw}": expected a positive ${integer2 ? "integer" : "number"}.`);
  }
  return value;
}
function toRunOptions(raw) {
  const maxIterations = parsePositive(raw.maxIterations, "--max-iterations", true);
  const timeoutSeconds = raw.timeout === void 0 ? void 0 : parsePositive(raw.timeout, "--timeout", false);
  return {
    cwd: raw.cwd,
    maxIterations,
    yes: raw.yes,
    json: raw.json,
    ...raw.model === void 0 ? {} : { model: raw.model },
    ...timeoutSeconds === void 0 ? {} : { timeoutSeconds },
    ...raw.system === void 0 ? {} : { system: raw.system }
  };
}
function toCodexRunOptions(raw) {
  const timeoutSeconds = raw.timeout === void 0 ? void 0 : parsePositive(raw.timeout, "--timeout", false);
  const sandbox = validateSandboxMode(raw.sandbox);
  const model = codexModelOverride(raw.model);
  return {
    cwd: raw.cwd,
    json: raw.json,
    sandbox,
    fullAuto: fullAutoForSandbox(sandbox),
    ...model === void 0 ? {} : { model },
    ...timeoutSeconds === void 0 ? {} : { timeoutSeconds }
  };
}
async function runAndExit(objectiveParts, raw) {
  const objective = objectiveParts.join(" ").trim();
  if (objective === "") {
    console.error('Usage: kapel [options] "<objective>"');
    process.exitCode = 1;
    return;
  }
  try {
    const backend = validateBackendName(raw.backend);
    if (backend === "codex") {
      const options2 = toCodexRunOptions(raw);
      process.exitCode = await runCodexObjective(objective, options2);
      return;
    }
    const options = toRunOptions(raw);
    process.exitCode = await runObjective(objective, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
var program = new Command();
program.name("kapel").description("Kapel \u2014 a multi-model orchestration coding agent: point it at a repository and an objective, and it plans, routes, and edits via LLM tool-call loops.").version("0.1.0").option("--cwd <dir>", "workspace root to operate in", process.cwd()).option("-m, --model <alias>", "model alias to use (see `kapel models`)").option("--max-iterations <n>", "maximum tool-call iterations before giving up", "32").option("--timeout <seconds>", "overall run timeout, in seconds").option("-y, --yes", "auto-approve every permission prompt", false).option("--json", "emit newline-delimited JSON events instead of text", false).option("--system <text>", "override the default system prompt").option("--backend <name>", "execution backend to use: native | codex", resolveBackendName(process.env)).option("--sandbox <mode>", `codex sandbox mode: ${SANDBOX_MODES.join(" | ")}`, DEFAULT_SANDBOX_MODE);
program.argument("[objective...]", 'the coding objective to work on, e.g. "fix the failing test"').action(async (objective, opts) => {
  if (objective.length === 0) {
    program.help();
    return;
  }
  await runAndExit(objective, opts);
});
program.command("exec").description("Run the coding agent loop (same as the default command)").argument("<objective...>", "the coding objective to work on").action(async (objective, _opts, command) => {
  await runAndExit(objective, command.optsWithGlobals());
});
program.command("init").description("Create a .agent configuration in the current repository").option("--force", "overwrite an existing .agent directory", false).action(async (opts, command) => {
  const cwd = command.optsWithGlobals().cwd;
  process.exitCode = await runInit({
    cwd: path9.resolve(cwd),
    force: opts.force
  });
});
program.command("models").description("List available model aliases and provider credential status").action(async (_opts, command) => {
  const cwd = command.optsWithGlobals().cwd;
  await loadDotEnvFile(path9.resolve(cwd));
  const entries = await listModels(process.env);
  if (entries.length === 0) {
    console.log("(no models registered)");
    return;
  }
  const aliasWidth = Math.max(...entries.map((entry) => entry.alias.length));
  for (const entry of entries) {
    console.log(`${entry.alias.padEnd(aliasWidth)}  ${entry.provider.padEnd(10)}  ${entry.credentialStatus}`);
  }
  console.log();
  console.log('backend codex \u2014 uses the OpenAI Codex CLI with its own ChatGPT OAuth (run: kapel --backend codex "...")');
});
function planOptions(command) {
  const raw = command.optsWithGlobals();
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...raw.model === void 0 ? {} : { model: raw.model }
  };
}
function executionOptions(command, opts) {
  const raw = command.optsWithGlobals();
  const timeoutSeconds = raw.timeout === void 0 ? void 0 : parsePositive(raw.timeout, "--timeout", false);
  const maxIterations = parsePositive(raw.maxIterations, "--max-iterations", true);
  return {
    workerMode: validateWorkerMode(opts.workerMode),
    isolation: validateIsolation(opts.isolation),
    backend: validateBackendName(raw.backend),
    maxIterations,
    validate: opts.validate,
    tui: opts.tui,
    ...timeoutSeconds === void 0 ? {} : { timeoutSeconds }
  };
}
function orchestrateOptions(command, opts) {
  return {
    ...planOptions(command),
    ...executionOptions(command, opts),
    dryRun: opts.dryRun,
    save: opts.save
  };
}
function resumeOptions(command, opts) {
  const raw = command.optsWithGlobals();
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...executionOptions(command, opts)
  };
}
function withExecutionOptions(command) {
  return command.option("--worker-mode <mode>", `where workers run: ${WORKER_MODES.join(" | ")}`, DEFAULT_WORKER_MODE).option("--isolation <mode>", `how mutating tasks are kept apart: ${ISOLATION_MODES.join(" | ")}`, DEFAULT_ISOLATION).option("--no-validate", "skip the project's configured validators for this run").option("--tui", "show the live orchestration dashboard instead of event lines (not with --json)", false);
}
async function objectiveCommand(parts, usage, run) {
  const objective = parts.join(" ").trim();
  if (objective === "") {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await run(objective);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
program.command("plan").description("Plan an objective into a task graph and print it, without executing anything").argument("<objective...>", "the objective to plan").action(async (objective, _opts, command) => {
  await objectiveCommand(objective, 'Usage: kapel plan "<objective>"', (text2) => runPlan(text2, planOptions(command)));
});
withExecutionOptions(program.command("orchestrate").description("Plan an objective and execute the resulting task graph across routed workers").argument("<objective...>", "the objective to orchestrate")).option("--dry-run", "plan only \u2014 same output as `kapel plan`", false).option("--no-save", "do not record this run in .agent/sessions.db").action(async (objective, opts, command) => {
  await objectiveCommand(objective, 'Usage: kapel orchestrate "<objective>"', (text2) => runOrchestrate(text2, orchestrateOptions(command, opts)));
});
withExecutionOptions(program.command("resume").description("Re-execute the unfinished tasks of a recorded run").argument("<runId>", "the run to resume (see `kapel runs`)")).action(async (runId, opts, command) => {
  try {
    process.exitCode = await runResume(runId, resumeOptions(command, opts));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
program.command("runs").description("List orchestration runs recorded in this workspace").option("--limit <n>", "how many runs to list", String(DEFAULT_RUNS_LIMIT)).action(async (opts, command) => {
  const raw = command.optsWithGlobals();
  try {
    process.exitCode = await runRunsCommand({
      cwd: raw.cwd,
      json: raw.json,
      limit: parsePositive(opts.limit, "--limit", true)
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
program.command("explain").description("Explain how one task of a recorded run was routed, scheduled and finished").argument("<taskId>", "the task to explain, e.g. T03").option("--run <runId>", "which run to read (default: the most recent)").action(async (taskId, opts, command) => {
  const raw = command.optsWithGlobals();
  try {
    process.exitCode = await runExplainCommand(taskId, {
      cwd: raw.cwd,
      json: raw.json,
      ...opts.run === void 0 ? {} : { run: opts.run }
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
program.command("worker").description("Run one orchestration task from a protocol request on stdin (used by --worker-mode child)").action(async () => {
  process.exitCode = await runWorkerCommand();
});
function policyOptions(command) {
  const raw = command.optsWithGlobals();
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...raw.model === void 0 ? {} : { model: raw.model }
  };
}
var POLICY_SUBCOMMANDS = ["compile", "check", "explain"];
var policyCommand = program.command("policy").description("Manage orchestration policies (compile, check, explain)").argument("[unknownCommand]", "compile | check | explain");
policyCommand.command("compile").description("Compile .agent/orchestration.md into a policy lock using an LLM").action(async (_opts, command) => {
  process.exitCode = await runPolicyCompile(policyOptions(command));
});
policyCommand.command("check").description("Check that the policy lock is fresh and valid (no LLM calls)").action(async (_opts, command) => {
  process.exitCode = await runPolicyCheck(policyOptions(command));
});
policyCommand.command("explain").description("Print a human-readable summary of the compiled policy").action(async (_opts, command) => {
  process.exitCode = await runPolicyExplain(policyOptions(command));
});
policyCommand.action((unknownCommand) => {
  if (unknownCommand === void 0) {
    policyCommand.help();
    return;
  }
  console.error(`Unknown policy command "${unknownCommand}". Expected one of: ${POLICY_SUBCOMMANDS.join(", ")}.`);
  process.exitCode = 1;
});
await program.parseAsync();
