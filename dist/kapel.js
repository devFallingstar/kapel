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
  const data = isRecord10(event2.data) ? event2.data : {};
  const tasks = reduceTasks(base.tasks, event2, data);
  const line = formatEventLine(event2);
  const log = line === void 0 ? base.log : appendLog(base.log, line);
  if (tasks === base.tasks && log === base.log)
    return base;
  return { ...base, tasks, log };
}
function formatEventLine(event2) {
  const data = isRecord10(event2.data) ? event2.data : {};
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
      const result = isRecord10(data.result) ? data.result : {};
      const glyph2 = result.status === "success" ? "\u2714" : "\u2716";
      const suffix = data.final === false ? " (retrying)" : "";
      return `${glyph2} ${taskId} \u2014 ${firstLine3(result.summary)}${suffix}`;
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
        const result = isRecord10(data.result) ? data.result : {};
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
        const failure2 = `\u2717 ${str2(data.name) ?? "?"}`;
        draft.note = draft.note === void 0 ? failure2 : `${draft.note} \xB7 ${failure2}`;
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
function isRecord10(value) {
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
  if (isRecord10(data.item))
    return data.item;
  if (isRecord10(data.msg) && isRecord10(data.msg.item))
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
  const joined = content.map((part) => typeof part === "string" ? part : isRecord10(part) ? str2(part.text) ?? "" : "").join("");
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
    else if (isRecord10(change)) {
      const path19 = str2(change.path) ?? str2(change.file);
      if (path19 !== void 0)
        paths.push(path19);
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
  const paint2 = () => {
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
      paint2();
    }, RENDER_INTERVAL_MS);
    unref(pending);
  };
  const tick = setInterval(paint2, TICK_INTERVAL_MS);
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
        paint2();
      } catch {
      }
    },
    async unmount() {
      if (unmounted)
        return;
      clearPending();
      clearInterval(tick);
      paint2();
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
import path18 from "node:path";
import { Command } from "commander";

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
function buildPlannerSystemPrompt(policy, knownAgents) {
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
        content: buildPlannerSystemPrompt(policy, this.#options.knownAgents)
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
    return this.decide(task, policy).agent;
  }
  decide(task, policy) {
    const candidates = policy.routing.filter((rule) => ruleMatches2(rule, task));
    const hard = candidates.filter((rule) => rule.strength === "hard");
    const pool = hard.length > 0 ? hard : candidates;
    const best = [...pool].sort(byWeightThenId)[0];
    if (best !== void 0) {
      return { agent: best.agent, rule: best.id, reason: "rule" };
    }
    if (task.suggestedAgent !== void 0) {
      return { agent: task.suggestedAgent, reason: "suggestedAgent" };
    }
    return { agent: policy.orchestrator, reason: "orchestrator" };
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
    let agent;
    let routing;
    if (escalation === void 0) {
      const decision = this.#route(task.spec, policy);
      agent = decision.agent;
      routing = decision.rule === void 0 ? { reason: decision.reason } : { rule: decision.rule, reason: decision.reason };
    } else {
      agent = escalation.toAgent;
      routing = { rule: escalation.id, reason: "escalation" };
    }
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
    const model = this.worker.describeAgent?.(agent)?.model;
    await this.#emit(runId, "task.started", task.spec.id, {
      agent,
      attempt: task.attempts,
      ...model === void 0 ? {} : { model },
      routing
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
   * The router's decision for a non-escalated attempt, rationale included.
   * Falls back to a bare `route()` call, with `reason` reported as
   * `"orchestrator"`, for a router that only implements the required half of
   * {@link AgentRouter} — the rationale is then genuinely unknown, but that
   * fallback value keeps it in the same closed set `TaskStartedReason` allows
   * rather than inventing a new one.
   */
  #route(task, policy) {
    if (this.router.decide !== void 0)
      return this.router.decide(task, policy);
    return { agent: this.router.route(task, policy), reason: "orchestrator" };
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
function buildPolicyToolInputSchema() {
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
  inputSchema: buildPolicyToolInputSchema()
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
function buildPolicyCompilerSystemPrompt(knownAgents) {
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
function parsePolicyDraft(input) {
  const parsed = CompilerOutputSchema.safeParse(input);
  if (!parsed.success)
    return { issues: toIssues2(parsed.error) };
  const policy = PolicySchema.parse(parsed.data.policy);
  return {
    result: {
      policy,
      warnings: parsed.data.warnings,
      ambiguities: parsed.data.ambiguities
    }
  };
}
var LlmPolicyCompiler = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  async compile(markdown, signal) {
    const maxAttempts = Math.max(1, this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS2);
    const messages = [
      {
        role: "system",
        content: buildPolicyCompilerSystemPrompt(this.#options.knownAgents)
      },
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
      const outcome = parsePolicyDraft(call.input);
      if ("result" in outcome)
        return outcome.result;
      lastIssues = outcome.issues;
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

// packages/policy/dist/diff.js
function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      return false;
    const left = a.map((value) => String(value)).sort();
    const right = b.map((value) => String(value)).sort();
    return left.every((value, index2) => value === right[index2]);
  }
  return a === b;
}
function fieldChanges(before, after) {
  const keys = /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("id");
  const changes = [];
  for (const field of [...keys].sort()) {
    const beforeValue = before[field];
    const afterValue = after[field];
    if (!valuesEqual(beforeValue, afterValue)) {
      changes.push({ field, before: beforeValue, after: afterValue });
    }
  }
  return changes;
}
function diffRules(before, after) {
  const beforeById = new Map(before.map((rule) => [rule.id, rule]));
  const afterById = new Map(after.map((rule) => [rule.id, rule]));
  const diffs = [];
  for (const [id, beforeRule] of beforeById) {
    const afterRule = afterById.get(id);
    if (afterRule === void 0) {
      diffs.push({ id, kind: "removed", before: beforeRule });
      continue;
    }
    const changes = fieldChanges(beforeRule, afterRule);
    if (changes.length > 0) {
      diffs.push({
        id,
        kind: "changed",
        before: beforeRule,
        after: afterRule,
        changes
      });
    }
  }
  for (const [id, afterRule] of afterById) {
    if (!beforeById.has(id))
      diffs.push({ id, kind: "added", after: afterRule });
  }
  return diffs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
var DEFAULT_FIELDS = [
  "orchestrator",
  "maxConcurrency",
  "parallelizeIndependentTasks",
  "defaultMaxAttempts"
];
function diffDefaults(before, after) {
  const changes = [];
  for (const field of DEFAULT_FIELDS) {
    if (before[field] !== after[field]) {
      changes.push({ field, before: before[field], after: after[field] });
    }
  }
  return changes;
}
function diffPolicies(before, after) {
  const defaults = diffDefaults(before, after);
  const routing = diffRules(before.routing, after.routing);
  const review = diffRules(before.review, after.review);
  const escalation = diffRules(before.escalation, after.escalation);
  return {
    defaults,
    routing,
    review,
    escalation,
    unchanged: defaults.length === 0 && routing.length === 0 && review.length === 0 && escalation.length === 0
  };
}
function fmtValue(value) {
  if (value === void 0)
    return "(none)";
  if (Array.isArray(value))
    return value.length === 0 ? "[]" : value.join(", ");
  return String(value);
}
function summarizeRouting(rule) {
  return `${rule.agent} (${rule.strength}, weight ${rule.weight})`;
}
function summarizeReview(rule) {
  return `${rule.reviewer} (${rule.strength}, ${rule.blocking ? "blocking" : "advisory"})`;
}
function summarizeEscalation(rule) {
  return `${rule.fromAgent} -> ${rule.toAgent}`;
}
function renderRuleSection(title, diffs, summarize) {
  if (diffs.length === 0)
    return [];
  const lines = [`${title}:`];
  for (const diff of diffs) {
    if (diff.kind === "added") {
      lines.push(`  + ${diff.id}: ${summarize(diff.after)}`);
    } else if (diff.kind === "removed") {
      lines.push(`  - ${diff.id}: ${summarize(diff.before)}`);
    } else {
      lines.push(`  ~ ${diff.id}: ${summarize(diff.before)} -> ${summarize(diff.after)}`);
      for (const change of diff.changes) {
        lines.push(`      ${change.field}: ${fmtValue(change.before)} -> ${fmtValue(change.after)}`);
      }
    }
  }
  return lines;
}
function renderDefaults(defaults) {
  if (defaults.length === 0)
    return [];
  return [
    "Defaults:",
    ...defaults.map((change) => `  ${change.field}: ${fmtValue(change.before)} -> ${fmtValue(change.after)}`)
  ];
}
function formatPolicyDiff(diff) {
  if (diff.unchanged)
    return ["No changes."];
  const sections = [
    renderDefaults(diff.defaults),
    renderRuleSection("Routing rules", diff.routing, summarizeRouting),
    renderRuleSection("Review rules", diff.review, summarizeReview),
    renderRuleSection("Escalation rules", diff.escalation, summarizeEscalation)
  ].filter((section2) => section2.length > 0);
  const lines = [];
  sections.forEach((section2, index2) => {
    if (index2 > 0)
      lines.push("");
    lines.push(...section2);
  });
  return lines;
}

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
    const path19 = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${path19}: ${issue.message}`;
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

// packages/policy/dist/source-span.js
var FILE_NAME = "orchestration.md";
var MIN_FRAGMENT_LENGTH = 4;
var QUOTE_PATTERNS = [
  /"([^"]+)"/g,
  /'([^']+)'/g,
  /`([^`]+)`/g,
  /“([^”]+)”/g,
  /‘([^’]+)’/g
];
function extractQuotedFragments(text2) {
  const fragments = [];
  for (const pattern of QUOTE_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text2);
    while (match !== null) {
      const fragment = (match[1] ?? "").trim();
      if (fragment.length >= MIN_FRAGMENT_LENGTH)
        fragments.push(fragment);
      match = pattern.exec(text2);
    }
  }
  return [...fragments].sort((a, b) => b.length - a.length);
}
function buildLineStarts(markdown) {
  const starts = [0];
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown[i] === "\n")
      starts.push(i + 1);
  }
  return starts;
}
function lineForOffset(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((lineStarts[mid] ?? 0) <= offset)
      lo = mid;
    else
      hi = mid - 1;
  }
  return lo + 1;
}
function toLocation(lineStarts, startOffset, length) {
  const line = lineForOffset(lineStarts, startOffset);
  const endLine = lineForOffset(lineStarts, startOffset + length - 1);
  return endLine === line ? { file: FILE_NAME, line } : { file: FILE_NAME, line, endLine };
}
function locateExact(markdown, fragment, lineStarts) {
  const index2 = markdown.indexOf(fragment);
  return index2 === -1 ? void 0 : toLocation(lineStarts, index2, fragment.length);
}
function collapseWhitespace(text2) {
  return text2.trim().replace(/\s+/g, " ").toLowerCase();
}
function buildNormalizedSource(markdown) {
  const chars = [];
  const lineOf = [];
  let line = 1;
  let pendingSpace = false;
  let started = false;
  for (const ch of markdown) {
    if (ch === "\n") {
      line += 1;
      pendingSpace = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && started) {
      chars.push(" ");
      lineOf.push(line);
    }
    chars.push(ch.toLowerCase());
    lineOf.push(line);
    started = true;
    pendingSpace = false;
  }
  return { text: chars.join(""), lineOf };
}
function locateNormalized(source, fragment) {
  const needle = collapseWhitespace(fragment);
  if (needle === "")
    return void 0;
  const at = source.text.indexOf(needle);
  if (at === -1)
    return void 0;
  const line = source.lineOf[at] ?? 1;
  const endLine = source.lineOf[at + needle.length - 1] ?? line;
  return endLine === line ? { file: FILE_NAME, line } : { file: FILE_NAME, line, endLine };
}
function locateSourceText(markdown, text2) {
  const fragments = extractQuotedFragments(text2);
  if (fragments.length === 0)
    return void 0;
  const lineStarts = buildLineStarts(markdown);
  for (const fragment of fragments) {
    const exact = locateExact(markdown, fragment, lineStarts);
    if (exact !== void 0)
      return exact;
  }
  const normalized = buildNormalizedSource(markdown);
  for (const fragment of fragments) {
    const found = locateNormalized(normalized, fragment);
    if (found !== void 0)
      return found;
  }
  return void 0;
}
function locateIssue(message, markdown) {
  const location = locateSourceText(markdown, message);
  return location === void 0 ? { message } : { message, location };
}
function locateIssues(messages, markdown) {
  return messages.map((message) => locateIssue(message, markdown));
}
function formatSourceLocation(location) {
  return location.endLine === void 0 ? `${location.file}:${location.line}` : `${location.file}:${location.line}-${location.endLine}`;
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

// packages/coding-agent/dist/backend-chat.js
var DEFAULT_TRANSCRIPT_TURNS = 12;
var TRANSCRIPT_ENTRY_CHARS = 2e3;
var CANCELLED_SUMMARY = "Turn cancelled before the backend replied.";
function copyEntry(entry) {
  return { role: entry.role, content: entry.content, at: entry.at };
}
function errorMessage(error) {
  if (error instanceof Error)
    return error.message;
  return String(error);
}
function isAbort(error, signal) {
  if (signal?.aborted === true)
    return true;
  return error instanceof Error && error.name === "AbortError";
}
function firstText(...values) {
  for (const value of values) {
    if (value !== void 0 && value !== "")
      return value;
  }
  return void 0;
}
var BackendChatSession = class _BackendChatSession {
  #options;
  #entries = [];
  #sessionRef;
  #turn = 0;
  #sending = false;
  constructor(options) {
    this.#options = options;
  }
  /**
   * Rebuilds a session from an {@link entries} snapshot and, when the backend
   * supports continuation, the session id that snapshot ended on. Turn
   * numbering resumes from the number of restored user entries so events keep
   * counting up across a process restart.
   */
  static restore(options, entries, sessionRef) {
    const session = new _BackendChatSession(options);
    for (const entry of entries)
      session.#entries.push(copyEntry(entry));
    session.#turn = session.#entries.filter((entry) => entry.role === "user").length;
    session.#sessionRef = sessionRef;
    return session;
  }
  /**
   * Rebuilds a session from the same `chat_messages` snapshot the native path
   * persists. System and tool messages are dropped — a delegating backend has
   * its own system prompt and runs its own tools — as are empty assistant
   * turns, which on the native path are the tool-call-only ones.
   */
  static fromModelMessages(options, messages, sessionRef) {
    const at = Date.now();
    const entries = [];
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant")
        continue;
      if (message.content.trim() === "")
        continue;
      entries.push({ role: message.role, content: message.content, at });
    }
    return _BackendChatSession.restore(options, entries, sessionRef);
  }
  /**
   * Runs one user turn: the instruction is recorded, handed to the runner with
   * either the transcript or the backend's session id, and the reply recorded.
   *
   * The user entry is recorded even when the turn fails, is cancelled, or the
   * runner throws, so the conversation still reads as a conversation. An
   * assistant entry is only recorded when the backend actually produced text.
   *
   * @throws if another send on this session is still in flight.
   */
  async send(instruction, context) {
    if (this.#sending) {
      throw new Error("BackendChatSession.send: a send is already in flight; turns must be serialized.");
    }
    this.#sending = true;
    const signal = context?.signal;
    const taskId = context?.taskId;
    try {
      const prior = this.#entries.map(copyEntry);
      this.#entries.push({
        role: "user",
        content: instruction,
        at: Date.now()
      });
      this.#turn += 1;
      const turn = this.#turn;
      await this.#emit(taskId, "chat.turn.started", {
        turn,
        backend: "delegated"
      });
      const result = await this.#runTurn(instruction, prior, signal, taskId);
      await this.#emit(taskId, "chat.turn.completed", {
        turn,
        status: result.status
      });
      return result;
    } finally {
      this.#sending = false;
    }
  }
  /** A defensive copy of the recorded conversation, oldest first. */
  entries() {
    return this.#entries.map(copyEntry);
  }
  /** The backend-native session id of the last turn that reported one. */
  sessionRef() {
    return this.#sessionRef;
  }
  /**
   * The conversation as provider messages, so a CLI can persist a delegated
   * chat through the very same `chat_messages` storage the native path uses.
   */
  toModelMessages() {
    return this.#entries.map((entry) => ({
      role: entry.role,
      content: entry.content
    }));
  }
  async #runTurn(instruction, prior, signal, taskId) {
    if (signal?.aborted === true) {
      return { status: "failed", summary: CANCELLED_SUMMARY };
    }
    let outcome;
    try {
      outcome = await this.#options.runner(this.#request(instruction, prior, signal, taskId));
    } catch (error) {
      return {
        status: "failed",
        summary: isAbort(error, signal) ? CANCELLED_SUMMARY : errorMessage(error)
      };
    }
    if (outcome.sessionRef !== void 0 && outcome.sessionRef !== "") {
      this.#sessionRef = outcome.sessionRef;
    }
    const reply = firstText(outcome.output, outcome.summary);
    if (reply !== void 0) {
      this.#entries.push({
        role: "assistant",
        content: reply,
        at: Date.now()
      });
    }
    return {
      status: outcome.status,
      summary: outcome.summary,
      ...outcome.output === void 0 ? {} : { output: outcome.output },
      ...outcome.usage === void 0 ? {} : {
        usage: {
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens
        }
      },
      ...outcome.costUsd === void 0 ? {} : { costUsd: outcome.costUsd }
    };
  }
  /**
   * Continuation and stateless mode are mutually exclusive by construction:
   * either the backend has the history (session id, empty transcript) or we do
   * (no session id, the last N entries).
   */
  #request(instruction, prior, signal, taskId) {
    const continuing = this.#options.supportsContinuation === true && this.#sessionRef !== void 0;
    const limit = this.#options.transcriptTurns ?? DEFAULT_TRANSCRIPT_TURNS;
    const transcript = continuing ? [] : limit <= 0 ? [] : prior.slice(Math.max(0, prior.length - limit));
    return {
      instruction,
      transcript,
      ...continuing && this.#sessionRef !== void 0 ? { sessionRef: this.#sessionRef } : {},
      context: {
        runId: this.#options.runId,
        workspacePath: this.#options.workspacePath,
        ...taskId === void 0 ? {} : { taskId },
        ...signal === void 0 ? {} : { signal }
      }
    };
  }
  /**
   * Best-effort emission on the configured sink, building the same envelope
   * `AgentLoopEngine.emit` does so a renderer cannot tell the delegated path
   * from the native one.
   */
  async #emit(taskId, type, data) {
    const sink = this.#options.events;
    if (sink === void 0)
      return;
    const event2 = {
      id: crypto.randomUUID(),
      runId: this.#options.runId,
      timestamp: Date.now(),
      type,
      ...taskId === void 0 ? {} : { taskId },
      data
    };
    try {
      await sink.emit(event2);
    } catch {
    }
  }
};
function clamp(text2, limit) {
  if (text2.length <= limit)
    return text2;
  return `${text2.slice(0, limit)}\u2026`;
}
function renderTranscript(transcript) {
  const lines = transcript.map((entry) => `${entry.role}: ${clamp(entry.content, TRANSCRIPT_ENTRY_CHARS)}`);
  return `Earlier in this conversation:
${lines.join("\n")}`;
}
function backendTurnRunner(backend, options) {
  const withTranscript = options?.promptWithTranscript ?? true;
  return async (request) => {
    const context = withTranscript && request.transcript.length > 0 ? [renderTranscript(request.transcript)] : [];
    const result = await backend.run({
      instruction: request.instruction,
      ...context.length === 0 ? {} : { context }
    }, {
      runId: request.context.runId,
      workspacePath: request.context.workspacePath,
      ...request.context.taskId === void 0 ? {} : { taskId: request.context.taskId },
      ...request.context.signal === void 0 ? {} : { signal: request.context.signal }
    });
    return {
      status: result.status,
      summary: result.summary,
      ...result.output === void 0 ? {} : { output: result.output },
      ...result.sessionId === void 0 ? {} : { sessionRef: result.sessionId },
      ...result.usage === void 0 ? {} : { usage: result.usage },
      ...result.costUsd === void 0 ? {} : { costUsd: result.costUsd }
    };
  };
}

// packages/coding-agent/dist/backends/claude-code.js
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

// packages/coding-agent/dist/backends/claude-code.js
var DEFAULT_BINARY = "claude";
var DEFAULT_PERMISSION_MODE = "acceptEdits";
var KILL_GRACE_MS = 2e3;
var MAX_STDERR_CHARS = 5e4;
var STDERR_TAIL_CHARS = 2e3;
var MAX_RAW_LINES = 20;
var MAX_RAW_LINE_CHARS = 500;
var PROBE_TIMEOUT_MS = 5e3;
var PROBE_MAX_BUFFER = 512 * 1024;
var INSTALL_HINT = "Install the Claude Code CLI with `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in with your Claude subscription (no API key required).";
var LOGIN_HINT = "Run `claude` and log in with your Claude subscription (no API key required).";
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
var ClaudeCodeBackend = class {
  #options;
  constructor(options = {}) {
    this.#options = options;
  }
  async run(input, context) {
    const binary = this.#options.binaryPath ?? DEFAULT_BINARY;
    const timeoutMs = this.#options.timeoutMs;
    const args = this.#buildArgs(buildPrompt(input));
    const signals = [];
    if (context.signal !== void 0)
      signals.push(context.signal);
    const timeoutSignal = timeoutMs === void 0 ? void 0 : AbortSignal.timeout(timeoutMs);
    if (timeoutSignal !== void 0)
      signals.push(timeoutSignal);
    const signal = signals.length === 0 ? void 0 : AbortSignal.any(signals);
    const state = {
      assistantText: "",
      finalResult: void 0,
      sessionId: void 0,
      costUsd: void 0,
      stopReason: void 0,
      inputTokens: 0,
      outputTokens: 0,
      messageOutputTokens: 0,
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
      emit2("claude-code.completed", {
        status: result.status,
        exitCode: result.exitCode
      });
      await queue;
      return result;
    };
    const settle = (status, summary, exitCode2) => {
      const output = finalText(state);
      return {
        status,
        summary,
        ...output === void 0 ? {} : { output },
        exitCode: exitCode2,
        ...state.sawUsage ? {
          usage: {
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens
          }
        } : {},
        ...state.costUsd === void 0 ? {} : { costUsd: state.costUsd },
        ...state.sessionId === void 0 ? {} : { sessionId: state.sessionId },
        events: state.parsedEvents
      };
    };
    if (signal?.aborted === true) {
      return finish(settle("failed", "Claude Code run cancelled before it started.", null));
    }
    if ((input.images?.length ?? 0) > 0) {
      return finish(settle("failed", "Claude Code's headless -p mode has no documented flag for attaching images, so kapel cannot send them through this backend. Use `--backend codex` or the native backend to attach images.", null));
    }
    const candidates = executableCandidates(binary);
    let spawnOutcome = await this.#spawnClaude(candidates[0] ?? binary, args, context.workspacePath, signal, timeoutSignal, state, emit2);
    for (const candidate of candidates.slice(1)) {
      if (spawnOutcome.kind !== "spawn-error" || spawnOutcome.error.code !== "ENOENT") {
        break;
      }
      spawnOutcome = await this.#spawnClaude(candidate, args, context.workspacePath, signal, timeoutSignal, state, emit2);
    }
    if (spawnOutcome.kind === "spawn-error") {
      const error = spawnOutcome.error;
      const enoent = error.code === "ENOENT";
      const summary = enoent ? `Claude Code CLI not found (tried to run "${binary}"). ${INSTALL_HINT}` : `Failed to start the Claude Code CLI ("${binary}"): ${error.message}`;
      return finish(settle("failed", summary, null));
    }
    const { exitCode } = spawnOutcome;
    if (spawnOutcome.timedOut) {
      return finish(settle("failed", `Claude Code run timed out after ${String(timeoutMs)}ms and the process was terminated.`, exitCode));
    }
    if (spawnOutcome.aborted) {
      return finish(settle("failed", "Claude Code run cancelled; the process was terminated.", exitCode));
    }
    if (exitCode === 0) {
      return finish(settle("success", finalText(state) ?? "Claude Code completed with no final message.", exitCode));
    }
    const reason = failureReason(state);
    const hint = modelAccessHint(this.#options.model);
    return finish(settle("failed", `Claude Code exited with code ${String(exitCode)}: ${reason}${hint}`, exitCode));
  }
  #buildArgs(prompt) {
    const permissionMode = this.#options.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--permission-mode",
      permissionMode
    ];
    if (this.#options.verbose !== false)
      args.push("--verbose");
    const model = this.#options.model;
    if (model !== void 0)
      args.push("--model", model);
    const allowedTools = this.#options.allowedTools;
    if (allowedTools !== void 0 && allowedTools.length > 0) {
      args.push("--allowedTools", allowedTools.join(","));
    }
    for (const dir of this.#options.addDirs ?? []) {
      args.push("--add-dir", dir);
    }
    const extra = this.#options.extraArgs;
    if (extra !== void 0)
      args.push(...extra);
    args.push(prompt);
    return args;
  }
  #spawnClaude(binary, args, workspacePath, signal, timeoutSignal, state, emit2) {
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
          pushRawLine(state, trimmed);
          return;
        }
        if (!isRecord(parsed)) {
          pushRawLine(state, trimmed);
          return;
        }
        state.parsedEvents += 1;
        applyLine(parsed, state, emit2);
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
   * Reports whether the Claude Code CLI is installed and whether the user is
   * logged in. Never throws: failures are encoded in `detail`.
   */
  static async checkAvailability(binaryPath) {
    const binary = binaryPath ?? DEFAULT_BINARY;
    const version = await probe(binary, ["--version"]);
    if (!version.ok) {
      const detail = version.spawnFailed ? `Could not run "${binary}". ${INSTALL_HINT}` : `\`${binary} --version\` failed: ${tail(version.detail, 500)}`;
      return { installed: false, loggedIn: false, detail };
    }
    const auth = await probe(binary, ["auth", "status"]);
    if (auth.ok) {
      const detail = tail(`${version.detail}
${auth.detail}`, 500);
      return {
        installed: true,
        loggedIn: true,
        ...detail === "" ? {} : { detail }
      };
    }
    const reason = auth.detail === "" ? "" : ` (${tail(auth.detail, 500)})`;
    return {
      installed: true,
      loggedIn: false,
      detail: `Claude Code CLI is installed but not logged in${reason}. ${LOGIN_HINT}`
    };
  }
};
function pushRawLine(state, line) {
  state.rawLines.push(line.slice(0, MAX_RAW_LINE_CHARS));
  if (state.rawLines.length > MAX_RAW_LINES)
    state.rawLines.shift();
}
function finalText(state) {
  const result = state.finalResult;
  if (result !== void 0 && result.trim() !== "")
    return result;
  const streamed = state.assistantText.trim();
  return streamed === "" ? void 0 : streamed;
}
function failureReason(state) {
  const reported = state.errors.at(-1);
  if (reported !== void 0)
    return reported;
  if (state.stderr.trim() !== "")
    return tail(state.stderr, STDERR_TAIL_CHARS);
  const text2 = finalText(state);
  if (text2 !== void 0)
    return tail(text2, STDERR_TAIL_CHARS);
  if (state.rawLines.length > 0)
    return state.rawLines.slice(-3).join("\n");
  if (state.stopReason !== void 0)
    return `stopped with reason "${state.stopReason}"`;
  return "no error details were reported";
}
function modelAccessHint(model) {
  if (model === void 0)
    return "";
  return ` (model "${model}" was requested \u2014 your account or plan may not have access to it)`;
}
function isFinalResult(line) {
  return typeof line.result === "string" && !isRecord(line.event);
}
function applyLine(line, state, emit2) {
  if (isFinalResult(line)) {
    emit2("claude-code.result", line);
    applyResult(line, state);
    return;
  }
  const event2 = isRecord(line.event) ? line.event : line;
  const kind = firstString(event2.type, line.type) ?? "unknown";
  emit2(`claude-code.${kind}`, line);
  applyStreamEvent(kind, event2, state, emit2);
}
function applyResult(line, state) {
  if (typeof line.result === "string")
    state.finalResult = line.result;
  const sessionId = firstString(line.session_id, line.sessionId);
  if (sessionId !== void 0)
    state.sessionId = sessionId;
  const cost = line.total_cost_usd ?? line.totalCostUsd;
  if (typeof cost === "number" && Number.isFinite(cost))
    state.costUsd = cost;
  if (line.is_error === true) {
    state.errors.push(firstString(line.result, line.subtype) ?? "Claude Code reported an error with no message");
  }
  const usage = isRecord(line.usage) ? line.usage : void 0;
  if (usage !== void 0 && !state.sawUsage) {
    state.sawUsage = true;
    state.inputTokens += toCount(usage.input_tokens) + toCount(usage.cache_read_input_tokens);
    state.outputTokens += toCount(usage.output_tokens);
  }
}
function applyStreamEvent(kind, event2, state, emit2) {
  switch (kind) {
    case "message_start": {
      const message = isRecord(event2.message) ? event2.message : void 0;
      const rawUsage = message === void 0 ? void 0 : message.usage;
      const usage = isRecord(rawUsage) ? rawUsage : void 0;
      if (usage !== void 0) {
        state.sawUsage = true;
        state.inputTokens += toCount(usage.input_tokens) + toCount(usage.cache_read_input_tokens);
        const output = toCount(usage.output_tokens);
        state.outputTokens += output;
        state.messageOutputTokens = output;
      } else {
        state.messageOutputTokens = 0;
      }
      return;
    }
    case "content_block_start": {
      const block = isRecord(event2.content_block) ? event2.content_block : void 0;
      if (block?.type !== "tool_use")
        return;
      const name = firstString(block.name) ?? "unknown";
      emit2("claude-code.tool_use", {
        name,
        ...typeof block.id === "string" ? { id: block.id } : {},
        ...typeof event2.index === "number" ? { index: event2.index } : {}
      });
      return;
    }
    case "content_block_delta": {
      const delta = isRecord(event2.delta) ? event2.delta : void 0;
      if (delta?.type !== "text_delta")
        return;
      if (typeof delta.text === "string")
        state.assistantText += delta.text;
      return;
    }
    case "message_delta": {
      const delta = isRecord(event2.delta) ? event2.delta : void 0;
      const stopReason = firstString(delta?.stop_reason);
      if (stopReason !== void 0)
        state.stopReason = stopReason;
      const usage = isRecord(event2.usage) ? event2.usage : void 0;
      if (usage !== void 0 && typeof usage.output_tokens === "number") {
        const output = toCount(usage.output_tokens);
        if (output >= state.messageOutputTokens) {
          state.sawUsage = true;
          state.outputTokens += output - state.messageOutputTokens;
          state.messageOutputTokens = output;
        }
      }
      return;
    }
    case "error": {
      const error = isRecord(event2.error) ? event2.error : event2;
      state.errors.push(firstString(error.message, error.type, event2.message) ?? "Claude Code reported an error with no message");
      return;
    }
    default:
      return;
  }
}

// packages/coding-agent/dist/backends/codex.js
import { execFile as execFile3, spawn as spawn2 } from "node:child_process";
var DEFAULT_BINARY2 = "codex";
var DEFAULT_SANDBOX = "workspace-write";
var KILL_GRACE_MS2 = 2e3;
var MAX_STDERR_CHARS2 = 5e4;
var MAX_RAW_LINES2 = 20;
var MAX_RAW_LINE_CHARS2 = 500;
var PROBE_TIMEOUT_MS2 = 5e3;
var PROBE_MAX_BUFFER2 = 512 * 1024;
var INSTALL_HINT2 = "Install the Codex CLI with `npm install -g @openai/codex`, then authenticate with `codex login`.";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function firstString2(...values) {
  for (const value of values) {
    if (typeof value === "string" && value !== "")
      return value;
  }
  return void 0;
}
function toCount2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function extractMessageText(item) {
  const direct = firstString2(item.text, item.message, item.content);
  if (direct !== void 0)
    return direct;
  const content = item.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string")
        parts.push(part);
      else if (isRecord2(part) && typeof part.text === "string")
        parts.push(part.text);
    }
    const joined = parts.join("");
    if (joined !== "")
      return joined;
  }
  return void 0;
}
function buildPrompt2(input) {
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
function tail2(text2, limit) {
  const trimmed = text2.trim();
  if (trimmed.length <= limit)
    return trimmed;
  return `...${trimmed.slice(trimmed.length - limit)}`;
}
function probeOnce2(binaryPath, args) {
  return new Promise((resolve5) => {
    execFile3(binaryPath, [...args], { timeout: PROBE_TIMEOUT_MS2, maxBuffer: PROBE_MAX_BUFFER2 }, (error, stdout, stderr) => {
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
async function probe2(binaryPath, args) {
  const candidates = executableCandidates(binaryPath);
  let result = await probeOnce2(candidates[0] ?? binaryPath, args);
  for (const candidate of candidates.slice(1)) {
    if (!result.spawnFailed)
      break;
    result = await probeOnce2(candidate, args);
  }
  return result;
}
var CodexBackend = class {
  #options;
  constructor(options = {}) {
    this.#options = options;
  }
  async run(input, context) {
    const binary = this.#options.binaryPath ?? DEFAULT_BINARY2;
    const timeoutMs = this.#options.timeoutMs;
    const args = this.#buildArgs(input, context.workspacePath);
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
      const summary = enoent ? `Codex CLI not found (tried to run "${binary}"). ${INSTALL_HINT2}` : `Failed to start the Codex CLI ("${binary}"): ${error.message}`;
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
    const reason = failureReason2(state);
    const hint = modelAccessHint2(this.#options.model);
    return finish(settle("failed", `Codex exited with code ${String(exitCode)}: ${reason}${hint}`, exitCode));
  }
  #buildArgs(input, workspacePath) {
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
    const images = input.images ?? [];
    for (const image of images)
      args.push("-i", image.path);
    const extra = this.#options.extraArgs;
    if (extra !== void 0)
      args.push(...extra);
    args.push(buildPrompt2(input));
    return args;
  }
  #spawnCodex(binary, args, workspacePath, signal, timeoutSignal, state, emit2) {
    return new Promise((resolve5) => {
      const child = spawn2(binary, [...args], {
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
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS2);
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
          state.rawLines.push(trimmed.slice(0, MAX_RAW_LINE_CHARS2));
          if (state.rawLines.length > MAX_RAW_LINES2)
            state.rawLines.shift();
          return;
        }
        if (!isRecord2(parsed)) {
          state.rawLines.push(trimmed.slice(0, MAX_RAW_LINE_CHARS2));
          if (state.rawLines.length > MAX_RAW_LINES2)
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
        if (state.stderr.length > MAX_STDERR_CHARS2) {
          state.stderr = state.stderr.slice(0, MAX_STDERR_CHARS2);
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
    const binary = binaryPath ?? DEFAULT_BINARY2;
    const version = await probe2(binary, ["--version"]);
    if (!version.ok) {
      const detail = version.spawnFailed ? `Could not run "${binary}". ${INSTALL_HINT2}` : `\`${binary} --version\` failed: ${tail2(version.detail, 500)}`;
      return { installed: false, loggedIn: false, detail };
    }
    const login = await probe2(binary, ["login", "status"]);
    if (login.ok) {
      const detail = tail2(`${version.detail}
${login.detail}`, 500);
      return {
        installed: true,
        loggedIn: true,
        ...detail === "" ? {} : { detail }
      };
    }
    const reason = login.detail === "" ? "" : ` (${tail2(login.detail, 500)})`;
    return {
      installed: true,
      loggedIn: false,
      detail: `Codex CLI is installed but not logged in${reason}. Run \`codex login\` to authenticate with your ChatGPT account.`
    };
  }
};
function failureReason2(state) {
  const reported = state.errors.at(-1);
  if (reported !== void 0)
    return reported;
  if (state.stderr.trim() !== "")
    return tail2(state.stderr, 1e3);
  if (state.rawLines.length > 0)
    return state.rawLines.slice(-3).join("\n");
  return "no error details were reported";
}
function modelAccessHint2(model) {
  if (model === void 0)
    return "";
  return ` (model "${model}" was requested \u2014 your account or plan may not have access to it)`;
}
function applyEvent(event2, state, emit2) {
  const source = isRecord2(event2.msg) && typeof event2.msg.type === "string" ? event2.msg : event2;
  const kind = typeof source.type === "string" ? source.type : "unknown";
  emit2(`codex.${kind}`, event2);
  const item = isRecord2(source.item) ? source.item : void 0;
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
    state.errors.push(firstString2(source.message, source.error, source.detail) ?? "Codex reported an error with no message");
  }
  const usage = isRecord2(source.usage) ? source.usage : void 0;
  if (usage !== void 0) {
    const inputTokens = toCount2(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = toCount2(usage.output_tokens ?? usage.outputTokens);
    if (inputTokens !== 0 || outputTokens !== 0 || kind.startsWith("turn.")) {
      state.sawUsage = true;
      state.inputTokens += inputTokens;
      state.outputTokens += outputTokens;
    }
  }
}

// packages/coding-agent/dist/loop.js
var DEFAULT_MAX_ITERATIONS = 32;
var MODEL_TEXT_DELTA_EVENT = "model.text.delta";
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
function errorMessage2(error) {
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
var CANCELLED_TOOL_RESULT = "[cancelled before execution]";
function sealUnansweredToolCalls(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === void 0)
      continue;
    if (message.role === "tool")
      continue;
    if (message.role !== "assistant")
      return;
    const calls = message.toolCalls ?? [];
    if (calls.length === 0)
      return;
    const answered = /* @__PURE__ */ new Set();
    for (let j = i + 1; j < messages.length; j += 1) {
      const result = messages[j];
      if (result?.role !== "tool")
        continue;
      if (result.toolCallId !== void 0)
        answered.add(result.toolCallId);
    }
    for (const call of calls) {
      if (answered.has(call.id))
        continue;
      messages.push({
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: CANCELLED_TOOL_RESULT
      });
    }
    return;
  }
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
var AgentLoopEngine = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  /** The fresh-conversation seed: the agent's system prompt plus the user turn. */
  seed(input) {
    const images = input.images ?? [];
    return [
      { role: "system", content: this.#options.agent.systemPrompt },
      {
        role: "user",
        content: buildUserContent(input),
        // `AgentImageAttachment` is a superset of `ImagePart` (it also
        // carries the source `path` delegated backends want), so it rides
        // straight through onto the wire message unchanged.
        ...images.length > 0 ? { images } : {}
      }
    ];
  }
  /**
   * Drives `messages` until the model stops requesting tools, the iteration
   * budget runs out, or the run aborts/fails. Appends every assistant turn and
   * tool result to the array it was given.
   */
  async drive(messages, context) {
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
    let iterations = 0;
    let toolCalls = 0;
    let lastNonEmptyText = "";
    await this.emit(context, "loop.started", {
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
        const turn = await this.#runTurn(request, signal, context, iterations);
        if (turn.text.trim() !== "")
          lastNonEmptyText = turn.text;
        messages.push({
          role: "assistant",
          content: turn.text,
          ...turn.calls.length === 0 ? {} : { toolCalls: turn.calls }
        });
        await this.emit(context, "model.turn.completed", {
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
      sealUnansweredToolCalls(messages);
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
        summary: `Model request failed: ${errorMessage2(error)}`,
        ...lastNonEmptyText === "" ? {} : { output: lastNonEmptyText },
        iterations,
        toolCalls
      });
    }
  }
  /**
   * Streams one model turn, forwarding each text chunk as it arrives.
   *
   * The deltas are emitted *in addition to* the turn's accumulated text, which
   * still lands whole in `model.turn.completed`: a renderer can paint tokens as
   * they come, while everything that reads the event log after the fact (JSONL
   * consumers, session persistence) keeps seeing exactly the turn-level event
   * it always did.
   */
  async #runTurn(request, signal, context, iteration) {
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
            if (event2.text !== "") {
              await this.emit(context, MODEL_TEXT_DELTA_EVENT, {
                text: event2.text,
                iteration
              });
            }
            break;
          case "tool.call":
            calls.push({ id: event2.id, name: event2.name, input: event2.input });
            break;
          case "usage":
            this.#recordUsage(event2, context);
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
  #recordUsage(event2, context) {
    const recorder = this.#options.usage;
    if (recorder === void 0)
      return;
    const usage = {
      inputTokens: event2.inputTokens,
      outputTokens: event2.outputTokens,
      ...event2.cachedInputTokens === void 0 ? {} : { cachedInputTokens: event2.cachedInputTokens }
    };
    recorder.record(this.#options.agent.model, usage, {
      agent: this.#options.agent.name,
      ...context.taskId === void 0 ? {} : { taskId: context.taskId }
    });
  }
  /**
   * Deterministic context compaction, run at the start of every iteration
   * before the request is built. No-op unless `compaction` was supplied, and
   * only once `messages.length` exceeds `maxMessages` — see {@link compactNow}
   * for a version that skips that threshold check.
   */
  async #compact(messages, context) {
    const options = this.#options.compaction;
    if (options === void 0)
      return;
    const maxMessages = options.maxMessages ?? DEFAULT_COMPACTION_MAX_MESSAGES;
    if (messages.length <= maxMessages)
      return;
    await this.#runCompaction(messages, context, options);
  }
  /**
   * Forces one compaction pass over `messages` right now, ignoring the
   * `maxMessages` threshold {@link drive}'s automatic pass respects. Backs
   * the `/compact` slash command: a human asking to compact means "do it
   * now", not "do it once the conversation happens to be long enough".
   *
   * Uses this engine's configured `compaction` tuning (`preserveRecent`,
   * `minContentChars`) when there is one, and this module's own defaults
   * otherwise — so calling it does something sensible even on an engine
   * built with no `compaction` option at all.
   *
   * @returns how many tool results were elided and how many characters were
   * saved, for a caller to render a one-line summary.
   */
  async compactNow(messages, context) {
    return await this.#runCompaction(messages, context, this.#options.compaction ?? {});
  }
  /**
   * The actual elision pass, shared by the automatic (`#compact`) and forced
   * (`compactNow`) entry points.
   *
   * Walks `messages` from the beginning, skipping the system message, the
   * first user message, the last `preserveRecent` messages, and any tool
   * message already elided (its content already carries the elision
   * marker, which also keeps re-running this pass a no-op — but we still
   * skip on sight so the scan stays cheap). Assistant and user/system
   * messages are never touched: providers need the tool-call structure
   * intact, and the instruction must stay legible.
   */
  async #runCompaction(messages, context, options) {
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
      await this.emit(context, "context.compacted", {
        elided,
        savedChars,
        messages: messages.length
      });
    }
    return { elided, savedChars };
  }
  async #executeCall(call, toolsByName, toolContext, context, signal) {
    await this.emit(context, "tool.execution.started", {
      tool: call.name,
      input: call.input
    });
    const tool = toolsByName.get(call.name);
    if (tool === void 0) {
      await this.emit(context, "tool.execution.completed", {
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
      await this.emit(context, "tool.execution.completed", {
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
      await this.emit(context, "tool.execution.completed", {
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
      await this.emit(context, "tool.execution.completed", {
        tool: call.name,
        ok: false
      });
      return {
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `Tool "${call.name}" failed: ${errorMessage2(error)}`
      };
    }
  }
  async #complete(context, result) {
    await this.emit(context, "loop.completed", {
      status: result.status,
      iterations: result.iterations,
      toolCalls: result.toolCalls
    });
    return result;
  }
  /**
   * Best-effort event emission on the configured sink. Public so a session
   * wrapping this engine can emit its own turn events on the same sink.
   *
   * @internal
   */
  async emit(context, type, data) {
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
var AgentLoop = class {
  #engine;
  constructor(options) {
    this.#engine = new AgentLoopEngine(options);
  }
  async run(input, context) {
    return await this.#engine.drive(this.#engine.seed(input), context);
  }
};

// packages/coding-agent/dist/chat.js
function copyMessage(message) {
  return {
    ...message,
    ...message.toolCalls === void 0 ? {} : { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
  };
}
var AgentChatSession = class _AgentChatSession {
  #engine;
  #messages = [];
  #turn = 0;
  #sending = false;
  constructor(options) {
    this.#engine = new AgentLoopEngine(options);
  }
  /**
   * Rebuilds a session from a {@link messages} snapshot. The history is used
   * as-is — no system prompt is re-seeded on top of it — and the next send
   * simply appends a user turn. An empty snapshot yields a session that seeds
   * itself on its first send, exactly like a fresh one.
   */
  static restore(options, messages) {
    const session = new _AgentChatSession(options);
    for (const message of messages)
      session.#messages.push(copyMessage(message));
    return session;
  }
  /**
   * Runs one user turn to completion: the instruction is appended (seeding the
   * system prompt first if the history is empty) and the loop runs until the
   * model stops requesting tools or the per-send iteration budget is spent.
   *
   * On failure or cancellation the messages produced so far are retained so the
   * user can follow up; any tool call the loop abandoned mid-batch is answered
   * with an error result first, keeping the history replayable.
   *
   * @throws if another send on this session is still in flight.
   */
  async send(instruction, context) {
    if (this.#sending) {
      throw new Error("AgentChatSession.send: a send is already in flight; turns must be serialized.");
    }
    this.#sending = true;
    try {
      if (this.#messages.length === 0) {
        this.#messages.push(...this.#engine.seed({ instruction }));
      } else {
        this.#messages.push({ role: "user", content: instruction });
      }
      this.#turn += 1;
      const turn = this.#turn;
      await this.#engine.emit(context, "chat.turn.started", { turn });
      const result = await this.#engine.drive(this.#messages, context);
      await this.#engine.emit(context, "chat.turn.completed", {
        turn,
        status: result.status
      });
      return result;
    } finally {
      this.#sending = false;
    }
  }
  /** A snapshot of the full history, system message included. */
  messages() {
    return this.#messages.map(copyMessage);
  }
  /**
   * Forces an immediate compaction pass over the retained history, ignoring
   * the `maxMessages` threshold a send's automatic pass respects. Backs the
   * `/compact` slash command.
   *
   * Safe to call between sends (nothing is in flight) and on a session with
   * no history yet — there is simply nothing to elide, and it reports zero.
   *
   * @returns how many tool results were elided and how many characters were
   * saved, for the caller to render a one-line summary.
   */
  async compactNow(context) {
    return await this.#engine.compactNow(this.#messages, context);
  }
};

// packages/coding-agent/dist/permissions.js
var DENIED_BY_POLICY = "denied by policy";
var NO_PROMPTER_AVAILABLE = "no prompter available in non-interactive mode";
var DENIED_BY_PROMPTER = "denied by prompter";
var ALLOWED_FOR_SESSION = "allowed for this session";
var BASH_TOOL = "bash";
var SUBCOMMAND = /^[A-Za-z][A-Za-z0-9_:-]*$/;
var SHELL_OPERATORS = /[;&|<>`$(){}\n\r]/;
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function commandOf(input) {
  if (!isRecord3(input))
    return void 0;
  const command = input.command;
  return typeof command === "string" ? command : void 0;
}
function bashCommandPrefix(command) {
  const trimmed = command.trim();
  if (trimmed === "")
    return void 0;
  if (SHELL_OPERATORS.test(trimmed))
    return void 0;
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  if (head === void 0 || head === "" || head.startsWith("-")) {
    return void 0;
  }
  const argument = tokens.slice(1).find((token) => !token.startsWith("-"));
  if (argument === void 0 || !SUBCOMMAND.test(argument))
    return head;
  return `${head} ${argument}`;
}
function parseBashPattern(pattern) {
  const trimmed = pattern.trim();
  if (trimmed === "*")
    return { tokens: [], headOnly: false };
  const tokens = trimmed.split(/\s+/).filter((token) => token !== "");
  const last = tokens[tokens.length - 1];
  if (last === "*" && tokens.length >= 2) {
    const head = tokens.slice(0, -1);
    return { tokens: head, headOnly: head.length === 1 };
  }
  return { tokens, headOnly: false };
}
function bashPatternSpecificity(tokens, headOnly) {
  if (tokens.length === 0)
    return 0;
  if (headOnly)
    return 1;
  return 10 + tokens.length;
}
function bashPatternMatches(tokens, headOnly, derivedPrefix) {
  if (tokens.length === 0)
    return true;
  if (derivedPrefix === void 0)
    return false;
  if (headOnly)
    return derivedPrefix.split(" ")[0] === tokens[0];
  return derivedPrefix === tokens.join(" ");
}
function matchBashPermission(patterns, command) {
  const derivedPrefix = command === void 0 ? void 0 : bashCommandPrefix(command);
  let best;
  let bestSpecificity = -1;
  for (const [pattern, decision] of Object.entries(patterns)) {
    const { tokens, headOnly } = parseBashPattern(pattern);
    if (!bashPatternMatches(tokens, headOnly, derivedPrefix))
      continue;
    const specificity = bashPatternSpecificity(tokens, headOnly);
    const beatsCurrentBest = best === void 0 || specificity > bestSpecificity || specificity === bestSpecificity && decision === "deny" && best.decision !== "deny";
    if (beatsCurrentBest) {
      best = { pattern, decision };
      bestSpecificity = specificity;
    }
  }
  return best;
}
function sessionRuleFor(request) {
  if (request.tool !== BASH_TOOL) {
    return { kind: "tool", tool: request.tool };
  }
  const command = commandOf(request.input);
  if (command === void 0)
    return void 0;
  const prefix = bashCommandPrefix(command);
  return prefix === void 0 ? void 0 : { kind: "bash-prefix", prefix };
}
function describeSessionRule(rule) {
  return rule.kind === "tool" ? rule.tool : `${BASH_TOOL} ${rule.prefix} \u2026`;
}
var SessionAllowlist = class {
  #tools = /* @__PURE__ */ new Set();
  #bashPrefixes = /* @__PURE__ */ new Set();
  /**
   * Records the rule for a request. Returns the rule that was added, or
   * `undefined` when the request could not be generalised — the caller should
   * treat that as "allowed this once" and say so.
   */
  remember(request) {
    const rule = sessionRuleFor(request);
    if (rule === void 0)
      return void 0;
    if (rule.kind === "tool")
      this.#tools.add(rule.tool);
    else
      this.#bashPrefixes.add(rule.prefix);
    return rule;
  }
  allows(request) {
    const rule = sessionRuleFor(request);
    if (rule === void 0)
      return false;
    return rule.kind === "tool" ? this.#tools.has(rule.tool) : this.#bashPrefixes.has(rule.prefix);
  }
  /** Every remembered rule, described, in insertion order. Tools first. */
  entries() {
    return [
      ...[...this.#tools].map((tool) => describeSessionRule({ kind: "tool", tool })),
      ...[...this.#bashPrefixes].map((prefix) => describeSessionRule({ kind: "bash-prefix", prefix }))
    ];
  }
};
function ruleFor(rules, tool) {
  return Object.hasOwn(rules, tool) ? rules[tool] : void 0;
}
var PermissionEngine = class {
  #rules;
  #defaultDecision;
  #prompter;
  #overlay;
  constructor(rules, options = {}) {
    this.#rules = { ...rules };
    this.#defaultDecision = options.defaultDecision ?? "ask";
    this.#prompter = options.prompter;
    this.#overlay = options.overlay;
  }
  /**
   * The verdict for a bare tool name, with no request to match a `bash`
   * pattern map against — equivalent to asking what governs that tool by
   * default, i.e. only the map's `"*"` entry (if any) can answer.
   */
  decisionFor(tool) {
    const rule = ruleFor(this.#rules, tool);
    if (rule === void 0)
      return this.#defaultDecision;
    if (typeof rule === "string")
      return rule;
    return matchBashPermission(rule, void 0)?.decision ?? this.#defaultDecision;
  }
  #decisionForRequest(request) {
    const rule = ruleFor(this.#rules, request.tool);
    if (rule === void 0)
      return this.#defaultDecision;
    if (typeof rule === "string")
      return rule;
    return matchBashPermission(rule, commandOf(request.input))?.decision ?? this.#defaultDecision;
  }
  async authorize(request) {
    const decision = this.#decisionForRequest(request);
    if (decision === "allow")
      return { allowed: true, decision };
    if (decision === "deny")
      return { allowed: false, decision, reason: DENIED_BY_POLICY };
    if (this.#overlay?.allows(request) === true) {
      return { allowed: true, decision, reason: ALLOWED_FOR_SESSION };
    }
    const prompter = this.#prompter;
    if (prompter === void 0) {
      return { allowed: false, decision, reason: NO_PROMPTER_AVAILABLE };
    }
    const approved = await prompter.ask(request);
    return approved ? { allowed: true, decision } : { allowed: false, decision, reason: DENIED_BY_PROMPTER };
  }
};

// packages/coding-agent/dist/planning/delegated-cli.js
function recordDelegatedUsage(sink, result) {
  if (sink === void 0 || result.usage === void 0)
    return;
  sink.recorder.record(sink.model, result.usage, sink.tags);
}
var defaultBackendFactory = (spec) => spec.backend === "codex" ? new CodexBackend(spec.options) : new ClaudeCodeBackend(spec.options);
async function runDelegatedPrompt(options, prompt, signal) {
  const { events: events2, timeoutMs, model, workspacePath, runId } = options;
  const shared = {
    ...model === void 0 ? {} : { model },
    ...events2 === void 0 ? {} : { events: events2 },
    ...timeoutMs === void 0 ? {} : { timeoutMs }
  };
  const spec = options.backend === "codex" ? { backend: "codex", options: { ...shared, sandbox: "read-only" } } : {
    backend: "claude-code",
    options: { ...shared, permissionMode: "plan" }
  };
  const backend = (options.createBackend ?? defaultBackendFactory)(spec);
  try {
    return await backend.run({ instruction: prompt }, {
      runId,
      workspacePath,
      ...signal === void 0 ? {} : { signal }
    });
  } catch (error) {
    return {
      status: "failed",
      summary: `The ${options.backend} CLI could not be run: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
function formatIssues3(issues) {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
}
function issuesFromZodError(error) {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message
  }));
}
function extractJsonObject(text2) {
  const trimmed = text2.trim();
  if (trimmed === "")
    return void 0;
  const fenced = /```(?:[a-zA-Z]+)?[ \t]*\r?\n([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start)
    return void 0;
  return body.slice(start, end + 1);
}
function buildJsonOutputContract(args) {
  const rules = [
    `- There is no ${args.toolName} tool here: you are answering through a CLI, so "emit the ${args.subject}" means replying with the ${args.subject} as JSON.`,
    "- Reply with ONLY a single JSON object matching the schema below. No prose, no explanation, no markdown fences, nothing before or after the object.",
    "- Do not edit, create or delete any file. Read whatever you need to understand the repository, then answer.",
    ...args.extraRules ?? []
  ];
  return `Output contract:
${rules.join("\n")}

JSON Schema for the object:
${args.schema}`;
}
function buildRetrySection(rejection, subject) {
  return `Your previous reply was not a usable ${subject}.

Previous reply:
${rejection.reply}

Problems with it:
${formatIssues3(rejection.issues)}

Reply again with a corrected ${subject} that fixes every problem above, as a single JSON object and nothing else.`;
}
function stringifyPromptSchema(generated) {
  const schema = {};
  for (const [key, value] of Object.entries(generated)) {
    if (key !== "$schema")
      schema[key] = value;
  }
  return JSON.stringify(schema, null, 2);
}

// packages/coding-agent/dist/planning/delegated-planner.js
import { z as z6 } from "zod";
var DEFAULT_MAX_ATTEMPTS3 = 3;
var PLAN_JSON_SCHEMA = (() => {
  const generated = z6.toJSONSchema(ExecutionPlanSchema, {
    io: "input"
  });
  return stringifyPromptSchema({
    ...generated,
    required: ["objective", "tasks"]
  });
})();
function toPlannedTask2(draft) {
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
function buildDelegatedPlannerPrompt(args) {
  const sections = [
    buildPlannerSystemPrompt(args.policy, args.knownAgents),
    buildJsonOutputContract({
      toolName: EMIT_PLAN_TOOL_NAME,
      subject: "plan",
      schema: PLAN_JSON_SCHEMA
    }),
    `Objective to plan:

${args.objective}`
  ];
  const { rejection } = args;
  if (rejection !== void 0) {
    sections.push(buildRetrySection(rejection, "plan"));
  }
  return sections.join("\n\n");
}
var DelegatedPlanner = class {
  #options;
  #runId;
  constructor(options) {
    this.#options = options;
    this.#runId = options.runId ?? crypto.randomUUID();
  }
  async plan(objective, policy, signal) {
    const maxAttempts = Math.max(1, this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS3);
    const { knownAgents } = this.#options;
    let rejection;
    let lastIssues;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const prompt = buildDelegatedPlannerPrompt({
        objective,
        policy,
        knownAgents,
        ...rejection === void 0 ? {} : { rejection }
      });
      const run = await this.#run(prompt, signal);
      recordDelegatedUsage(this.#options.usage, run);
      signal?.throwIfAborted();
      const reply = run.output ?? run.summary;
      if (run.status === "failed") {
        lastIssues = [{ path: "(root)", message: run.summary }];
        rejection = { reply, issues: lastIssues };
        continue;
      }
      const outcome = this.#interpret(reply);
      if ("plan" in outcome)
        return outcome.plan;
      lastIssues = outcome.issues;
      rejection = { reply, issues: outcome.issues };
    }
    throw new PlanError({
      message: `Failed to plan the objective after ${maxAttempts} attempt(s).${lastIssues === void 0 ? "" : `
${formatIssues3(lastIssues)}`}`,
      attempts: maxAttempts,
      ...lastIssues === void 0 ? {} : { lastIssues }
    });
  }
  /** Parses one reply into a plan, or into the issues that rejected it. */
  #interpret(reply) {
    const json = extractJsonObject(reply);
    if (json === void 0) {
      return {
        issues: [
          {
            path: "(root)",
            message: "the reply contained no JSON object; reply with the plan object itself and nothing else"
          }
        ]
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return {
        issues: [
          {
            path: "(root)",
            message: `the reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
    const validated = ExecutionPlanSchema.safeParse(parsed);
    if (!validated.success) {
      return { issues: issuesFromZodError(validated.error) };
    }
    const plan = {
      objective: validated.data.objective,
      tasks: validated.data.tasks.map(toPlannedTask2)
    };
    const issues = validatePlanDraft(plan, this.#options.knownAgents);
    return issues.length === 0 ? { plan } : { issues };
  }
  /** Runs one attempt through the delegating CLI. */
  async #run(prompt, signal) {
    const { events: events2, timeoutMs, model, workspacePath, createBackend } = this.#options;
    return await runDelegatedPrompt({
      backend: this.#options.backend,
      workspacePath,
      runId: this.#runId,
      ...model === void 0 ? {} : { model },
      ...events2 === void 0 ? {} : { events: events2 },
      ...timeoutMs === void 0 ? {} : { timeoutMs },
      ...createBackend === void 0 ? {} : { createBackend }
    }, prompt, signal);
  }
};

// packages/coding-agent/dist/planning/delegated-policy-compiler.js
var DEFAULT_MAX_ATTEMPTS4 = 3;
var POLICY_JSON_SCHEMA = stringifyPromptSchema(buildPolicyToolInputSchema());
function buildDelegatedPolicyCompilerPrompt(args) {
  const sections = [
    buildPolicyCompilerSystemPrompt(args.knownAgents),
    buildJsonOutputContract({
      toolName: EMIT_POLICY_TOOL_NAME,
      subject: "compiled policy",
      schema: POLICY_JSON_SCHEMA,
      extraRules: [
        "- The object has three top-level keys: policy, warnings and ambiguities. Always include all three; warnings and ambiguities are empty arrays when there is nothing to report."
      ]
    }),
    `Compile this orchestration policy:

${args.markdown}`
  ];
  const { rejection } = args;
  if (rejection !== void 0) {
    sections.push(buildRetrySection(rejection, "policy"));
  }
  return sections.join("\n\n");
}
var DelegatedPolicyCompiler = class {
  #options;
  #runId;
  constructor(options) {
    this.#options = options;
    this.#runId = options.runId ?? crypto.randomUUID();
  }
  async compile(markdown, signal) {
    const maxAttempts = Math.max(1, this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS4);
    const { knownAgents } = this.#options;
    let rejection;
    let lastIssues;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const prompt = buildDelegatedPolicyCompilerPrompt({
        markdown,
        knownAgents,
        ...rejection === void 0 ? {} : { rejection }
      });
      const run = await this.#run(prompt, signal);
      recordDelegatedUsage(this.#options.usage, run);
      signal?.throwIfAborted();
      const reply = run.output ?? run.summary;
      if (run.status === "failed") {
        lastIssues = [{ path: "(root)", message: run.summary }];
        rejection = { reply, issues: lastIssues };
        continue;
      }
      const outcome = this.#interpret(reply);
      if ("result" in outcome)
        return outcome.result;
      lastIssues = outcome.issues;
      rejection = { reply, issues: outcome.issues };
    }
    throw new PolicyCompileError({
      message: `Failed to compile the orchestration policy after ${maxAttempts} attempt(s).${lastIssues === void 0 ? "" : `
${formatIssues3(lastIssues)}`}`,
      attempts: maxAttempts,
      ...lastIssues === void 0 ? {} : { lastIssues }
    });
  }
  /** Parses one reply into a compile result, or into the issues that rejected it. */
  #interpret(reply) {
    const json = extractJsonObject(reply);
    if (json === void 0) {
      return {
        issues: [
          {
            path: "(root)",
            message: "the reply contained no JSON object; reply with the policy object itself and nothing else"
          }
        ]
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return {
        issues: [
          {
            path: "(root)",
            message: `the reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
    return parsePolicyDraft(parsed);
  }
  /** Runs one attempt through the delegating CLI. */
  async #run(prompt, signal) {
    const { events: events2, timeoutMs, model, workspacePath, createBackend } = this.#options;
    return await runDelegatedPrompt({
      backend: this.#options.backend,
      workspacePath,
      runId: this.#runId,
      ...model === void 0 ? {} : { model },
      ...events2 === void 0 ? {} : { events: events2 },
      ...timeoutMs === void 0 ? {} : { timeoutMs },
      ...createBackend === void 0 ? {} : { createBackend }
    }, prompt, signal);
  }
};

// packages/coding-agent/dist/project/index.js
import { readFile as readFile3, stat } from "node:fs/promises";
import { join as join3 } from "node:path";

// packages/coding-agent/dist/project/agents.js
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z as z7 } from "zod";

// packages/coding-agent/dist/project/internal.js
function isNotFound(err) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
function formatZodIssues(error) {
  return error.issues.map((issue) => {
    const path19 = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path19}: ${issue.message}`;
  });
}

// packages/coding-agent/dist/project/agents.js
var AGENT_ROLES = /* @__PURE__ */ new Set([
  "orchestrator",
  "worker",
  "reviewer"
]);
var AgentFrontMatterSchema = z7.object({
  name: z7.string().min(1, "must not be empty"),
  model: z7.string().min(1, "must not be empty"),
  role: z7.string().min(1, "must not be empty"),
  tools: z7.array(z7.string()).default([])
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
    const raw = await readFile(filePath, "utf8");
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
import { readFile as readFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { parse as parseYaml2 } from "yaml";
import { z as z8 } from "zod";

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
var ModelRefSchema = z8.object({
  provider: z8.string().min(1, "must not be empty"),
  model: z8.string().min(1, "must not be empty")
}).strict();
var ValidatorSchema = z8.object({
  name: z8.string().min(1, "must not be empty"),
  command: z8.string().min(1, "must not be empty"),
  timeoutSeconds: z8.number().int().positive().optional()
}).strict();
var PermissionDecisionSchema = z8.enum(["allow", "ask", "deny"]);
var BashPermissionRulesSchema = z8.record(z8.string(), PermissionDecisionSchema);
var ToolPermissionRuleSchema = z8.union([
  PermissionDecisionSchema,
  BashPermissionRulesSchema
]);
var PermissionSchema = z8.record(z8.string(), ToolPermissionRuleSchema);
var ConfigFileSchema = z8.object({
  models: z8.record(z8.string(), ModelRefSchema).optional(),
  agents: z8.record(z8.string(), z8.string().min(1, "must not be empty")).optional(),
  validation: z8.array(ValidatorSchema).optional(),
  permission: PermissionSchema.optional()
}).strict();
var EMPTY_CONFIG = {
  models: {},
  agentSlots: {},
  validators: [],
  permission: {}
};
async function loadProjectConfig(agentDir) {
  const filePath = join2(agentDir, "config.yaml");
  let raw;
  try {
    raw = await readFile2(filePath, "utf8");
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
    validators,
    permission: { ...result.data.permission ?? {} }
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
    return await readFile3(join3(agentDir, "orchestration.md"), "utf8");
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
import { spawn as spawn3 } from "node:child_process";
import { z as z10 } from "zod";

// packages/coding-agent/dist/tools/json-schema.js
import { z as z9 } from "zod";
function toInputSchema(schema) {
  const jsonSchema = z9.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

// packages/coding-agent/dist/tools/bash.js
var DEFAULT_TIMEOUT_MS = 12e4;
var MAX_TIMEOUT_MS = 6e5;
var MAX_OUTPUT_CHARS = 1e5;
var KILL_GRACE_MS3 = 2e3;
var InputSchema = z10.object({
  command: z10.string().min(1).describe("Shell command to run in the workspace (bash -lc on POSIX, cmd.exe /c on Windows)."),
  timeoutMs: z10.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe("Maximum time to allow the command to run, in milliseconds. Defaults to 120000, max 600000.")
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
      const child = spawn3(shell.command, [...shell.args], {
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
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS3).unref();
      }, timeoutMs);
      timeoutTimer.unref();
      const onAbort = () => {
        aborted = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS3).unref();
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
import { readFile as readFile4, writeFile } from "node:fs/promises";
import { z as z11 } from "zod";

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
var InputSchema2 = z11.object({
  path: z11.string().min(1).describe("Workspace-relative path of the file to edit."),
  oldText: z11.string().min(1).describe("Exact, non-empty text to find in the file."),
  newText: z11.string().describe("Text to replace `oldText` with. Must differ from oldText."),
  replaceAll: z11.boolean().optional().describe("If true, replace every occurrence of oldText. If false/omitted, oldText must occur exactly once in the file.")
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
      raw = await readFile4(target, "utf8");
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
import { execFile as execFile4 } from "node:child_process";
import { promisify } from "node:util";
import { z as z12 } from "zod";
var execFileAsync = promisify(execFile4);
var MAX_DIFF_CHARS = 2e5;
var MAX_BUFFER_BYTES = 10 * 1024 * 1024;
var InputSchema3 = z12.object({
  staged: z12.boolean().optional().describe("If true, diff the staged (index) changes via `git diff --cached`."),
  path: z12.string().optional().describe("Optional workspace-relative path to restrict the diff to.")
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
import { z as z13 } from "zod";

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
var InputSchema4 = z13.object({
  pattern: z13.string().min(1).describe("Glob pattern to match, e.g. `src/**/*.ts`. Supports `*`, `**`, and `?`."),
  cwd: z13.string().optional().describe("Workspace-relative directory to search from. Defaults to the workspace root.")
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
import { readdir as readdir3, readFile as readFile5, stat as stat2 } from "node:fs/promises";
import { basename as basename2, join as join5 } from "node:path";
import { z as z14 } from "zod";
var DEFAULT_MAX_MATCHES = 200;
var MAX_LINE_CHARS = 500;
var BINARY_SNIFF_BYTES = 8e3;
var SKIPPED_DIR_NAMES2 = /* @__PURE__ */ new Set(["node_modules", ".git"]);
var InputSchema5 = z14.object({
  pattern: z14.string().min(1).describe("JavaScript regular expression source to search for."),
  path: z14.string().optional().describe("Workspace-relative file or directory to search. Defaults to the workspace root."),
  glob: z14.string().optional().describe("Optional glob (e.g. `**/*.ts`) to restrict which files are searched."),
  ignoreCase: z14.boolean().optional().describe("Case-insensitive matching."),
  maxMatches: z14.number().int().positive().optional().describe("Maximum number of matches to return. Defaults to 200.")
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
        buf = await readFile5(absoluteFile);
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
import { readFile as readFile6 } from "node:fs/promises";
import { z as z15 } from "zod";
var MAX_CONTENT_CHARS = 2e5;
var InputSchema6 = z15.object({
  path: z15.string().min(1).describe("Workspace-relative path of the file to read."),
  offset: z15.number().int().positive().optional().describe("1-based line number to start reading from. Defaults to the first line."),
  limit: z15.number().int().positive().optional().describe("Maximum number of lines to return.")
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
      raw = await readFile6(target, "utf8");
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
import { z as z16 } from "zod";
var InputSchema7 = z16.object({
  path: z16.string().min(1).describe("Workspace-relative path of the file to write."),
  content: z16.string().describe("The full UTF-8 text content to write to the file.")
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
import { spawn as spawn4 } from "node:child_process";
var MAX_VALIDATOR_OUTPUT_CHARS = 2e4;
var TRUNCATION_MARKER = "...[earlier output truncated]\n";
var KILL_GRACE_MS4 = 2e3;
function capTail(text2, alreadyDropped) {
  if (!alreadyDropped && text2.length <= MAX_VALIDATOR_OUTPUT_CHARS)
    return text2;
  const budget = MAX_VALIDATOR_OUTPUT_CHARS - TRUNCATION_MARKER.length;
  return `${TRUNCATION_MARKER}${text2.slice(Math.max(0, text2.length - budget))}`;
}
function errorMessage3(error) {
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
      child = spawn4(shell.command, [...shell.args], {
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
        output: `Could not start the validator: ${errorMessage3(error)}`,
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
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS4).unref();
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
Could not run the validator: ${errorMessage3(error)}`
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
function errorMessage4(error) {
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
  /** A pass-through decorator: whatever the inner executor knows, it knows too. */
  describeAgent(agent) {
    return this.#options.inner.describeAgent?.(agent);
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
          `Validation could not be run: ${errorMessage4(error)}`
        ],
        confidence: FAILED_VALIDATION_CONFIDENCE
      };
    }
    return report.passed ? withPassedValidation(result, report) : withFailedValidation(result, report);
  }
};

// packages/coding-agent/dist/workers/review.js
import { z as z17 } from "zod";
var REVIEW_VERDICT_TOOL_NAME = "submit_review_verdict";
var REJECTED_CONFIDENCE = 0.9;
var NO_VERDICT_CONFIDENCE = 0.1;
var NO_VERDICT_SUMMARY = "review completed without submitting a verdict";
var IssueSchema = z17.object({
  severity: z17.enum(["blocking", "advisory"]).describe("`blocking` means the change must not ship as-is; `advisory` is a suggestion."),
  description: z17.string().min(1).describe("What is wrong, specific enough to act on.")
}).strict();
var InputSchema8 = z17.object({
  approved: z17.boolean().describe("true only when the change is acceptable as it stands. Any blocking issue means false."),
  summary: z17.string().min(1).describe("One short paragraph explaining the decision."),
  issues: z17.array(IssueSchema).default([]).describe("Every problem found, blocking ones first.")
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
function buildWorkerSystemPrompt(systemPrompt) {
  const base = systemPrompt.trim();
  return base === "" ? WORKER_SYSTEM_POSTAMBLE : `${base}

${WORKER_SYSTEM_POSTAMBLE}`;
}

// packages/coding-agent/dist/workers/normalize.js
import { execFile as execFile5 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile5);
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
    const path19 = record.slice(3);
    if (path19 !== "")
      paths.add(path19);
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
function errorMessage5(error) {
  return error instanceof Error ? error.message : String(error);
}
var AgentLoopWorkerExecutor = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  /**
   * The model `agent`'s `.agent/agents/<name>.md` front matter points at,
   * resolved the same way {@link execute} resolves it. `undefined` for an
   * unknown agent or an unresolvable model alias — both are reported as task
   * failures once the task actually runs, so this is silent about them rather
   * than throwing ahead of that.
   */
  describeAgent(agent) {
    const projectAgent = this.#options.project.agent(agent);
    if (projectAgent === void 0)
      return void 0;
    try {
      const resolved = this.#options.resolveModel(projectAgent.modelAlias);
      return { model: resolved.model.id };
    } catch {
      return void 0;
    }
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
      return failedTaskResult(taskId, `Could not resolve model alias "${projectAgent.modelAlias}" for agent ${agent}: ${errorMessage5(error)}`);
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
        summary: `Agent loop crashed: ${errorMessage5(error)}`
      };
    }
    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    const result = normalizeTaskResult({ taskId, loop: run, inspection });
    return verdictTool === void 0 ? result : applyReviewVerdict(result, verdictTool.verdict());
  }
};

// packages/coding-agent/dist/workers/child-process-executor.js
import { spawn as spawn5 } from "node:child_process";

// packages/coding-agent/dist/workers/protocol.js
import { z as z18 } from "zod";
var PlannedTaskSchema2 = z18.object({
  id: z18.string(),
  title: z18.string(),
  goal: z18.string(),
  type: z18.enum([
    "exploration",
    "architecture",
    "implementation",
    "testing",
    "review",
    "documentation"
  ]),
  complexity: z18.enum(["trivial", "normal", "complex", "architectural"]),
  dependencies: z18.array(z18.string()),
  suggestedAgent: z18.string().optional(),
  affectedAreas: z18.array(z18.string()),
  risk: z18.object({
    level: z18.enum(["low", "medium", "high"]),
    categories: z18.array(z18.string())
  })
});
var TaskResultSchema = z18.object({
  taskId: z18.string(),
  status: z18.enum(["success", "failed", "partial"]),
  summary: z18.string(),
  decisions: z18.array(z18.string()),
  changedFiles: z18.array(z18.string()),
  commit: z18.string().optional(),
  tests: z18.object({
    passed: z18.number(),
    failed: z18.number(),
    commands: z18.array(z18.string())
  }),
  unresolvedIssues: z18.array(z18.string()),
  confidence: z18.number()
});
var WorkerRequestSchema = z18.object({
  type: z18.literal("task"),
  task: PlannedTaskSchema2,
  agent: z18.string(),
  runId: z18.string(),
  workspacePath: z18.string(),
  timeoutMs: z18.number().optional(),
  /**
   * Results of the task's direct dependencies, in dependency-declaration order.
   * Optional on purpose: a parent that predates dependency context (or a task
   * with no dependencies) sends a request without it, and that stays valid.
   */
  dependencyResults: z18.array(TaskResultSchema).optional()
});
var WorkerEventLineSchema = z18.object({
  type: z18.literal("event"),
  event: AgentEventSchema
});
var WorkerResultLineSchema = z18.object({
  type: z18.literal("result"),
  result: TaskResultSchema
});
var WorkerStdoutLineSchema = z18.discriminatedUnion("type", [
  WorkerEventLineSchema,
  WorkerResultLineSchema
]);
function toPlannedTask3(parsed) {
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
      if (!emitEvents)
        return;
      if (event2.type === MODEL_TEXT_DELTA_EVENT)
        return;
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
var KILL_GRACE_MS5 = 2e3;
var MAX_STDERR_CHARS3 = 5e4;
var STDERR_TAIL_CHARS2 = 2e3;
function tail3(text2, limit) {
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
      const child = spawn5(executable, [...command.slice(1)], {
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
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS5);
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
        if (stderr.length > MAX_STDERR_CHARS3) {
          stderr = stderr.slice(0, MAX_STDERR_CHARS3);
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
    const stderrTail = stderr.trim() === "" ? "" : ` stderr: ${tail3(stderr, STDERR_TAIL_CHARS2)}`;
    if (outcome.timedOut === true) {
      return failedTaskResult(taskId, `Worker process timed out after ${String(taskTimeoutMs)}ms and was terminated.${stderrTail}`);
    }
    if (outcome.aborted === true) {
      return failedTaskResult(taskId, `Worker process was cancelled and terminated.${stderrTail}`);
    }
    return failedTaskResult(taskId, `Worker process exited with code ${String(outcome.exitCode)} without returning a result.${stderrTail}`);
  }
};

// packages/coding-agent/dist/workers/claude-code-executor.js
var TEMPLATE_TOOL_TO_CLAUDE_CODE = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  glob: "Glob",
  bash: "Bash",
  // Claude Code has no dedicated diff tool; `git diff` is a bash invocation,
  // scoped to that one command by the `Bash(<prefix>:*)` specifier syntax.
  "git.diff": "Bash(git diff:*)"
};
var TEMPLATE_NAMESPACE_TO_CLAUDE_CODE = {
  git: "Bash(git:*)"
};
function canonicalize2(name) {
  return name.toLowerCase().replaceAll("_", ".");
}
function claudeCodeAllowedTools(patterns) {
  if (patterns.length === 0)
    return void 0;
  const allowed = /* @__PURE__ */ new Set();
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === "")
      continue;
    const canonical = canonicalize2(trimmed);
    if (canonical.endsWith(".*")) {
      const mapped2 = TEMPLATE_NAMESPACE_TO_CLAUDE_CODE[canonical.slice(0, -2)];
      if (mapped2 !== void 0)
        allowed.add(mapped2);
      continue;
    }
    const mapped = TEMPLATE_TOOL_TO_CLAUDE_CODE[canonical];
    if (mapped !== void 0)
      allowed.add(mapped);
  }
  return allowed.size === 0 ? void 0 : [...allowed];
}
function createDelegatedToolsResolver(project) {
  return (agent) => {
    const projectAgent = project.agent(agent);
    if (projectAgent === void 0)
      return void 0;
    return claudeCodeAllowedTools(projectAgent.tools);
  };
}
var ClaudeCodeWorkerExecutor = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  /**
   * The model {@link resolveAgentModel} would resolve for `agent`, falling
   * back to `backendOptions.model` — the same precedence {@link execute}
   * applies when it builds the {@link ClaudeCodeBackend} for a task, exposed
   * here so it can be reported before the task actually runs.
   */
  #modelFor(agent) {
    return this.#options.resolveAgentModel?.(agent) ?? this.#options.backendOptions?.model;
  }
  /** The `--allowedTools` list for `agent`; see {@link resolveAgentTools}. */
  #toolsFor(agent) {
    return this.#options.resolveAgentTools?.(agent) ?? this.#options.backendOptions?.allowedTools;
  }
  describeAgent(agent) {
    const model = this.#modelFor(agent);
    return model === void 0 ? void 0 : { model };
  }
  async execute(task, agent, signal, context) {
    const taskId = task.spec.id;
    const { workspacePath, runId } = this.#options;
    const model = this.#modelFor(agent);
    const allowedTools = this.#toolsFor(agent);
    const backend = new ClaudeCodeBackend({
      ...this.#options.backendOptions,
      ...model === void 0 ? {} : { model },
      ...allowedTools === void 0 ? {} : { allowedTools },
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
        summary: `Claude Code backend crashed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    return normalizeTaskResult({ taskId, loop: run, inspection });
  }
};

// packages/coding-agent/dist/workers/codex-executor.js
var CodexWorkerExecutor = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  /**
   * The model {@link resolveAgentModel} would resolve for `agent`, falling
   * back to `backendOptions.model` — the same precedence {@link execute}
   * applies when it builds the {@link CodexBackend} for a task, exposed here
   * so it can be reported before the task actually runs.
   */
  #modelFor(agent) {
    return this.#options.resolveAgentModel?.(agent) ?? this.#options.backendOptions?.model;
  }
  describeAgent(agent) {
    const model = this.#modelFor(agent);
    return model === void 0 ? void 0 : { model };
  }
  async execute(task, agent, signal, context) {
    const taskId = task.spec.id;
    const { workspacePath, runId } = this.#options;
    const model = this.#modelFor(agent);
    const backend = new CodexBackend({
      ...this.#options.backendOptions,
      ...model === void 0 ? {} : { model },
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

// packages/coding-agent/dist/workers/delegated-model.js
var DEFAULT_MODEL_SENTINEL = "default";
function createDelegatedModelResolver(project) {
  return (agent) => {
    const projectAgent = project.agent(agent);
    if (projectAgent === void 0)
      return void 0;
    const ref = project.config.models[projectAgent.modelAlias];
    if (ref === void 0)
      return void 0;
    if (ref.model === DEFAULT_MODEL_SENTINEL)
      return void 0;
    return ref.model;
  };
}

// packages/workspace/dist/index.js
import { execFile as execFile7 } from "node:child_process";
import { promisify as promisify4 } from "node:util";

// packages/workspace/dist/worktrees.js
import { mkdir as mkdir2, rm, rmdir } from "node:fs/promises";
import { dirname as dirname2, isAbsolute as isAbsolute3, join as join6, relative as relative3, resolve as resolve3, sep as sep3 } from "node:path";

// packages/workspace/dist/git.js
import { execFile as execFile6 } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute as isAbsolute2, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
import { promisify as promisify3 } from "node:util";
var execFileAsync3 = promisify3(execFile6);
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
  let path19;
  let branch;
  const flush = () => {
    if (path19 !== void 0) {
      entries.push({ path: path19, branch });
    }
    path19 = void 0;
    branch = void 0;
  };
  for (const line of stdout.split("\n")) {
    const value = line.trimEnd();
    if (value.startsWith("worktree ")) {
      flush();
      path19 = value.slice("worktree ".length);
    } else if (value.startsWith("branch refs/heads/")) {
      branch = value.slice("branch refs/heads/".length);
    }
  }
  flush();
  return entries;
}
async function realPathOrSelf(path19) {
  try {
    return await realpath(path19);
  } catch {
    return resolve2(path19);
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
    const path19 = join6(this.worktreesDir, safeRunId, safeTaskId);
    const baseCommit = await this.#requireRepoHead(signal);
    await this.#removeLeftovers(path19, branch, signal);
    await mkdir2(dirname2(path19), { recursive: true });
    await runGit2(["worktree", "add", path19, "-b", branch, baseCommit], {
      cwd: this.repoRoot,
      operation: "create",
      signal
    });
    return { path: path19, branch, baseCommit, runId: safeRunId, taskId: safeTaskId };
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
  async #removeLeftovers(path19, branch, signal) {
    await tryGit(["worktree", "remove", "--force", path19], {
      cwd: this.repoRoot,
      operation: "create.cleanup-worktree",
      signal
    });
    await rm(path19, { recursive: true, force: true });
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
      const path19 = record.length > 3 && record[2] === " " ? record.slice(3) : record;
      if (ignored !== void 0 && path19.startsWith(ignored)) {
        continue;
      }
      paths.push(path19);
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
var execFileAsync4 = promisify4(execFile7);

// packages/coding-agent/dist/workers/worktree-executor.js
var MAX_LISTED_FILES = 10;
function errorMessage6(error) {
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
  /**
   * Delegates to a throwaway inner executor rooted at `repoRoot` — cheap,
   * since building one is just constructing an object, and what an agent's
   * model is does not depend on which worktree it eventually runs in.
   */
  describeAgent(agent) {
    return this.#options.createExecutor(this.#options.repoRoot).describeAgent?.(agent);
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
      return failedTaskResult(taskId, `Could not create an isolated worktree for ${taskId}: ${errorMessage6(error)}`);
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
      return failedTaskResult(task.spec.id, `Worker crashed inside the task worktree: ${errorMessage6(error)}`);
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
          `Could not collect the task worktree: ${errorMessage6(error)}`,
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
          `Could not merge the task branch into the base: ${errorMessage6(error)}`,
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

// apps/cli/dist/backend.js
var BACKEND_NAMES = ["native", "codex", "claude-code"];
var DEFAULT_BACKEND = "native";
function isBackendName(value) {
  return BACKEND_NAMES.includes(value);
}
function isDelegatedBackend(backend) {
  return backend === "codex" || backend === "claude-code";
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
function claudeCodeInstallGuidance(availability) {
  const lines = [
    "The Claude Code CLI is not installed.",
    "Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in with your Claude subscription."
  ];
  if (availability.detail !== void 0 && availability.detail !== "") {
    lines.push(availability.detail);
  }
  return lines.join("\n");
}
function claudeCodeLoginGuidance(availability) {
  const lines = [
    "The Claude Code CLI is installed but you are not logged in.",
    "Run `claude` once and log in with your Claude subscription \u2014 no Anthropic API key needed."
  ];
  if (availability.detail !== void 0 && availability.detail !== "") {
    lines.push(availability.detail);
  }
  return lines.join("\n");
}
function delegatedModelIdentity(backend, model) {
  return {
    provider: backend === "codex" ? "openai" : "anthropic",
    id: model ?? `<${backend} default>`,
    capabilities: {
      tools: false,
      reasoning: false,
      vision: false,
      structuredOutput: false
    }
  };
}
async function delegatedBackendError(backend) {
  if (backend === "claude-code") {
    const availability2 = await ClaudeCodeBackend.checkAvailability();
    if (!availability2.installed)
      return claudeCodeInstallGuidance(availability2);
    if (!availability2.loggedIn)
      return claudeCodeLoginGuidance(availability2);
    return void 0;
  }
  const availability = await CodexBackend.checkAvailability();
  if (!availability.installed)
    return codexInstallGuidance(availability);
  if (!availability.loggedIn)
    return codexLoginGuidance(availability);
  return void 0;
}

// apps/cli/dist/config.js
import { chmod, mkdir as mkdir3, readFile as readFile7, writeFile as writeFile3 } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

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

// packages/ai/dist/image.js
function matchesMagic(bytes, offset, magic) {
  if (bytes.length < offset + magic.length)
    return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i])
      return false;
  }
  return true;
}
var PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
var JPEG_MAGIC = [255, 216, 255];
var GIF87_MAGIC = [71, 73, 70, 56, 55, 97];
var GIF89_MAGIC = [71, 73, 70, 56, 57, 97];
var RIFF_MAGIC = [82, 73, 70, 70];
var WEBP_MAGIC = [87, 69, 66, 80];
function sniffImageMediaType(bytes) {
  if (matchesMagic(bytes, 0, PNG_MAGIC))
    return "image/png";
  if (matchesMagic(bytes, 0, JPEG_MAGIC))
    return "image/jpeg";
  if (matchesMagic(bytes, 0, GIF87_MAGIC) || matchesMagic(bytes, 0, GIF89_MAGIC)) {
    return "image/gif";
  }
  if (matchesMagic(bytes, 0, RIFF_MAGIC) && matchesMagic(bytes, 8, WEBP_MAGIC)) {
    return "image/webp";
  }
  return void 0;
}
var EXTENSION_MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};
function mediaTypeFromExtension(filePath) {
  const match = /\.[^./\\]+$/.exec(filePath);
  const ext = match?.[0]?.toLowerCase();
  return ext === void 0 ? void 0 : EXTENSION_MEDIA_TYPES[ext];
}
function resolveImageMediaType(bytes, filePath) {
  return sniffImageMediaType(bytes) ?? mediaTypeFromExtension(filePath);
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
function isRecord4(value) {
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
      case "user": {
        const images = message.images ?? [];
        if (images.length === 0) {
          wire.push({ role: "user", content: message.content });
          break;
        }
        const blocks = images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.base64
          }
        }));
        if (message.content !== "")
          blocks.push({ type: "text", text: message.content });
        wire.push({ role: "user", content: blocks });
        break;
      }
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
      if (!isRecord4(usage))
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
      if (!isRecord4(payload))
        continue;
      const type = typeof payload.type === "string" ? payload.type : message.event ?? "";
      if (type === "error") {
        const error = isRecord4(payload.error) ? payload.error : void 0;
        const detail = error !== void 0 && typeof error.message === "string" ? error.message : "Anthropic stream error";
        throw new ProviderError({
          provider: this.id,
          status: response.status,
          message: detail,
          body: message.data
        });
      }
      if (type === "message_start") {
        const wrapped = isRecord4(payload.message) ? payload.message : void 0;
        if (wrapped !== void 0)
          readUsage(wrapped.usage);
        continue;
      }
      if (type === "content_block_start") {
        const index2 = asNumber(payload.index);
        const block = isRecord4(payload.content_block) ? payload.content_block : void 0;
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
        const delta = isRecord4(payload.delta) ? payload.delta : void 0;
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
        const delta = isRecord4(payload.delta) ? payload.delta : void 0;
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
function isRecord5(value) {
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
    case "user": {
      const images = message.images ?? [];
      if (images.length === 0)
        return { role: "user", content: message.content };
      const blocks = [];
      if (message.content !== "")
        blocks.push({ type: "text", text: message.content });
      for (const image of images) {
        blocks.push({
          type: "image_url",
          image_url: { url: `data:${image.mediaType};base64,${image.base64}` }
        });
      }
      return { role: "user", content: blocks };
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
      if (!isRecord5(chunk))
        continue;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = choices[0];
      if (isRecord5(choice)) {
        const delta = isRecord5(choice.delta) ? choice.delta : void 0;
        if (delta !== void 0 && typeof delta.content === "string" && delta.content !== "") {
          yield { type: "text.delta", text: delta.content };
        }
        if (delta !== void 0 && Array.isArray(delta.tool_calls)) {
          for (const entry of delta.tool_calls) {
            if (!isRecord5(entry))
              continue;
            const index2 = typeof entry.index === "number" ? entry.index : 0;
            let call = pending.get(index2);
            if (call === void 0) {
              call = { id: "", name: "", args: "" };
              pending.set(index2, call);
            }
            if (typeof entry.id === "string")
              call.id = entry.id;
            const fn = isRecord5(entry.function) ? entry.function : void 0;
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
      if (isRecord5(chunk.usage)) {
        const usage = chunk.usage;
        const details = isRecord5(usage.prompt_tokens_details) ? usage.prompt_tokens_details : void 0;
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
var UNATTRIBUTED = "(unattributed)";
var PER_MILLION = 1e6;
var CELL_SEPARATOR = "\0";
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
function addInto(target, usage, cost) {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cachedInputTokens += usage.cachedInputTokens ?? 0;
  target.hasCached = target.hasCached || usage.cachedInputTokens !== void 0;
  target.costUsd += cost;
}
function pricingOf(priced, unpriced) {
  if (unpriced === 0)
    return "known";
  return priced === 0 ? "unknown" : "partial";
}
var UsageTracker = class {
  #byModel = /* @__PURE__ */ new Map();
  #cells = /* @__PURE__ */ new Map();
  #total = newBucket();
  /**
   * Folds one model turn in.
   *
   * `tags` is optional and purely additive: an untagged call still lands in
   * {@link totals} and {@link byModel} exactly as before, and shows up under
   * {@link UNATTRIBUTED} in the agent and task breakdowns.
   */
  record(model, usage, tags) {
    const key = `${model.provider}/${model.id}`;
    let bucket = this.#byModel.get(key);
    if (bucket === void 0) {
      bucket = newBucket();
      this.#byModel.set(key, bucket);
    }
    const cost = usageCostUsd(model.pricing, usage);
    addInto(bucket, usage, cost);
    addInto(this.#total, usage, cost);
    const cell = this.#cellFor(model, tags);
    addInto(cell.bucket, usage, cost);
    if (model.pricing === void 0)
      cell.unpriced += 1;
    else
      cell.priced += 1;
  }
  #cellFor(model, tags) {
    const attribution = {
      model: tags?.model ?? model.id,
      agent: tags?.agent ?? UNATTRIBUTED,
      task: tags?.taskId ?? UNATTRIBUTED
    };
    const key = [attribution.model, attribution.agent, attribution.task].join(CELL_SEPARATOR);
    let cell = this.#cells.get(key);
    if (cell === void 0) {
      cell = { ...attribution, bucket: newBucket(), priced: 0, unpriced: 0 };
      this.#cells.set(key, cell);
    }
    return cell;
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
  /**
   * Usage grouped along one attribution axis.
   *
   * Every sample lands in exactly one bucket of every dimension, so summing
   * any breakdown reproduces {@link totals} — that invariant is what makes the
   * per-model rollup in a run summary trustworthy. Buckets come back in
   * first-seen order.
   */
  totalsBy(dimension) {
    const out = /* @__PURE__ */ new Map();
    for (const [key, entry] of this.breakdownBy(dimension)) {
      out.set(key, { usage: entry.usage, costUsd: entry.costUsd });
    }
    return out;
  }
  /** {@link totalsBy} plus what each bucket is made of — see {@link UsageBreakdown}. */
  breakdownBy(dimension) {
    const groups = /* @__PURE__ */ new Map();
    for (const cell of this.#cells.values()) {
      const key = dimension === "model" ? cell.model : dimension === "agent" ? cell.agent : cell.task;
      let group = groups.get(key);
      if (group === void 0) {
        group = {
          bucket: newBucket(),
          models: /* @__PURE__ */ new Set(),
          agents: /* @__PURE__ */ new Set(),
          tasks: /* @__PURE__ */ new Set(),
          priced: 0,
          unpriced: 0
        };
        groups.set(key, group);
      }
      addInto(group.bucket, toUsage(cell.bucket), cell.bucket.costUsd);
      group.models.add(cell.model);
      group.agents.add(cell.agent);
      group.tasks.add(cell.task);
      group.priced += cell.priced;
      group.unpriced += cell.unpriced;
    }
    const out = /* @__PURE__ */ new Map();
    for (const [key, group] of groups) {
      out.set(key, {
        key,
        usage: toUsage(group.bucket),
        costUsd: group.bucket.costUsd,
        pricing: pricingOf(group.priced, group.unpriced),
        models: [...group.models].sort(),
        agents: [...group.agents].sort(),
        tasks: [...group.tasks].sort(),
        samples: group.priced + group.unpriced
      });
    }
    return out;
  }
};
async function* teeUsage(source, model, recorder, tags) {
  for await (const event2 of source) {
    if (event2.type === "usage") {
      recorder.record(model, {
        inputTokens: event2.inputTokens,
        outputTokens: event2.outputTokens,
        ...event2.cachedInputTokens === void 0 ? {} : { cachedInputTokens: event2.cachedInputTokens }
      }, tags);
    }
    yield event2;
  }
}
function usageRecordingProvider(provider, recorder, tags) {
  return {
    id: provider.id,
    supports: (model) => provider.supports(model),
    stream: (request, signal) => teeUsage(provider.stream(request, signal), request.model, recorder, tags)
  };
}

// apps/cli/dist/config.js
var KAPEL_CONFIG_VERSION = 2;
var BACKENDS = ["claude-code", "codex", "native"];
function envValue(env, name) {
  const value = (env ?? process.env)[name];
  return value === void 0 || value === "" ? void 0 : value;
}
function kapelConfigDir(env) {
  return envValue(env, "KAPEL_CONFIG_DIR") ?? path.join(homedir(), ".kapel");
}
function kapelConfigPath(env) {
  return path.join(kapelConfigDir(env), "config.json");
}
function isBackend(value) {
  return typeof value === "string" && BACKENDS.includes(value);
}
function modelString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPermissionDecision(value) {
  return value === "allow" || value === "ask" || value === "deny";
}
function parsePermissionBlock(raw) {
  if (raw === void 0)
    return { rules: {}, warnings: [] };
  if (!isRecord6(raw)) {
    return {
      rules: {},
      warnings: ['"permission" must be an object; ignoring it entirely.']
    };
  }
  const rules = {};
  const warnings = [];
  for (const [tool, value] of Object.entries(raw)) {
    if (isPermissionDecision(value)) {
      rules[tool] = value;
      continue;
    }
    if (isRecord6(value)) {
      const patterns = {};
      for (const [pattern, verdict] of Object.entries(value)) {
        if (isPermissionDecision(verdict)) {
          patterns[pattern] = verdict;
        } else {
          warnings.push(`permission.${tool}["${pattern}"]: expected "allow" | "ask" | "deny", got ${JSON.stringify(verdict)} \u2014 ignoring.`);
        }
      }
      if (Object.keys(patterns).length > 0) {
        rules[tool] = patterns;
      } else {
        warnings.push(`permission.${tool}: no valid patterns \u2014 ignoring.`);
      }
      continue;
    }
    warnings.push(`permission.${tool}: expected "allow" | "ask" | "deny" or a pattern map, got ${JSON.stringify(value)} \u2014 ignoring.`);
  }
  return { rules, warnings };
}
function migrateV1Models(modelRecord) {
  const orchestrator = modelString(modelRecord.orchestrator);
  const worker = modelString(modelRecord.worker);
  const cheap = modelString(modelRecord.cheap);
  if (orchestrator === void 0 || worker === void 0 || cheap === void 0) {
    return void 0;
  }
  return { orchestrator, complex: worker, middle: worker, low: cheap };
}
function parseV2Models(modelRecord) {
  const orchestrator = modelString(modelRecord.orchestrator);
  const complex = modelString(modelRecord.complex);
  const middle = modelString(modelRecord.middle);
  const low = modelString(modelRecord.low);
  if (orchestrator === void 0 || complex === void 0 || middle === void 0 || low === void 0) {
    return void 0;
  }
  return { orchestrator, complex, middle, low };
}
function parseConfig(raw) {
  const none = { config: void 0, warnings: [] };
  if (typeof raw !== "object" || raw === null)
    return none;
  const record = raw;
  const version = record.version;
  if (version !== KAPEL_CONFIG_VERSION && version !== 1)
    return none;
  if (!isBackend(record.backend))
    return none;
  const models = record.models;
  if (typeof models !== "object" || models === null)
    return none;
  const modelRecord = models;
  const parsed = version === 1 ? migrateV1Models(modelRecord) : parseV2Models(modelRecord);
  if (parsed === void 0)
    return none;
  const { rules: permission, warnings } = parsePermissionBlock(record.permission);
  const updatedAt = record.updatedAt;
  return {
    config: {
      version: KAPEL_CONFIG_VERSION,
      backend: record.backend,
      models: parsed,
      updatedAt: typeof updatedAt === "number" ? updatedAt : 0,
      ...Object.keys(permission).length > 0 ? { permission } : {}
    },
    warnings
  };
}
async function loadKapelConfig(env) {
  let text2;
  try {
    text2 = await readFile7(kapelConfigPath(env), "utf8");
  } catch {
    return void 0;
  }
  let parsed;
  try {
    parsed = parseConfig(JSON.parse(text2));
  } catch {
    return void 0;
  }
  if (parsed.warnings.length > 0) {
    console.error(`warning: ignoring invalid entries in ${kapelConfigPath(env)}'s "permission" block:`);
    for (const warning of parsed.warnings)
      console.error(`  - ${warning}`);
  }
  return parsed.config;
}
async function saveKapelConfig(config, env) {
  const filePath = kapelConfigPath(env);
  await mkdir3(path.dirname(filePath), { recursive: true });
  const full = {
    version: KAPEL_CONFIG_VERSION,
    backend: config.backend,
    models: {
      orchestrator: config.models.orchestrator,
      complex: config.models.complex,
      middle: config.models.middle,
      low: config.models.low
    },
    updatedAt: config.updatedAt ?? Date.now(),
    // Hand-edited only (see `KapelConfig.permission`) — carried through
    // verbatim so a `/config` re-save never silently drops it.
    ...config.permission === void 0 ? {} : { permission: config.permission }
  };
  await writeFile3(filePath, `${JSON.stringify(full, null, 2)}
`, "utf8");
  try {
    await chmod(filePath, 384);
  } catch {
  }
  return filePath;
}
function backendChoices() {
  return [
    {
      value: "claude-code",
      label: "Claude Code",
      hint: "use your Claude Code subscription login \u2014 no API key"
    },
    {
      value: "codex",
      label: "Codex",
      hint: "use your ChatGPT login via the OpenAI Codex CLI \u2014 no API key"
    },
    {
      value: "native",
      label: "API key (Anthropic/OpenAI)",
      hint: "call model APIs directly with a key or token"
    }
  ];
}
function catalogIdsForProvider(provider) {
  const catalog = defaultModelCatalog();
  return Object.keys(catalog).filter((id) => catalog[id]?.provider === provider).sort();
}
function claudeCodeChoices() {
  const aliases = [
    { value: "opus", label: "opus", hint: "Claude Opus \u2014 highest capability" },
    { value: "sonnet", label: "sonnet", hint: "Claude Sonnet \u2014 balanced" },
    { value: "haiku", label: "haiku", hint: "Claude Haiku \u2014 fastest/cheapest" }
  ];
  const fullIds = catalogIdsForProvider("anthropic").map((id) => ({
    value: id,
    label: id,
    hint: "full model id \u2014 errors at run time if your plan lacks it"
  }));
  return [
    ...aliases,
    ...fullIds,
    {
      value: "default",
      label: "default",
      hint: "whatever your Claude Code account defaults to"
    }
  ];
}
function codexChoices() {
  const runTimeHint = "errors at run time if your plan lacks it";
  const named = Array.from(/* @__PURE__ */ new Set(["gpt-5.1-codex", ...catalogIdsForProvider("openai")])).sort();
  return [
    { value: "default", label: "default", hint: "let the Codex CLI choose" },
    ...named.map((id) => ({ value: id, label: id, hint: runTimeHint }))
  ];
}
function nativeChoices() {
  const catalog = defaultModelCatalog();
  return Object.keys(catalog).sort().map((alias) => {
    const definition = catalog[alias];
    const provider = definition?.provider ?? "unknown";
    const hint = definition?.pricing === void 0 ? provider : `${provider} \xB7 pricing available`;
    return { value: alias, label: alias, hint };
  });
}
function choicesForBackend(backend) {
  if (backend === "claude-code")
    return claudeCodeChoices();
  if (backend === "codex")
    return codexChoices();
  return nativeChoices();
}
function modelChoicesFor(backend, role) {
  const suggested = defaultModelsFor(backend)[role];
  return choicesForBackend(backend).map((choice) => {
    if (choice.value !== suggested)
      return choice;
    const hint = choice.hint === void 0 ? "suggested for this role" : `${choice.hint} \xB7 suggested for this role`;
    return { value: choice.value, label: choice.label, hint };
  });
}
function pickNative(preferred) {
  const catalog = defaultModelCatalog();
  const aliases = Object.keys(catalog).sort();
  if (aliases.includes(preferred))
    return preferred;
  const anthropic = aliases.find((alias) => catalog[alias]?.provider === "anthropic");
  return anthropic ?? aliases[0] ?? preferred;
}
function defaultModelsFor(backend) {
  if (backend === "claude-code") {
    return {
      orchestrator: "opus",
      complex: "opus",
      middle: "sonnet",
      low: "haiku"
    };
  }
  if (backend === "codex") {
    return {
      orchestrator: "default",
      complex: "default",
      middle: "default",
      low: "default"
    };
  }
  return {
    orchestrator: pickNative("claude-opus-5"),
    complex: pickNative("claude-opus-5"),
    middle: pickNative("claude-sonnet-5"),
    low: pickNative("claude-haiku-4-5")
  };
}
function backendLabel(backend) {
  return backendChoices().find((choice) => choice.value === backend)?.label ?? backend;
}
function describeConfig(config) {
  return [
    `backend: ${backendLabel(config.backend)} (${config.backend})`,
    `orchestrator model: ${config.models.orchestrator}`,
    `worker model (complex tasks): ${config.models.complex}`,
    `worker model (everyday tasks): ${config.models.middle}`,
    `worker model (small tasks): ${config.models.low}`,
    `updated: ${new Date(config.updatedAt).toISOString()}`
  ];
}

// apps/cli/dist/config-wizard.js
var BACKEND_TITLE = "Which coding backend should kapel use?";
var ROLE_TITLES = {
  orchestrator: "Main orchestrator model",
  complex: "Worker model \u2014 most complex coding tasks",
  middle: "Worker model \u2014 everyday tasks",
  low: "Worker model \u2014 small, single-function tasks"
};
var ROLES = [
  "orchestrator",
  "complex",
  "middle",
  "low"
];
var BACKEND_FIX = {
  "claude-code": "fix: npm install -g @anthropic-ai/claude-code, then run `claude` once and log in",
  codex: "fix: npm install -g @openai/codex, then `codex login`",
  native: "fix: set ANTHROPIC_API_KEY or OPENAI_API_KEY in your shell environment"
};
function isBackend2(value) {
  return value === "claude-code" || value === "codex" || value === "native";
}
async function ask(deps, title, choices, initial) {
  const values = await deps.prompt.select({ title, choices, initial });
  if (values === void 0)
    return void 0;
  return values[0];
}
function initialFor(backend, role, choices, current) {
  const previous = current?.models[role];
  if (previous !== void 0 && choices.some((choice) => choice.value === previous)) {
    return previous;
  }
  return defaultModelsFor(backend)[role];
}
async function warnIfUnavailable(deps, backend) {
  const check = deps.checkBackend;
  if (check === void 0)
    return;
  let result;
  try {
    result = await check(backend);
  } catch (error) {
    result = {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
  if (result.ok)
    return;
  const detail = result.detail === void 0 ? "" : `: ${result.detail}`;
  deps.write(`warning: ${backend} does not look ready${detail}`);
  deps.write(BACKEND_FIX[backend]);
  deps.write("continuing setup \u2014 you can fix this later and re-run `kapel config`.");
}
async function runConfigWizard(deps) {
  const cancelled = () => {
    deps.write("setup cancelled");
    return void 0;
  };
  const backendValue = await ask(deps, BACKEND_TITLE, backendChoices(), deps.current?.backend ?? "claude-code");
  if (backendValue === void 0 || !isBackend2(backendValue)) {
    return cancelled();
  }
  const backend = backendValue;
  await warnIfUnavailable(deps, backend);
  const picked = {};
  for (const role of ROLES) {
    const choices = modelChoicesFor(backend, role);
    const answer = await ask(deps, ROLE_TITLES[role], choices, initialFor(backend, role, choices, deps.current));
    if (answer === void 0)
      return cancelled();
    picked[role] = answer;
  }
  const defaults = defaultModelsFor(backend);
  const models = {
    orchestrator: picked.orchestrator ?? defaults.orchestrator,
    complex: picked.complex ?? defaults.complex,
    middle: picked.middle ?? defaults.middle,
    low: picked.low ?? defaults.low
  };
  const config = {
    version: KAPEL_CONFIG_VERSION,
    backend,
    models,
    updatedAt: (deps.now ?? Date.now)(),
    ...deps.current?.permission === void 0 ? {} : { permission: deps.current.permission }
  };
  for (const line of describeConfig(config))
    deps.write(line);
  if (deps.save !== false) {
    const filePath = await saveKapelConfig({
      backend,
      models,
      updatedAt: config.updatedAt,
      ...config.permission === void 0 ? {} : { permission: config.permission }
    }, deps.env);
    deps.write(`saved to ${filePath}`);
  }
  return config;
}
async function ensureKapelConfig(deps) {
  const existing = await loadKapelConfig(deps.env);
  if (existing !== void 0)
    return existing;
  if (!deps.interactive)
    return void 0;
  return await runConfigWizard(deps);
}

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
  const execFile11 = opts?.execFile ?? defaultExecFile;
  try {
    const { stdout } = await execFile11("ant", ["auth", "print-credentials", "--access-token"], { timeout: OAUTH_TIMEOUT_MS, env });
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

// apps/cli/dist/select-prompt.js
import * as readline from "node:readline";
var NOOP = { type: "noop" };
var CANCEL = { type: "cancel" };
var DEFAULT_SELECT_FOOTER = "\u2191\u2193 move \xB7 space select \xB7 enter confirm \xB7 esc cancel";
function asArray(initial) {
  if (initial === void 0)
    return [];
  return typeof initial === "string" ? [initial] : initial.slice();
}
function initialSelectState(choices, options) {
  const multi = options?.multi ?? false;
  const known = new Set(choices.map((choice) => choice.value));
  const wanted = asArray(options?.initial).filter((value) => known.has(value));
  const selected = multi ? wanted : wanted.slice(0, 1);
  const first = selected[0];
  const cursorFrom = first === void 0 ? -1 : choices.findIndex((choice) => choice.value === first);
  return {
    choices,
    cursor: cursorFrom === -1 ? 0 : cursorFrom,
    selected,
    multi
  };
}
function wrap(index2, length) {
  return (index2 % length + length) % length;
}
function moveTo(state, cursor) {
  if (cursor === state.cursor)
    return { type: "state", state };
  return { type: "state", state: { ...state, cursor } };
}
function toggle(state) {
  const current = state.choices[state.cursor];
  if (current === void 0)
    return NOOP;
  if (!state.multi) {
    if (state.selected.length === 1 && state.selected[0] === current.value) {
      return { type: "state", state };
    }
    return { type: "state", state: { ...state, selected: [current.value] } };
  }
  const selected = state.selected.includes(current.value) ? state.selected.filter((value) => value !== current.value) : [...state.selected, current.value];
  return { type: "state", state: { ...state, selected } };
}
function submit(state) {
  if (state.multi || state.selected.length > 0) {
    return { type: "submit", values: state.selected };
  }
  const current = state.choices[state.cursor];
  return {
    type: "submit",
    values: current === void 0 ? [] : [current.value]
  };
}
function digitOf(key) {
  const raw = key.name ?? key.sequence;
  if (raw === void 0 || !/^[1-9]$/.test(raw))
    return void 0;
  return Number(raw);
}
function reduceSelectKey(state, key) {
  const name = key.name;
  const length = state.choices.length;
  if (key.ctrl === true) {
    return name === "c" || name === "d" ? CANCEL : NOOP;
  }
  if (name === "escape")
    return CANCEL;
  if (name === "return" || name === "enter")
    return submit(state);
  if (name === "space" || key.sequence === " ")
    return toggle(state);
  if (length === 0)
    return NOOP;
  if (name === "up" || name === "k") {
    return moveTo(state, wrap(state.cursor - 1, length));
  }
  if (name === "down" || name === "j") {
    return moveTo(state, wrap(state.cursor + 1, length));
  }
  if (name === "home")
    return moveTo(state, 0);
  if (name === "end")
    return moveTo(state, length - 1);
  const digit = digitOf(key);
  if (digit !== void 0 && digit <= length)
    return moveTo(state, digit - 1);
  return NOOP;
}
function ansi(code, text2, enabled) {
  return enabled ? `\x1B[${code}m${text2}\x1B[0m` : text2;
}
function glyph(state, selected) {
  if (state.multi)
    return selected ? "\u2611" : "\u2610";
  return selected ? "\u25C9" : "\u25EF";
}
function renderSelect(state, options) {
  const color = options.color;
  const lines = [ansi("1", options.title, color)];
  state.choices.forEach((choice, index2) => {
    const marker = index2 === state.cursor ? "\u276F " : "  ";
    const box = glyph(state, state.selected.includes(choice.value));
    const label = index2 === state.cursor ? ansi("1", choice.label, color) : choice.label;
    const hint = choice.hint === void 0 ? "" : ` ${ansi("2", `(${choice.hint})`, color)}`;
    lines.push(`${marker}${box} ${label}${hint}`);
  });
  lines.push(ansi("2", options.footer ?? DEFAULT_SELECT_FOOTER, color));
  return lines;
}
function labelFor(choices, value) {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}
function summarizeSelection(choices, values, options) {
  const answer = values === void 0 ? "cancelled" : values.length === 0 ? "(none)" : values.map((value) => labelFor(choices, value)).join(", ");
  return `${ansi("1", options.title, options.color)} ${ansi("2", "\u203A", options.color)} ${answer}`;
}
function runSelectPrompt(io, options) {
  const stateOptions = {
    ...options.initial === void 0 ? {} : { initial: options.initial },
    ...options.multi === void 0 ? {} : { multi: options.multi }
  };
  let state = initialSelectState(options.choices, stateOptions);
  if (io.input.isTTY !== true) {
    if (state.selected.length > 0)
      return Promise.resolve(state.selected);
    const first = options.choices[0];
    return Promise.resolve(first === void 0 ? [] : [first.value]);
  }
  const color = io.output.isTTY === true;
  const renderOptions = {
    title: options.title,
    color,
    ...options.footer === void 0 ? {} : { footer: options.footer }
  };
  return new Promise((resolve5) => {
    let drawn = 0;
    const erase = () => {
      if (drawn > 0)
        io.output.write(`\x1B[${drawn}A\r\x1B[0J`);
      drawn = 0;
    };
    const draw = () => {
      const lines = renderSelect(state, renderOptions);
      erase();
      io.output.write(`${lines.join("\n")}
`);
      drawn = lines.length;
    };
    const onKeypress = (_chunk, key) => {
      const action = reduceSelectKey(state, key ?? {});
      if (action.type === "noop")
        return;
      if (action.type === "state") {
        if (action.state === state)
          return;
        state = action.state;
        draw();
        return;
      }
      finish(action.type === "submit" ? action.values : void 0);
    };
    let settled = false;
    const finish = (values) => {
      if (settled)
        return;
      settled = true;
      io.input.removeListener("keypress", onKeypress);
      io.input.setRawMode?.(false);
      erase();
      io.output.write(`${summarizeSelection(options.choices, values, { title: options.title, color })}
`);
      resolve5(values);
    };
    readline.emitKeypressEvents(io.input);
    io.input.setRawMode?.(true);
    io.input.resume();
    io.input.on("keypress", onKeypress);
    draw();
  });
}

// apps/cli/dist/config-runtime.js
function present(value) {
  return value !== void 0 && value !== "";
}
function resolveBackendSetting(flag, env, config) {
  if (present(flag)) {
    return { value: validateBackendName(flag), source: "flag" };
  }
  const fromEnv = env.AGENT_BACKEND;
  if (present(fromEnv)) {
    return { value: validateBackendName(fromEnv), source: "env" };
  }
  if (config !== void 0) {
    return { value: config.backend, source: "config" };
  }
  return { value: DEFAULT_BACKEND, source: "default" };
}
function resolveRoleModel(role, flag, env, config) {
  if (present(flag))
    return { value: flag, source: "flag" };
  const fromEnv = env.AGENT_MODEL;
  if (present(fromEnv))
    return { value: fromEnv, source: "env" };
  if (config !== void 0) {
    return { value: config.models[role], source: "config" };
  }
  return { value: DEFAULT_MODEL_ALIAS, source: "default" };
}
function resolveOrchestratorModel(flag, env, config) {
  return resolveRoleModel("orchestrator", flag, env, config);
}
function delegatedModelOverride(resolved) {
  if (resolved.source === "default")
    return void 0;
  if (resolved.value === "default")
    return void 0;
  return resolved.value;
}
var FIRST_RUN_INTRO = [
  "kapel is not configured yet \u2014 a few questions, once (skip with --no-setup).",
  ""
];
var noSuspend = (fn) => fn();
function ttyWizardPrompt(io, suspend) {
  const target = io ?? {
    input: process.stdin,
    output: process.stdout
  };
  const run = suspend ?? noSuspend;
  return { select: (options) => run(() => runSelectPrompt(target, options)) };
}
async function checkBackendAvailability(backend, env = process.env) {
  if (backend === "claude-code") {
    const availability = await ClaudeCodeBackend.checkAvailability();
    return {
      ok: availability.installed && availability.loggedIn,
      ...availability.detail === void 0 ? {} : { detail: availability.detail }
    };
  }
  if (backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    return {
      ok: availability.installed && availability.loggedIn,
      ...availability.detail === void 0 ? {} : { detail: availability.detail }
    };
  }
  const configured = present(env.ANTHROPIC_API_KEY) || present(env.ANTHROPIC_AUTH_TOKEN) || present(env.OPENAI_API_KEY);
  return configured ? { ok: true } : { ok: false, detail: "no provider credential is set in this shell" };
}
async function ensureFirstRunConfig(options) {
  const interactive = options.interactive && options.noSetup !== true;
  const ensure = options.ensure ?? ensureKapelConfig;
  const write2 = options.write ?? ((line) => {
    console.log(line);
  });
  const prompt = ttyWizardPrompt(options.io, options.suspend);
  let announced = false;
  const announcingPrompt = {
    select: async (selectOptions) => {
      if (!announced) {
        announced = true;
        for (const line of FIRST_RUN_INTRO)
          write2(line);
      }
      return await prompt.select(selectOptions);
    }
  };
  return await ensure({
    interactive,
    prompt: announcingPrompt,
    write: write2,
    checkBackend: (backend) => checkBackendAvailability(backend, options.env ?? process.env),
    ...options.env === void 0 ? {} : { env: options.env }
  });
}

// apps/cli/dist/config-cmd.js
var NOT_CONFIGURED = "not configured yet \u2014 run `kapel config`";
async function runConfigCommand(options, deps) {
  const env = deps.env;
  const filePath = kapelConfigPath(env);
  if (options.path === true) {
    deps.log(filePath);
    return 0;
  }
  const load = deps.load ?? loadKapelConfig;
  const current = await load(env);
  if (options.show === true) {
    if (current === void 0) {
      deps.log(NOT_CONFIGURED);
      deps.log(`path: ${filePath}`);
      return 0;
    }
    for (const line of describeConfig(current))
      deps.log(line);
    deps.log(`path: ${filePath}`);
    return 0;
  }
  if (!deps.interactive) {
    deps.error("`kapel config` needs an interactive terminal. Use `kapel config --show` to print the current configuration.");
    return 1;
  }
  const wizard = deps.wizard ?? runConfigWizard;
  const wizardDeps = {
    prompt: ttyWizardPrompt(),
    write: deps.log,
    checkBackend: (backend) => checkBackendAvailability(backend, env),
    ...current === void 0 ? {} : { current },
    ...env === void 0 ? {} : { env }
  };
  await wizard(wizardDeps);
  return 0;
}

// apps/cli/dist/env.js
import { readFile as readFile8 } from "node:fs/promises";
import path2 from "node:path";
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
  const filePath = path2.join(workspaceRoot, ".env");
  let content;
  try {
    content = await readFile8(filePath, "utf8");
  } catch {
    return;
  }
  applyDotEnv(parseDotEnv(content), target);
}

// apps/cli/dist/plan.js
import { readFile as readFile9 } from "node:fs/promises";
import path5 from "node:path";

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
import path4 from "node:path";

// apps/cli/dist/instructions.js
import { readFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path3 from "node:path";
var MAX_INSTRUCTIONS_BYTES = 32 * 1024;
var TRUNCATION_MARKER2 = "[instructions truncated]";
var PREAMBLE = "Project instructions (from AGENTS.md files):";
function abbreviateHome(absPath, home) {
  if (absPath === home)
    return "~";
  const prefix = home.endsWith(path3.sep) ? home : `${home}${path3.sep}`;
  if (!absPath.startsWith(prefix))
    return absPath;
  return `~${path3.sep}${absPath.slice(prefix.length)}`;
}
function sourcesFor(workspacePath, env) {
  const configPath = path3.join(kapelConfigDir(env), "AGENTS.md");
  const projectPath = path3.join(workspacePath, "AGENTS.md");
  const agentPath = path3.join(workspacePath, ".agent", "AGENTS.md");
  return [
    { absPath: configPath, display: abbreviateHome(configPath, homedir2()) },
    {
      absPath: projectPath,
      display: path3.relative(workspacePath, projectPath)
    },
    { absPath: agentPath, display: path3.relative(workspacePath, agentPath) }
  ];
}
function capSize(text2) {
  if (Buffer.byteLength(text2, "utf8") <= MAX_INSTRUCTIONS_BYTES)
    return text2;
  const markerLine = `
${TRUNCATION_MARKER2}`;
  const budget = Math.max(0, MAX_INSTRUCTIONS_BYTES - Buffer.byteLength(markerLine, "utf8"));
  const truncated = Buffer.from(text2, "utf8").subarray(0, budget).toString("utf8");
  return `${truncated}${markerLine}`;
}
function loadInstructions(workspacePath, env) {
  const blocks = [];
  const sources = [];
  for (const source of sourcesFor(workspacePath, env)) {
    let raw;
    try {
      raw = readFileSync(source.absPath, "utf8");
    } catch {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === "")
      continue;
    sources.push(source.display);
    blocks.push(`# From ${source.display}

${trimmed}`);
  }
  return { text: capSize(blocks.join("\n\n")), sources };
}
function composeSystemPrompt(base, instructions) {
  if (instructions.text === "")
    return base;
  return `${base}

${PREAMBLE}

${instructions.text}`;
}

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
function isPatternMap(rule) {
  return typeof rule === "object" && rule !== null;
}
function mergePermissionLayer(base, layer) {
  const merged = { ...base };
  for (const [tool, rule] of Object.entries(layer)) {
    const existing = merged[tool];
    merged[tool] = isPatternMap(existing) && isPatternMap(rule) ? { ...existing, ...rule } : rule;
  }
  return merged;
}
function resolvePermissionRules(defaults, ...layers) {
  let merged = defaults;
  for (const layer of layers) {
    if (layer === void 0)
      continue;
    merged = mergePermissionLayer(merged, layer);
  }
  return merged;
}
function errorMessage7(error) {
  return error instanceof Error ? error.message : String(error);
}
async function loadRepoPermissionRules(workspacePath) {
  let agentDir;
  try {
    agentDir = await findAgentDir(workspacePath);
  } catch {
    return void 0;
  }
  if (agentDir === void 0)
    return void 0;
  try {
    const config = await loadProjectConfig(agentDir);
    return Object.keys(config.permission).length > 0 ? config.permission : void 0;
  } catch (error) {
    console.error(`warning: ignoring .agent/config.yaml permission rules: ${errorMessage7(error)}`);
    return void 0;
  }
}

// apps/cli/dist/prompter.js
import * as readline2 from "node:readline";

// apps/cli/dist/preview.js
var PREVIEW_MAX = 120;
var PREVIEW_MAX_LINES = 40;
var DIFF_CONTEXT = 3;
var LCS_MAX_LINES = 300;
var WRITE_PREVIEW_LINES = 20;
var RED = "31";
var GREEN = "32";
var DIM = "2";
function ansi2(code, text2, enabled) {
  return enabled ? `\x1B[${code}m${text2}\x1B[0m` : text2;
}
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(input, key) {
  if (!isRecord7(input))
    return void 0;
  const value = input[key];
  return typeof value === "string" ? value : void 0;
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
function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Array((n + 1) * width).fill(0);
  for (let i2 = n - 1; i2 >= 0; i2 -= 1) {
    for (let j2 = m - 1; j2 >= 0; j2 -= 1) {
      dp[i2 * width + j2] = a[i2] === b[j2] ? (dp[(i2 + 1) * width + j2 + 1] ?? 0) + 1 : Math.max(dp[(i2 + 1) * width + j2] ?? 0, dp[i2 * width + j2 + 1] ?? 0);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ marker: " ", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      out.push({ marker: "-", text: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ marker: "+", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < n; i += 1)
    out.push({ marker: "-", text: a[i] ?? "" });
  for (; j < m; j += 1)
    out.push({ marker: "+", text: b[j] ?? "" });
  return out;
}
function diffLines(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head])
    head += 1;
  let tail4 = 0;
  while (tail4 < a.length - head && tail4 < b.length - head && a[a.length - 1 - tail4] === b[b.length - 1 - tail4]) {
    tail4 += 1;
  }
  const midA = a.slice(head, a.length - tail4);
  const midB = b.slice(head, b.length - tail4);
  const middle = midA.length > LCS_MAX_LINES || midB.length > LCS_MAX_LINES ? [
    ...midA.map((text2) => ({ marker: "-", text: text2 })),
    ...midB.map((text2) => ({ marker: "+", text: text2 }))
  ] : lcsDiff(midA, midB);
  return [
    ...a.slice(0, head).map((text2) => ({ marker: " ", text: text2 })),
    ...middle,
    ...a.slice(a.length - tail4).map((text2) => ({ marker: " ", text: text2 }))
  ];
}
function paint(line, color) {
  const text2 = `  ${line.marker} ${line.text}`;
  if (line.marker === "-")
    return ansi2(RED, text2, color);
  if (line.marker === "+")
    return ansi2(GREEN, text2, color);
  return text2;
}
function moreTail(count, color) {
  return ansi2(DIM, `  \u2026 (+${count} more)`, color);
}
function capLines(lines, color) {
  if (lines.length <= PREVIEW_MAX_LINES)
    return [...lines];
  const kept = lines.slice(0, PREVIEW_MAX_LINES - 1);
  return [...kept, moreTail(lines.length - kept.length, color)];
}
function renderDiff(lines, options = {}) {
  const color = options.color === true;
  const keep = lines.map((line) => line.marker !== " ");
  lines.forEach((line, index2) => {
    if (line.marker === " ")
      return;
    const from = Math.max(0, index2 - DIFF_CONTEXT);
    const to = Math.min(lines.length - 1, index2 + DIFF_CONTEXT);
    for (let near = from; near <= to; near += 1)
      keep[near] = true;
  });
  const out = [];
  let elided = false;
  lines.forEach((line, index2) => {
    if (keep[index2] === true) {
      out.push(paint(line, color));
      elided = false;
      return;
    }
    if (!elided) {
      out.push(ansi2(DIM, "  \u22EE", color));
      elided = true;
    }
  });
  return capLines(out, color);
}
function previewBash(input, options = {}) {
  const command = stringField(input, "command");
  if (command === void 0)
    return void 0;
  const lines = command.split("\n").map((line) => `  ${line}`);
  return capLines(lines, options.color === true).join("\n");
}
function previewEdit(input, options = {}) {
  const path19 = stringField(input, "path");
  const oldText = stringField(input, "oldText");
  const newText = stringField(input, "newText");
  if (path19 === void 0 || oldText === void 0 || newText === void 0) {
    return void 0;
  }
  const replaceAll = isRecord7(input) && input.replaceAll === true ? " (all occurrences)" : "";
  const header = ansi2(DIM, `  ${path19}${replaceAll}`, options.color === true);
  return [header, ...renderDiff(diffLines(oldText, newText), options)].join("\n");
}
function previewWrite(input, options = {}) {
  const path19 = stringField(input, "path");
  const content = stringField(input, "content");
  if (path19 === void 0 || content === void 0)
    return void 0;
  const color = options.color === true;
  const lines = content.split("\n");
  const shown = lines.slice(0, WRITE_PREVIEW_LINES);
  const body = shown.map((text2) => paint({ marker: "+", text: text2 }, color));
  if (lines.length > shown.length) {
    body.push(moreTail(lines.length - shown.length, color));
  }
  const header = ansi2(DIM, `  ${path19} (${lines.length} line${lines.length === 1 ? "" : "s"})`, color);
  return [header, ...body].join("\n");
}
function formatToolPreview(tool, input, options = {}) {
  switch (tool) {
    case "bash":
      return previewBash(input, options);
    case "edit_file":
      return previewEdit(input, options);
    case "write_file":
      return previewWrite(input, options);
    default:
      return void 0;
  }
}

// apps/cli/dist/prompter.js
var ERASE_LINE = "\x1B[2K\r";
function createPromptState() {
  return { active: false };
}
function parsePermissionAnswer(answer) {
  if (typeof answer !== "string")
    return "deny";
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes")
    return "once";
  if (normalized === "a" || normalized === "always")
    return "always";
  return "deny";
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
  const ask2 = options.ask;
  const allowlist = options.allowlist;
  const color = options.color ?? output.isTTY === true;
  return {
    ask: async (request) => {
      state.active = true;
      try {
        const prompt = formatPermissionPrompt(request, { color });
        const lines = previewBlockLines(request, prompt, {
          color,
          offerAlways: allowlist !== void 0
        });
        if (color)
          output.write(ERASE_LINE);
        if (lines.length > 0)
          output.write(`${lines.join("\n")}
`);
        const raw = ask2 === void 0 ? await askOnce(prompt.query, input, output) : await ask2(prompt.query);
        const answer = parsePermissionAnswer(raw);
        if (answer === "deny")
          return false;
        if (answer === "always" && allowlist !== void 0) {
          const rule = allowlist.remember(request);
          output.write(`${dim(rule === void 0 ? "  (allowed once \u2014 a compound command cannot be remembered)" : `  (remembered for this session: ${describeSessionRule(rule)})`, color)}
`);
        }
        return true;
      } finally {
        state.active = false;
      }
    }
  };
}
function dim(text2, enabled) {
  return enabled ? `\x1B[2m${text2}\x1B[0m` : text2;
}
function previewBlockLines(request, prompt, options) {
  const lines = prompt.block === void 0 ? [] : prompt.block.split("\n");
  if (!options.offerAlways)
    return lines;
  const rule = sessionRuleFor(request);
  if (rule === void 0)
    return lines;
  return [
    ...lines,
    dim(`  a = always allow ${describeSessionRule(rule)} this session`, options.color)
  ];
}
function formatPermissionPrompt(request, options = {}) {
  const block = formatToolPreview(request.tool, request.input, {
    ...options.color === void 0 ? {} : { color: options.color }
  });
  const query = block === void 0 ? `allow ${request.tool}? ${previewInput(request.input)} [y/n/a] ` : `allow ${request.tool}? [y/n/a] `;
  return { block, query };
}
function askOnce(query, input, output) {
  const rl = readline2.createInterface({ input, output, terminal: true });
  return new Promise((resolve5) => {
    let settled = false;
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      rl.close();
      resolve5(value);
    };
    rl.on("SIGINT", () => finish(void 0));
    rl.question(query, (answer) => finish(answer));
  });
}

// apps/cli/dist/status-line.js
var FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var TICK_MS = 120;
var ERASE = "\r\x1B[2K";
var DEFAULT_COLUMNS = 80;
function defaultTicker(tick) {
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
function formatTokenCount(tokens) {
  if (tokens < 1e3)
    return String(Math.round(tokens));
  return `${(tokens / 1e3).toFixed(1)}k`;
}
function formatStatus(label, elapsedMs2, tokens) {
  const seconds = Math.max(0, Math.floor(elapsedMs2 / 1e3));
  const parts = [`${label} ${seconds}s`];
  if (tokens !== void 0 && tokens > 0) {
    parts.push(`${formatTokenCount(tokens)} tokens`);
  }
  return parts.join(" \xB7 ");
}
var StatusLine = class {
  #output;
  #enabled;
  #now;
  #tokens;
  #suspended;
  #ticker;
  #cancel;
  #label = "";
  #startedAt = 0;
  #frame = 0;
  #painted = false;
  constructor(options = {}) {
    this.#output = options.output ?? process.stdout;
    this.#enabled = options.tty ?? this.#output.isTTY === true;
    this.#now = options.now ?? (() => Date.now());
    this.#tokens = options.tokens;
    this.#suspended = options.suspended ?? (() => false);
    this.#ticker = options.ticker ?? defaultTicker;
  }
  /** Whether this line will ever paint anything — false off a TTY. */
  get enabled() {
    return this.#enabled;
  }
  /** Whether a status is currently being kept up to date. */
  get running() {
    return this.#cancel !== void 0;
  }
  /**
   * Starts the status, or relabels a running one.
   *
   * The elapsed clock runs from the *start*, not from each relabel: it is the
   * age of the current wait, and a wait that changes phase (model → tool) is a
   * new wait, so {@link stop} then `start` is how the caller resets it.
   */
  start(label) {
    if (!this.#enabled)
      return;
    this.#label = label;
    if (this.#cancel === void 0) {
      this.#startedAt = this.#now();
      this.#frame = 0;
      this.#cancel = this.#ticker(() => {
        this.#frame += 1;
        this.#paint();
      });
    }
    this.#paint();
  }
  /**
   * Erases the painted line but keeps the status running: the next tick (or
   * {@link refresh}) puts it back. This is what the renderer calls before
   * writing real output.
   */
  erase() {
    if (!this.#painted)
      return;
    this.#painted = false;
    this.#output.write(ERASE);
  }
  /** Repaints immediately, if a status is running. */
  refresh() {
    this.#paint();
  }
  /** Ends the status: no more repainting, and nothing left on screen. */
  stop() {
    const cancel = this.#cancel;
    this.#cancel = void 0;
    cancel?.();
    this.erase();
  }
  #paint() {
    if (!this.#enabled || this.#cancel === void 0)
      return;
    if (this.#suspended()) {
      this.erase();
      return;
    }
    const frame = FRAMES[this.#frame % FRAMES.length] ?? FRAMES[0];
    const status = formatStatus(this.#label, this.#now() - this.#startedAt, this.#tokens?.());
    const columns = this.#output.columns ?? DEFAULT_COLUMNS;
    const text2 = `${frame} ${status}`.slice(0, Math.max(1, columns - 1));
    this.#output.write(`${ERASE}\x1B[2m${text2}\x1B[0m`);
    this.#painted = true;
  }
};

// apps/cli/dist/render.js
function formatTokenCount2(tokens) {
  if (tokens < 1e3)
    return String(tokens);
  if (tokens < 1e6)
    return `${(tokens / 1e3).toFixed(1)}k`;
  return `${(tokens / 1e6).toFixed(1)}M`;
}
function formatCostUsd(costUsd, pricing) {
  if (pricing === "unknown")
    return "n/a";
  const amount = costUsd >= 0.01 ? costUsd.toFixed(2) : costUsd.toFixed(4);
  return pricing === "partial" ? `$${amount}+` : `$${amount}`;
}
function formatTokenFlow(usage) {
  const cached = usage.cachedInputTokens;
  const input = cached === void 0 || cached === 0 ? `${formatTokenCount2(usage.inputTokens)} in` : `${formatTokenCount2(usage.inputTokens)} in (${formatTokenCount2(cached)} cached)`;
  return `${input} / ${formatTokenCount2(usage.outputTokens)} out`;
}
function usageBreakdownLine(entry, options = {}) {
  const parts = [];
  if (options.countTasks === true) {
    const tasks = entry.tasks.filter((id) => id !== UNATTRIBUTED).length;
    parts.push(`${tasks} task${tasks === 1 ? "" : "s"}`);
  }
  parts.push(formatTokenFlow(entry.usage));
  parts.push(formatCostUsd(entry.costUsd, entry.pricing));
  return `${entry.key}: ${parts.join(" \xB7 ")}`;
}
function usageRollupLines(breakdown, options = {}) {
  return [...breakdown.values()].sort((a, b) => b.costUsd - a.costUsd || b.usage.inputTokens + b.usage.outputTokens - (a.usage.inputTokens + a.usage.outputTokens) || a.key.localeCompare(b.key)).map((entry) => usageBreakdownLine(entry, options));
}
function isRecord8(value) {
  return typeof value === "object" && value !== null;
}
function isDelegatedResult(result) {
  return "events" in result;
}
var CODEX_PREFIX = "codex.";
var CLAUDE_CODE_PREFIX = "claude-code.";
function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "")
      return value;
  }
  return void 0;
}
function codexItemFrom(data) {
  if (isRecord8(data.item))
    return data.item;
  if (isRecord8(data.msg) && isRecord8(data.msg.item))
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
      else if (isRecord8(part) && typeof part.text === "string") {
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
      else if (isRecord8(change)) {
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
function routingLabel(routing) {
  if (!isRecord8(routing))
    return void 0;
  const rule = stringOrUndefined(routing.rule);
  switch (routing.reason) {
    case "rule":
      return rule === void 0 ? "rule" : `rule: ${rule}`;
    case "escalation":
      return rule === void 0 ? "escalation" : `escalation: ${rule}`;
    case "suggestedAgent":
      return "suggested";
    case "orchestrator":
      return "default";
    default:
      return void 0;
  }
}
function firstLine(text2) {
  if (typeof text2 !== "string")
    return "(no summary)";
  const line = text2.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === void 0 ? "(no summary)" : truncate3(line, 120);
}
function ansi3(code, text2, enabled) {
  return enabled ? `\x1B[${code}m${text2}\x1B[0m` : text2;
}
var EXIT_LABEL = {
  success: "success",
  partial: "partial",
  failed: "failed"
};
var THINKING_LABEL = "thinking";
var TextRenderer = class {
  #output;
  #color;
  #status;
  /** A streamed line is open — text was written with no newline after it. */
  #streaming = false;
  /** Deltas were streamed for the model turn now in flight. */
  #streamed = false;
  /** A turn this renderer is showing progress for is in flight. */
  #inTurn = false;
  /**
   * Text of the Claude Code block currently streaming, for the one case that
   * cannot be streamed to the screen: a delegated *task* inside an
   * orchestration run, whose output shares the terminal with other tasks.
   */
  #claudeText = "";
  constructor(output = process.stdout, options = {}) {
    this.#output = output;
    this.#color = "isTTY" in output && output.isTTY === true;
    this.#status = options.status ?? new StatusLine({
      output,
      ...options.tokens === void 0 ? {} : { tokens: options.tokens },
      ...options.suspended === void 0 ? {} : { suspended: options.suspended }
    });
  }
  /**
   * Writes one line of output, taking the screen back from the status line and
   * from any partially streamed text first.
   */
  #write(line) {
    this.#endStream();
    this.#status.erase();
    this.#output.write(`${line}
`);
    this.#status.refresh();
  }
  /**
   * Writes one line of caller-owned output (the REPL's own notices) through
   * the same discipline, and ends any status the turn left running.
   *
   * The interactive shell prints its per-turn lines itself rather than through
   * an event; routing them here is what keeps them from landing on top of a
   * spinner.
   */
  line(text2) {
    this.#endTurn();
    this.#write(text2);
  }
  /** Appends streamed assistant text, with no line terminator of its own. */
  #stream(text2) {
    if (text2 === "")
      return;
    this.#status.stop();
    this.#output.write(text2);
    this.#streaming = true;
    this.#streamed = true;
  }
  /** Terminates an open streamed line, if there is one. */
  #endStream() {
    if (!this.#streaming)
      return;
    this.#streaming = false;
    this.#output.write("\n");
  }
  /** A turn started: from here on there is something to show progress for. */
  #beginTurn() {
    this.#inTurn = true;
    this.#streamed = false;
    this.#status.start(THINKING_LABEL);
  }
  /**
   * Relabels the status, but only while a turn is actually in flight — which
   * is never the case for an orchestration run, whose turns all carry a task
   * id and so never call {@link #beginTurn}.
   */
  #waiting(label) {
    if (!this.#inTurn)
      return;
    this.#status.start(label);
  }
  /** A turn ended (or output took over): nothing is pending on screen. */
  #endTurn() {
    this.#inTurn = false;
    this.#endStream();
    this.#status.stop();
  }
  #dim(text2) {
    return ansi3("2", text2, this.#color);
  }
  #bold(text2) {
    return ansi3("1", text2, this.#color);
  }
  emit(event2) {
    const data = isRecord8(event2.data) ? event2.data : {};
    const single = event2.taskId === void 0;
    if (event2.type.startsWith(CODEX_PREFIX)) {
      this.#emitCodex(data);
      return;
    }
    if (event2.type.startsWith(CLAUDE_CODE_PREFIX)) {
      this.#emitClaudeCode(event2.type.slice(CLAUDE_CODE_PREFIX.length), data, single);
      return;
    }
    switch (event2.type) {
      case "chat.turn.started":
      case "loop.started": {
        if (single)
          this.#beginTurn();
        break;
      }
      case "chat.turn.completed":
      case "loop.completed": {
        if (single)
          this.#endTurn();
        break;
      }
      case MODEL_TEXT_DELTA_EVENT: {
        if (!single)
          break;
        if (typeof data.text === "string")
          this.#stream(data.text);
        break;
      }
      case "model.turn.completed": {
        const text2 = typeof data.text === "string" ? data.text : "";
        if (this.#streamed) {
          this.#endStream();
          this.#streamed = false;
        } else if (text2 !== "") {
          this.#write(text2);
        }
        this.#waiting(THINKING_LABEL);
        break;
      }
      case "tool.execution.started": {
        const tool = typeof data.tool === "string" ? data.tool : "?";
        this.#write(`${this.#dim("\u2192")} ${tool} ${this.#dim(previewInput(data.input))}`);
        this.#waiting(tool);
        break;
      }
      case "tool.execution.completed": {
        const ok = data.ok === true;
        const denied = data.denied === true;
        this.#write(ok ? "  \u2713" : `  \u2717 (${denied ? "denied" : "error"})`);
        this.#waiting(THINKING_LABEL);
        break;
      }
      case "context.compacted": {
        const elided = typeof data.elided === "number" ? data.elided : 0;
        const savedChars = typeof data.savedChars === "number" ? data.savedChars : 0;
        this.#write(this.#dim(`\u2248 context compacted: ${elided} tool result${elided === 1 ? "" : "s"} elided, ${savedChars} chars saved`));
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
        const model = stringOrUndefined(data.model);
        const modelSuffix = model === void 0 ? "" : ` [${model}]`;
        const routing = routingLabel(data.routing);
        const parens = routing === void 0 ? `attempt ${attempt}` : `${routing}, attempt ${attempt}`;
        this.#write(`\u25B6 ${taskId} \u2192 ${agent}${modelSuffix} (${parens})`);
        break;
      }
      case "task.completed": {
        const result = isRecord8(data.result) ? data.result : {};
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
  /**
   * Renders a normalized `claude-code.*` event.
   *
   * The payload is a raw Claude API streaming line, so the two things worth
   * showing are pulled out of it by hand: the assistant's own text, streamed a
   * delta at a time exactly like the native loop's (buffered to the end of the
   * block only when the events belong to one task among several, where partial
   * lines from different tasks would interleave), and the name of each tool
   * as it starts, which is what makes a long turn legible. Everything else —
   * `message_start`, usage rollups, the synthetic `completed` marker, and any
   * event type this wrapper does not model yet — stays quiet, exactly as the
   * native renderer does for unknown types.
   */
  #emitClaudeCode(kind, data, single) {
    const event2 = isRecord8(data.event) ? data.event : data;
    switch (kind) {
      case "tool_use": {
        const name = typeof data.name === "string" && data.name !== "" ? data.name : "tool";
        this.#write(`${this.#dim("\u2192")} claude: ${name}`);
        this.#waiting(name);
        break;
      }
      case "content_block_delta": {
        const delta = isRecord8(event2.delta) ? event2.delta : void 0;
        if (delta?.type !== "text_delta")
          break;
        if (typeof delta.text !== "string")
          break;
        if (single)
          this.#stream(delta.text);
        else
          this.#claudeText += delta.text;
        break;
      }
      case "content_block_stop":
      case "message_stop": {
        this.#endStream();
        const buffered = this.#claudeText.trim();
        this.#claudeText = "";
        if (buffered !== "")
          this.#write(buffered);
        this.#waiting(THINKING_LABEL);
        break;
      }
      default:
        break;
    }
  }
  result(result, usage) {
    this.#endTurn();
    this.#write("");
    this.#write(this.#bold(`status: ${EXIT_LABEL[result.status]}`));
    this.#write(result.summary);
    if (isDelegatedResult(result)) {
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
var MAX_PIPED_STDIN_BYTES = 1024 * 1024;
var PIPED_STDIN_TRUNCATION_MARKER = "\n[stdin truncated]";
var PIPED_STDIN_DELIMITER = "\n\n--- piped input ---\n";
async function readPipedStdin(input, maxBytes = MAX_PIPED_STDIN_BYTES) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of input) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total >= maxBytes) {
      truncated = true;
      continue;
    }
    const remaining = maxBytes - total;
    if (buf.length > remaining) {
      chunks.push(buf.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      continue;
    }
    chunks.push(buf);
    total += buf.length;
  }
  const text2 = Buffer.concat(chunks).toString("utf8");
  return truncated ? `${text2}${PIPED_STDIN_TRUNCATION_MARKER}` : text2;
}
function composeObjectiveWithStdin(objective, pipedStdin) {
  if (pipedStdin === "")
    return objective;
  return `${objective}${PIPED_STDIN_DELIMITER}${pipedStdin}`;
}
async function objectiveWithPipedStdin(objective, input) {
  if (input.isTTY === true)
    return objective;
  const piped = await readPipedStdin(input);
  return composeObjectiveWithStdin(objective, piped);
}
var DEFAULT_COMPACTION = {};
function agentLoopOptions(args) {
  return {
    agent: args.agent,
    provider: args.provider,
    tools: builtinTools(),
    permissions: args.permissions,
    usage: args.usage,
    events: args.events,
    maxIterations: args.maxIterations,
    ...args.timeoutMs === void 0 ? {} : { timeoutMs: args.timeoutMs },
    compaction: DEFAULT_COMPACTION
  };
}
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
function errorMessage8(error) {
  return error instanceof Error ? error.message : String(error);
}
async function resolveModelAndProvider(env, alias) {
  const registry = await buildRegistry(env);
  let model;
  try {
    model = registry.get(alias);
  } catch (error) {
    return { error: errorMessage8(error) };
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
  const workspacePath = path4.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const alias = resolveOrchestratorModel(options.model, process.env, options.config).value;
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved) {
    console.error(resolved.error);
    return 1;
  }
  const { model, provider } = resolved;
  const promptState = createPromptState();
  const sessionAllowlist = new SessionAllowlist();
  const usage = new UsageTracker();
  const renderer = options.json ? new JsonRenderer() : new TextRenderer(process.stdout, {
    tokens: () => {
      const totals = usage.totals().usage;
      return totals.inputTokens + totals.outputTokens;
    },
    // A permission question owns the screen while it waits for an answer.
    suspended: () => promptState.active
  });
  const prompter = createPrompter({
    yes: options.yes,
    interactive: process.stdin.isTTY === true && !options.json,
    state: promptState,
    allowlist: sessionAllowlist
  });
  const repoPermission = await loadRepoPermissionRules(workspacePath);
  const permissionRules = resolvePermissionRules(DEFAULT_PERMISSIONS, options.config?.permission, repoPermission);
  const permissions = new PermissionEngine(permissionRules, {
    defaultDecision: "ask",
    overlay: sessionAllowlist,
    ...prompter === void 0 ? {} : { prompter }
  });
  const instructions = loadInstructions(workspacePath, process.env);
  const agent = {
    name: "agent",
    role: "worker",
    model,
    systemPrompt: options.system ?? composeSystemPrompt(defaultSystemPrompt(workspacePath), instructions),
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
    const loop = new AgentLoop(agentLoopOptions({
      agent,
      provider,
      permissions,
      usage,
      events: renderer,
      maxIterations: options.maxIterations,
      ...options.timeoutSeconds === void 0 ? {} : { timeoutMs: options.timeoutSeconds * 1e3 }
    }));
    const result = await loop.run({
      instruction: objective,
      ...options.images !== void 0 && options.images.length > 0 ? { images: options.images } : {}
    }, {
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
var defaultDelegatedPlannerFactory = (args) => new DelegatedPlanner(args);
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
function errorMessage9(error) {
  return error instanceof Error ? error.message : String(error);
}
async function readOptionalFile(filePath) {
  try {
    return await readFile9(filePath, "utf8");
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
      output.error(`Note: planning with the default model instead of the orchestrator agent "${policy.orchestrator}" \u2014 ${errorMessage9(error)}`);
    }
  }
  const alias = resolveOrchestratorModel(options.model, process.env, options.config).value;
  return resolveModelAndProvider(process.env, alias);
}
function delegatedPlannerModelId(project, policy, options) {
  if (options.model !== void 0 && options.model !== "")
    return options.model;
  return createDelegatedModelResolver(project)(policy.orchestrator);
}
async function preparePlan(objective, options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const { json } = options;
  const workspacePath = path5.resolve(options.cwd);
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
  const lockPath = path5.join(project.root, LOCK_FILE_NAME);
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
  const knownAgents = [...project.knownAgentNames()];
  let planner;
  let plannerModel;
  if (isDelegatedBackend(options.backend)) {
    const backend = options.backend;
    const modelId = delegatedPlannerModelId(project, policy, options);
    const factory = deps.delegatedPlannerFactory;
    if (factory === void 0) {
      const unavailable = await delegatedBackendError(backend);
      if (unavailable !== void 0)
        return fail(output, json, unavailable);
    }
    planner = (factory ?? defaultDelegatedPlannerFactory)({
      backend,
      workspacePath,
      knownAgents,
      ...modelId === void 0 ? {} : { model: modelId }
    });
    plannerModel = delegatedModelIdentity(backend, modelId);
  } else {
    const resolved = await resolvePlannerModel(project, policy, options, output);
    if ("error" in resolved)
      return fail(output, json, resolved.error);
    const plannerFactory = deps.plannerFactory ?? defaultPlannerFactory;
    planner = plannerFactory({
      provider: resolved.provider,
      model: resolved.model,
      knownAgents
    });
    plannerModel = resolved.model;
  }
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
    plannerModel
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
function explainTaskRoute(task, policy, project) {
  const decision = new PolicyRouter().decide(task, policy);
  const rule = decision.rule === void 0 ? void 0 : policy.routing.find((candidate) => candidate.id === decision.rule);
  const modelAlias = project.agent(decision.agent)?.modelAlias;
  return {
    taskId: task.id,
    title: task.title,
    type: task.type,
    complexity: task.complexity,
    agent: decision.agent,
    reason: decision.reason,
    ...modelAlias === void 0 ? {} : { modelAlias },
    ...rule === void 0 ? {} : { rule }
  };
}
function routeReasonSentence(explanation) {
  if (explanation.rule !== void 0) {
    const rule = explanation.rule;
    const criteria = [];
    if (rule.taskTypes.length > 0)
      criteria.push(`taskTypes=${rule.taskTypes.join(",")}`);
    if (rule.riskCategories.length > 0) {
      criteria.push(`riskCategories=${rule.riskCategories.join(",")}`);
    }
    if (rule.complexity.length > 0)
      criteria.push(`complexity=${rule.complexity.join(",")}`);
    const on = criteria.length === 0 ? "any task" : criteria.join(", ");
    return `rule ${rule.id} (${rule.strength}, weight ${rule.weight}) matched on ${on}`;
  }
  if (explanation.reason === "suggestedAgent") {
    return "no routing rule matched \u2014 used the plan's suggestedAgent";
  }
  return "no routing rule matched and no suggestedAgent \u2014 fell back to the policy's orchestrator";
}
function renderWhy(explanations, output) {
  output.log("Routing rationale:");
  for (const explanation of explanations) {
    const modelSuffix = explanation.modelAlias === void 0 ? "" : ` [${explanation.modelAlias}]`;
    output.log(`${explanation.taskId} (${explanation.type}, ${explanation.complexity}) -> ${explanation.agent}${modelSuffix}`);
    output.log(`    ${routeReasonSentence(explanation)}`);
  }
}
async function runPlan(objective, options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const prepared = await preparePlan(objective, options, deps);
  if ("exitCode" in prepared)
    return prepared.exitCode;
  if (options.why === void 0) {
    renderPlan(prepared, output, options.json);
    return 0;
  }
  const tasks = options.why === true ? prepared.plan.tasks : prepared.plan.tasks.filter((task) => task.id === options.why);
  if (tasks.length === 0) {
    const known = prepared.plan.tasks.map((task) => task.id).join(", ");
    return fail(output, options.json, `No task ${options.why} in this plan.${known === "" ? "" : ` Known tasks: ${known}.`}`).exitCode;
  }
  const explanations = tasks.map((task) => explainTaskRoute(task, prepared.policy, prepared.project));
  if (options.json) {
    jsonLine(output, {
      plan: prepared.plan,
      injectedReviews: prepared.injectedReviews,
      notes: prepared.notes,
      routes: prepared.routes,
      why: explanations
    });
    return 0;
  }
  renderPlan(prepared, output, false);
  output.log("");
  renderWhy(explanations, output);
  return 0;
}

// apps/cli/dist/sessions.js
import { existsSync } from "node:fs";
import path6 from "node:path";

// packages/session/dist/resolve.js
var SHORT_ID_LENGTH = 8;
function shortId(id) {
  return id.slice(0, SHORT_ID_LENGTH);
}
function availableSessionsHint(records) {
  if (records.length === 0)
    return "";
  const listed = records.slice(0, 20).map((record) => shortId(record.id));
  return ` Available: ${listed.join(", ")}.`;
}
function resolveChatSessionReference(records, reference, options = {}) {
  const exactId = records.find((record) => record.id === reference);
  if (exactId !== void 0)
    return { record: exactId };
  const idPrefixMatches = records.filter((record) => record.id.startsWith(reference));
  if (idPrefixMatches.length === 1) {
    return { record: idPrefixMatches[0] };
  }
  if (idPrefixMatches.length > 1) {
    const ids = idPrefixMatches.map((record) => shortId(record.id));
    return {
      error: `"${reference}" matches ${idPrefixMatches.length} sessions: ${ids.join(", ")}. Use a longer prefix.`
    };
  }
  const nameMatches = records.filter((record) => record.name === reference);
  const first = nameMatches[0];
  if (first !== void 0) {
    if (nameMatches.length > 1) {
      options.onNote?.(`Multiple sessions are named "${reference}"; using the most recently updated one (${shortId(first.id)}).`);
    }
    return { record: first };
  }
  return {
    error: `No chat session matches "${reference}".${availableSessionsHint(records)}`
  };
}

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
var chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  workspacePath: text("workspace_path").notNull(),
  title: text("title").notNull(),
  /**
   * User-given label, set via `/name` or `--name`, distinct from `title`
   * (which is auto-derived from the first message). Nullable, and added
   * after the table's original release: `BOOTSTRAP_DDL` below only creates
   * it for a brand new database, so a v0.5.0 database (created before this
   * column existed) needs the `ALTER TABLE` migration `SqliteSessionStore`
   * runs on open — see `ensureChatSessionsNameColumn` in `sqlite.ts`.
   */
  name: text("name"),
  modelAlias: text("model_alias"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  messageCount: integer("message_count").notNull().default(0)
}, (table) => [
  index("chat_sessions_workspace_path_idx").on(table.workspacePath),
  index("chat_sessions_updated_at_idx").on(table.updatedAt),
  index("chat_sessions_name_idx").on(table.name)
]);
var chatMessages = sqliteTable("chat_messages", {
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  messageJson: text("message_json").notNull(),
  createdAt: integer("created_at").notNull()
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.seq] }),
  index("chat_messages_session_id_idx").on(table.sessionId)
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

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  title TEXT NOT NULL,
  name TEXT,
  model_alias TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chat_sessions_workspace_path_idx
  ON chat_sessions (workspace_path);
CREATE INDEX IF NOT EXISTS chat_sessions_updated_at_idx
  ON chat_sessions (updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx
  ON chat_messages (session_id);
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
var CHAT_TITLE_MAX = 60;
function chatTitleFrom(instruction) {
  const firstLine4 = (instruction.split("\n")[0] ?? "").trim();
  if (firstLine4.length <= CHAT_TITLE_MAX)
    return firstLine4;
  return `${firstLine4.slice(0, CHAT_TITLE_MAX - 1).trimEnd()}\u2026`;
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
function ensureChatSessionsNameColumn(sqlite) {
  const columns = sqlite.pragma("table_info(chat_sessions)");
  const hasName = columns.some((column) => column.name === "name");
  if (!hasName) {
    sqlite.exec("ALTER TABLE chat_sessions ADD COLUMN name TEXT");
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS chat_sessions_name_idx ON chat_sessions (name)");
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
    ensureChatSessionsNameColumn(this.#sqlite);
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
  // --- Chat sessions ------------------------------------------------------
  /**
   * Registers a new conversation. Idempotent on `id`: re-creating an existing
   * session leaves the stored row (and its transcript) untouched, so a caller
   * that cannot tell whether it already started is free to call this anyway.
   */
  async createChatSession(session) {
    this.#db.insert(chatSessions).values({
      id: session.id,
      workspacePath: session.workspacePath,
      title: session.title,
      name: session.name ?? null,
      modelAlias: session.modelAlias ?? null,
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
      messageCount: 0
    }).onConflictDoNothing().run();
  }
  /**
   * Writes messages by `(sessionId, seq)` in one transaction, last write
   * wins. Because identity is the sequence number rather than insertion
   * order, re-saving an overlapping snapshot of the transcript is safe: it
   * rewrites those rows instead of duplicating them.
   *
   * Afterwards the session's `updatedAt` is bumped and its `messageCount`
   * recomputed as `max(seq) + 1` over everything stored for the session, so
   * incremental and whole-transcript saves agree. An empty batch is a no-op —
   * it does not touch the session.
   */
  async appendChatMessages(sessionId, messages) {
    if (messages.length === 0)
      return;
    const now = Date.now();
    const rows = messages.map((entry) => ({
      sessionId,
      seq: entry.seq,
      messageJson: stringifyJson(entry.message) ?? "null",
      createdAt: now
    }));
    this.#db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(chatMessages).values(row).onConflictDoUpdate({
          target: [chatMessages.sessionId, chatMessages.seq],
          set: { messageJson: row.messageJson, createdAt: row.createdAt }
        }).run();
      }
      const highest = tx.select({ maxSeq: sql2`max(${chatMessages.seq})` }).from(chatMessages).where(eq(chatMessages.sessionId, sessionId)).get();
      tx.update(chatSessions).set({ updatedAt: now, messageCount: (highest?.maxSeq ?? -1) + 1 }).where(eq(chatSessions.id, sessionId)).run();
    });
  }
  /** Rewrites the auto-derived title and marks the session as freshly touched. */
  async setChatSessionTitle(sessionId, title) {
    this.#db.update(chatSessions).set({ title, updatedAt: Date.now() }).where(eq(chatSessions.id, sessionId)).run();
  }
  /**
   * Sets a session's user-given `name` (`/name`, `kapel sessions rename` —
   * whatever the caller spells it as) and marks it as freshly touched.
   * Renaming a session that is not there is a silent no-op, like
   * {@link setChatSessionTitle}.
   */
  async renameChatSession(sessionId, name) {
    this.#db.update(chatSessions).set({ name, updatedAt: Date.now() }).where(eq(chatSessions.id, sessionId)).run();
  }
  /**
   * Sessions newest-touched first. `workspacePath` is compared verbatim —
   * the caller is expected to have `path.resolve`d both the value it stored
   * and the value it filters by; the store does no normalization of its own.
   */
  async listChatSessions(workspacePath, options) {
    const limit = options?.limit;
    const selection = this.#db.select().from(chatSessions);
    const filtered = workspacePath === void 0 ? selection : selection.where(eq(chatSessions.workspacePath, workspacePath));
    const ordered = filtered.orderBy(desc(chatSessions.updatedAt), desc(chatSessions.createdAt), desc(chatSessions.id));
    const rows = limit === void 0 ? ordered.all() : ordered.limit(Math.max(0, limit)).all();
    return rows.map(toChatSessionRecord);
  }
  /**
   * Reads a session and its transcript, ordered by `seq`. Messages whose JSON
   * no longer parses are skipped rather than thrown over: a single corrupt
   * row must not make a conversation unresumable.
   */
  async loadChatSession(sessionId) {
    const row = this.#db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1).get();
    if (row === void 0)
      return void 0;
    const messageRows = this.#db.select().from(chatMessages).where(eq(chatMessages.sessionId, sessionId)).orderBy(asc(chatMessages.seq)).all();
    const messages = [];
    for (const messageRow of messageRows) {
      const message = parseJson(messageRow.messageJson);
      if (message === void 0 || message === null)
        continue;
      messages.push(message);
    }
    return { record: toChatSessionRecord(row), messages };
  }
  /** Drops a session and its transcript together. */
  async deleteChatSession(sessionId) {
    this.#db.transaction((tx) => {
      tx.delete(chatMessages).where(eq(chatMessages.sessionId, sessionId)).run();
      tx.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
    });
  }
  /**
   * Copies a session — its metadata (workspace, title, model) and its whole
   * transcript as of now — into a brand new session, and returns the new
   * session's id.
   *
   * The fork is independent from the moment it is created: it does not carry
   * the source id forward anywhere, so appending to either session afterwards
   * never touches the other. `options.name` labels the new session; leaving
   * it out leaves the fork unnamed even if the source had a name, since a
   * name is a label the user chose for one specific conversation branch, not
   * a property that should silently propagate to every copy of it.
   *
   * Throws if `sessionId` does not name an existing session — unlike the
   * read paths, a fork has nothing useful to return for a source that isn't
   * there.
   */
  async forkChatSession(sessionId, options = {}) {
    const newId = crypto.randomUUID();
    const now = Date.now();
    this.#db.transaction((tx) => {
      const source = tx.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1).get();
      if (source === void 0) {
        throw new Error(`Chat session ${sessionId} not found`);
      }
      tx.insert(chatSessions).values({
        id: newId,
        workspacePath: source.workspacePath,
        title: source.title,
        name: options.name ?? null,
        modelAlias: source.modelAlias,
        createdAt: now,
        updatedAt: now,
        messageCount: source.messageCount
      }).run();
      const sourceMessages = tx.select().from(chatMessages).where(eq(chatMessages.sessionId, sessionId)).all();
      for (const message of sourceMessages) {
        tx.insert(chatMessages).values({
          sessionId: newId,
          seq: message.seq,
          messageJson: message.messageJson,
          createdAt: now
        }).run();
      }
    });
    return newId;
  }
  close() {
    this.#sqlite.close();
  }
};
function toChatSessionRecord(row) {
  return {
    id: row.id,
    workspacePath: row.workspacePath,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: row.messageCount,
    ...row.name === null ? {} : { name: row.name },
    ...row.modelAlias === null ? {} : { modelAlias: row.modelAlias }
  };
}
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
      if (event2.type === MODEL_TEXT_DELTA_EVENT)
        return void 0;
      return store.appendEvent(event2).then(() => void 0, () => void 0);
    }
  };
}
function sessionDbPathFor(workspacePath) {
  return defaultSessionDbPath(path6.join(path6.resolve(workspacePath), ".agent"));
}
async function openRunStore(workspacePath) {
  const agentDir = await findAgentDir(path6.resolve(workspacePath));
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
var SHORT_ID = 8;
function shortSessionId(id) {
  return id.slice(0, SHORT_ID);
}
var DEFAULT_SESSIONS_LIST_LIMIT = 20;
function sessionRow(record, showName) {
  const base = [shortSessionId(record.id)];
  if (showName)
    base.push(record.name ?? "");
  base.push(isoTime(record.updatedAt), String(record.messageCount), record.title === "" ? "(untitled)" : record.title);
  return base;
}
async function runSessionsListCommand(options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const store = openExistingRunStore(options.cwd);
  if (store === void 0) {
    if (options.json)
      output.log(JSON.stringify([]));
    else {
      output.log(`No chat sessions recorded yet \u2014 nothing at ${sessionDbPathFor(options.cwd)}.`);
    }
    return 0;
  }
  try {
    const records = await store.listChatSessions(path6.resolve(options.cwd), {
      limit: options.limit ?? DEFAULT_SESSIONS_LIST_LIMIT
    });
    if (options.json) {
      output.log(JSON.stringify(records.map((record) => ({
        id: record.id,
        ...record.name === void 0 ? {} : { name: record.name },
        title: record.title,
        ...record.modelAlias === void 0 ? {} : { modelAlias: record.modelAlias },
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messageCount
      }))));
      return 0;
    }
    if (records.length === 0) {
      output.log("No chat sessions recorded yet.");
      return 0;
    }
    const showName = records.some((record) => record.name !== void 0);
    const headers = showName ? ["ID", "NAME", "UPDATED", "MSGS", "TITLE"] : ["ID", "UPDATED", "MSGS", "TITLE"];
    for (const line of formatTable(headers, records.map((record) => sessionRow(record, showName)))) {
      output.log(line);
    }
    return 0;
  } finally {
    closeRunStore(store);
  }
}
async function runSessionsForkCommand(options, deps = {}) {
  const output = deps.output ?? consoleOutput;
  const store = openExistingRunStore(options.cwd);
  if (store === void 0) {
    output.error(`No chat sessions recorded yet \u2014 nothing at ${sessionDbPathFor(options.cwd)}.`);
    return 1;
  }
  try {
    const records = await store.listChatSessions(path6.resolve(options.cwd));
    const resolved = resolveChatSessionReference(records, options.session, {
      onNote: (note) => output.error(note)
    });
    if ("error" in resolved) {
      output.error(resolved.error);
      return 1;
    }
    const newId = await store.forkChatSession(resolved.record.id, options.name === void 0 ? {} : { name: options.name });
    if (options.json) {
      output.log(JSON.stringify({
        id: newId,
        forkedFrom: resolved.record.id,
        ...options.name === void 0 ? {} : { name: options.name }
      }));
    } else {
      const label = options.name === void 0 ? "" : ` "${options.name}"`;
      output.log(`Forked ${shortSessionId(resolved.record.id)} \u2192 ${shortSessionId(newId)}${label}`);
    }
    return 0;
  } finally {
    closeRunStore(store);
  }
}

// apps/cli/dist/explain-cmd.js
function isRecord9(value) {
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
function explainRoute(task, policy) {
  const decision = new PolicyRouter().decide(task, policy);
  if (decision.rule !== void 0) {
    return { agent: decision.agent, rule: decision.rule };
  }
  return {
    agent: decision.agent,
    fallback: decision.reason === "suggestedAgent" ? "suggestedAgent" : "orchestrator"
  };
}
function routeSentence(route) {
  if (route.rule !== void 0) {
    return `routed to ${route.agent} by rule ${route.rule}`;
  }
  return route.fallback === "suggestedAgent" ? `routed to ${route.agent} \u2014 no routing rule matched, so the plan's suggestedAgent was used` : `routed to ${route.agent} \u2014 no routing rule matched and the task suggested no agent, so it fell back to the policy's orchestrator`;
}
function digestEvent(event2) {
  const data = isRecord9(event2.data) ? event2.data : {};
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
      const result = isRecord9(data.result) ? data.result : {};
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

// apps/cli/dist/images.js
import { readFile as readFile10, stat as stat4 } from "node:fs/promises";
import path7 from "node:path";
var MAX_IMAGE_COUNT = 4;
var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
var MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
function formatBytes(n) {
  if (n < 1024 * 1024)
    return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
async function resolveImageAttachments(paths, cwd) {
  if (paths.length === 0)
    return { ok: true, images: [] };
  if (paths.length > MAX_IMAGE_COUNT) {
    return {
      ok: false,
      error: `Too many images: got ${paths.length}, but at most ${MAX_IMAGE_COUNT} are allowed per run.`
    };
  }
  const images = [];
  let totalBytes = 0;
  for (const raw of paths) {
    const resolved = path7.resolve(cwd, raw);
    let info;
    try {
      info = await stat4(resolved);
    } catch {
      return { ok: false, error: `Image not found: "${raw}"` };
    }
    if (!info.isFile()) {
      return { ok: false, error: `Not a file: "${raw}"` };
    }
    if (info.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Image "${raw}" is ${formatBytes(info.size)}, over the ${formatBytes(MAX_IMAGE_BYTES)} per-image limit.`
      };
    }
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Attached images total ${formatBytes(totalBytes)}, over the ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} combined limit.`
      };
    }
    let bytes;
    try {
      bytes = await readFile10(resolved);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Could not read image "${raw}": ${detail}` };
    }
    const mediaType = resolveImageMediaType(bytes, resolved);
    if (mediaType === void 0) {
      return {
        ok: false,
        error: `Unrecognized image format for "${raw}": expected PNG, JPEG, GIF or WEBP.`
      };
    }
    images.push({
      mediaType,
      base64: bytes.toString("base64"),
      path: resolved
    });
  }
  return { ok: true, images };
}

// apps/cli/dist/init.js
import { cp, readFile as readFile11, rm as rm2, stat as stat5, writeFile as writeFile4 } from "node:fs/promises";
import path8 from "node:path";
import { fileURLToPath } from "node:url";
var TEMPLATE_RELATIVE = ["templates", "default", ".agent"];
var MAX_WALK_LEVELS = 6;
var PROJECT_ROLE_SOURCES = [
  ["lead", "orchestrator"],
  ["complex", "complex"],
  ["worker", "middle"],
  ["cheap", "low"],
  // The reviewer reads someone else's work and judges it, which is the
  // orchestrator's kind of job rather than a worker's — so it gets the
  // orchestrator's model rather than another answer nobody was asked for.
  ["reviewer", "orchestrator"]
];
var ANTHROPIC_MODEL = /^(claude-|opus|sonnet|haiku)/;
function providerForModel(model, backend) {
  if (ANTHROPIC_MODEL.test(model))
    return "anthropic";
  if (model === "default") {
    return backend === "claude-code" ? "anthropic" : "openai";
  }
  return "openai";
}
function renderModelsBlock(config) {
  const lines = ["models:"];
  for (const [projectRole, role] of PROJECT_ROLE_SOURCES) {
    const model = config.models[role];
    lines.push(`  ${projectRole}:`, `    provider: ${providerForModel(model, config.backend)}`, `    model: ${model}`);
  }
  return lines;
}
function seedModelsInto(templateYaml, config) {
  const lines = templateYaml.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "models:");
  if (start === -1)
    return templateYaml;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() !== "" && !/^\s/.test(line))
      break;
    end += 1;
  }
  return [
    ...lines.slice(0, start),
    ...renderModelsBlock(config),
    "",
    ...lines.slice(end)
  ].join("\n");
}
async function pathExists(candidate) {
  try {
    await stat5(candidate);
    return true;
  } catch {
    return false;
  }
}
async function locateTemplate(startDir, maxLevels = MAX_WALK_LEVELS) {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level += 1) {
    const candidate = path8.join(dir, ...TEMPLATE_RELATIVE);
    if (await pathExists(candidate))
      return candidate;
    const parent = path8.dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  throw new Error(`Could not find ${TEMPLATE_RELATIVE.join("/")} by walking up from ${startDir} (searched ${maxLevels} levels up). Is this CLI running from within the multi-model-orchestration-agent repo?`);
}
async function runInit(options) {
  const entryDir = path8.dirname(fileURLToPath(options.entryUrl ?? import.meta.url));
  let templateDir;
  try {
    templateDir = await locateTemplate(entryDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const target = path8.join(options.cwd, ".agent");
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
  const config = options.config;
  if (config !== void 0) {
    const configPath = path8.join(target, "config.yaml");
    try {
      const template = await readFile11(configPath, "utf8");
      await writeFile4(configPath, seedModelsInto(template, config), "utf8");
      console.log("  (models seeded from your kapel configuration)");
    } catch {
    }
  }
  return 0;
}

// apps/cli/dist/interactive.js
import { mkdir as mkdir6 } from "node:fs/promises";
import path13 from "node:path";
import * as readline4 from "node:readline";

// apps/cli/dist/checkpoint.js
import { execFile as execFile8 } from "node:child_process";
import { copyFile, mkdir as mkdir4, mkdtemp, rm as rm3, rmdir as rmdir2, stat as stat6, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path9 from "node:path";
import { promisify as promisify5 } from "node:util";
var execFileAsync5 = promisify5(execFile8);
var MAX_BUFFER_BYTES4 = 64 * 1024 * 1024;
var MAX_CHECKPOINTS = 20;
var MAX_LABEL_CHARS = 48;
var EXCLUDED_DIR = ".agent";
var CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "kapel",
  GIT_AUTHOR_EMAIL: "kapel@localhost",
  GIT_COMMITTER_NAME: "kapel",
  GIT_COMMITTER_EMAIL: "kapel@localhost"
};
var RACY_MARGIN_MS = 1e3;
var RESTORE_BATCH = 200;
var IN_PROGRESS = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["BISECT_LOG", "a bisect"]
];
function checkpointLabel(prompt) {
  const line = prompt.split("\n").map((value) => value.trim()).find((value) => value.length > 0) ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}\u2026` : collapsed;
}
function formatAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1e3));
  if (seconds < 5)
    return "just now";
  if (seconds < 90)
    return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90)
    return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} hr ago`;
}
function undoLines(outcome) {
  if (!outcome.ok)
    return [outcome.reason];
  const age = formatAge(outcome.ageMs);
  const quoted = outcome.label === "" ? "the last prompt" : `"${outcome.label}"`;
  if (outcome.restored === 0) {
    return [`\u21A9 nothing had changed since ${quoted} (${age})`];
  }
  const plural = outcome.restored === 1 ? "" : "s";
  return [
    `\u21A9 restored ${outcome.restored} file${plural} to before ${quoted} (${age})`,
    "  every edit since then is gone, including ones made by shell commands or other programs \u2014 undo is one-way"
  ];
}
async function git(args, cwd, env) {
  try {
    const result = await execFileAsync5("git", [...args], {
      cwd,
      ...env === void 0 ? {} : { env },
      maxBuffer: MAX_BUFFER_BYTES4,
      windowsHide: true
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error;
    return {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? String(error),
      exitCode: typeof value.code === "number" ? value.code : 127
    };
  }
}
function failure(operation, result) {
  const detail = result.stderr.trim().split("\n")[0] ?? "";
  return new Error(detail === "" ? `git ${operation} failed (exit ${result.exitCode})` : `git ${operation} failed: ${detail}`);
}
async function detectRepo(workspacePath) {
  const root = await git(["rev-parse", "--show-toplevel"], workspacePath);
  if (root.exitCode !== 0)
    return void 0;
  const gitDir = await git(["rev-parse", "--absolute-git-dir"], workspacePath);
  if (gitDir.exitCode !== 0)
    return void 0;
  const top = root.stdout.trim();
  const dir = gitDir.stdout.trim();
  if (top === "" || dir === "")
    return void 0;
  return { root: top, gitDir: dir };
}
async function tempRoot() {
  const root = process.env.AGENT_TEST_TMPDIR || tmpdir();
  await mkdir4(root, { recursive: true });
  return root;
}
async function withTempIndex(repo, seed, fn) {
  const dir = await mkdtemp(path9.join(await tempRoot(), "kapel-checkpoint-"));
  try {
    const indexPath = path9.join(dir, "index");
    if (seed) {
      const source = path9.join(repo.gitDir, "index");
      try {
        const original = await stat6(source);
        await copyFile(source, indexPath);
        const asOf = new Date(original.mtimeMs - RACY_MARGIN_MS);
        await utimes(indexPath, asOf, asOf);
      } catch {
      }
    }
    return await fn({ ...process.env, GIT_INDEX_FILE: indexPath });
  } finally {
    await rm3(dir, { recursive: true, force: true });
  }
}
async function snapshotTree(repo) {
  return await withTempIndex(repo, true, async (env) => {
    const added = await git(["add", "-A", "--", ".", `:(exclude)${EXCLUDED_DIR}`], repo.root, env);
    if (added.exitCode !== 0)
      throw failure("add", added);
    const written = await git(["write-tree"], repo.root, env);
    if (written.exitCode !== 0)
      throw failure("write-tree", written);
    const tree = written.stdout.trim();
    if (tree === "")
      throw new Error("git write-tree produced no tree");
    return tree;
  });
}
async function commitSnapshot(repo, tree, label) {
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], repo.root);
  const parent = head.exitCode === 0 ? head.stdout.trim() : "";
  const result = await git([
    "commit-tree",
    tree,
    ...parent === "" ? [] : ["-p", parent],
    "--no-gpg-sign",
    "-m",
    `kapel checkpoint: ${label}`
  ], repo.root, { ...process.env, ...CHECKPOINT_IDENTITY });
  if (result.exitCode !== 0)
    throw failure("commit-tree", result);
  return result.stdout.trim();
}
function isExcluded(relativePath) {
  return relativePath === EXCLUDED_DIR || relativePath.startsWith(`${EXCLUDED_DIR}/`);
}
async function diffTrees(repo, from, to) {
  const result = await git(["diff", "--raw", "-z", "--no-renames", from, to], repo.root);
  if (result.exitCode !== 0)
    throw failure("diff", result);
  const fields = result.stdout.split("\0");
  const changes = [];
  for (let i = 0; i < fields.length; i += 1) {
    const meta = fields[i];
    if (meta === void 0 || !meta.startsWith(":"))
      continue;
    const target = fields[i + 1];
    i += 1;
    if (target === void 0 || target === "" || isExcluded(target))
      continue;
    const parts = meta.slice(1).split(" ");
    const srcMode = parts[0] ?? "";
    const dstMode = parts[1] ?? "";
    const status = parts[4] ?? "";
    if (srcMode === "160000" || dstMode === "160000")
      continue;
    changes.push({ status, path: target });
  }
  return changes;
}
async function pruneEmptyParents(root, filePath) {
  let dir = path9.dirname(path9.join(root, filePath));
  while (dir !== root && dir.startsWith(`${root}${path9.sep}`)) {
    try {
      await rmdir2(dir);
    } catch {
      return;
    }
    dir = path9.dirname(dir);
  }
}
async function checkoutPaths(repo, tree, paths) {
  if (paths.length === 0)
    return;
  await withTempIndex(repo, false, async (env) => {
    const read = await git(["read-tree", tree], repo.root, env);
    if (read.exitCode !== 0)
      throw failure("read-tree", read);
    for (let i = 0; i < paths.length; i += RESTORE_BATCH) {
      const batch = paths.slice(i, i + RESTORE_BATCH);
      const checkedOut = await git(["checkout-index", "-f", "--", ...batch], repo.root, env);
      if (checkedOut.exitCode !== 0)
        throw failure("checkout-index", checkedOut);
    }
  });
}
async function inProgressOperation(gitDir) {
  for (const [entry, description] of IN_PROGRESS) {
    try {
      await stat6(path9.join(gitDir, entry));
      return description;
    } catch {
    }
  }
  return void 0;
}
function notARepositoryReason(workspacePath) {
  return `/undo needs a git repository \u2014 ${workspacePath} is not inside one, so nothing was checkpointed. Run \`git init\` to get undo.`;
}
function createCheckpointStore(options) {
  const now = options.now ?? (() => Date.now());
  const limit = options.limit ?? MAX_CHECKPOINTS;
  const stack = [];
  let repo;
  let warned = false;
  const resolveRepo = async () => {
    if (repo !== void 0)
      return repo;
    repo = await detectRepo(options.workspacePath);
    return repo;
  };
  const capture = async (prompt) => {
    const info = await resolveRepo();
    if (info === void 0)
      return void 0;
    try {
      const tree = await snapshotTree(info);
      const label = checkpointLabel(prompt);
      const commit = await commitSnapshot(info, tree, label);
      stack.push({ commit, tree, createdAt: now(), label });
      while (stack.length > limit)
        stack.shift();
      return void 0;
    } catch (error) {
      if (warned)
        return void 0;
      warned = true;
      const message = error instanceof Error ? error.message : String(error);
      return `(checkpoint failed, /undo will not cover this turn: ${message})`;
    }
  };
  const undo = async () => {
    const info = await resolveRepo();
    if (info === void 0) {
      return { ok: false, reason: notARepositoryReason(options.workspacePath) };
    }
    const entry = stack[stack.length - 1];
    if (entry === void 0) {
      return {
        ok: false,
        reason: "nothing to undo \u2014 no checkpoint has been taken in this session yet."
      };
    }
    const busy = await inProgressOperation(info.gitDir);
    if (busy !== void 0) {
      return {
        ok: false,
        reason: `/undo is unavailable while ${busy} is in progress \u2014 finish or abort it first, then try again. The checkpoint is kept.`
      };
    }
    try {
      const current = await snapshotTree(info);
      const changes = await diffTrees(info, current, entry.tree);
      const removals = changes.filter((change) => change.status === "D");
      const writes = changes.filter((change) => change.status !== "D");
      await checkoutPaths(info, entry.tree, writes.map((change) => change.path));
      for (const change of removals) {
        await rm3(path9.join(info.root, change.path), { force: true });
        await pruneEmptyParents(info.root, change.path);
      }
      stack.pop();
      return {
        ok: true,
        restored: changes.length,
        label: entry.label,
        ageMs: Math.max(0, now() - entry.createdAt)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `/undo could not restore the working tree: ${message}`
      };
    }
  };
  return {
    capture,
    undo,
    entries: () => stack.slice()
  };
}

// apps/cli/dist/commands.js
import { readdir as readdir4, readFile as readFile12 } from "node:fs/promises";
import path10 from "node:path";
import { parse as parseYaml3 } from "yaml";
var CUSTOM_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
var ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";
function splitFrontMatter2(raw) {
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
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function asOptionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function errorMessage10(error) {
  return error instanceof Error ? error.message : String(error);
}
function parseCustomCommandFile(filePath, name, raw) {
  const split = splitFrontMatter2(raw);
  if (split === void 0) {
    return { command: { name, template: raw.trim(), sourcePath: filePath } };
  }
  let value;
  try {
    value = parseYaml3(split.frontMatter);
  } catch (error) {
    return {
      warning: `skipping ${filePath}: front matter YAML parse error: ${errorMessage10(error)}`
    };
  }
  const record = asRecord2(value);
  const description = asOptionalString(record?.description);
  const model = asOptionalString(record?.model);
  return {
    command: {
      name,
      ...description === void 0 ? {} : { description },
      ...model === void 0 ? {} : { model },
      template: split.body.trim(),
      sourcePath: filePath
    }
  };
}
async function loadCustomCommands(workspacePath, builtinNames) {
  const agentDir = await findAgentDir(workspacePath);
  if (agentDir === void 0)
    return { commands: [], warnings: [] };
  const commandsDir = path10.join(agentDir, "commands");
  let entryNames;
  try {
    const entries = await readdir4(commandsDir, { withFileTypes: true });
    entryNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
  } catch {
    return { commands: [], warnings: [] };
  }
  const commands = [];
  const warnings = [];
  for (const fileName of entryNames) {
    const displayPath = `.agent/commands/${fileName}`;
    const stem = path10.basename(fileName, ".md");
    if (!CUSTOM_COMMAND_NAME_PATTERN.test(stem)) {
      warnings.push(`skipping ${displayPath}: "${stem}" is not a valid command name (expected ${CUSTOM_COMMAND_NAME_PATTERN.source})`);
      continue;
    }
    if (builtinNames.has(stem)) {
      warnings.push(`skipping ${displayPath}: "/${stem}" is a built-in command and cannot be overridden`);
      continue;
    }
    const filePath = path10.join(commandsDir, fileName);
    let raw;
    try {
      raw = await readFile12(filePath, "utf8");
    } catch (error) {
      warnings.push(`skipping ${displayPath}: ${errorMessage10(error)}`);
      continue;
    }
    const parsed = parseCustomCommandFile(displayPath, stem, raw);
    if ("warning" in parsed)
      warnings.push(parsed.warning);
    else
      commands.push(parsed.command);
  }
  return { commands, warnings };
}
function expandCustomCommand(command, argumentsText) {
  if (command.template.includes(ARGUMENTS_PLACEHOLDER)) {
    return command.template.split(ARGUMENTS_PLACEHOLDER).join(argumentsText);
  }
  return argumentsText === "" ? command.template : `${command.template}

${argumentsText}`;
}

// apps/cli/dist/delegated-chat.js
var DelegatedUsage = class {
  #inputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;
  add(turn) {
    if (turn.usage !== void 0) {
      this.#inputTokens += turn.usage.inputTokens;
      this.#outputTokens += turn.usage.outputTokens;
    }
    if (turn.costUsd !== void 0)
      this.#costUsd += turn.costUsd;
  }
  totals() {
    return {
      usage: {
        inputTokens: this.#inputTokens,
        outputTokens: this.#outputTokens
      },
      costUsd: this.#costUsd
    };
  }
};
function claudeCodeTurnRunner(options = {}) {
  const create = options.createBackend ?? ((backendOptions) => new ClaudeCodeBackend(backendOptions));
  return async (request) => {
    const resume = request.sessionRef;
    const backend = create({
      ...options.model === void 0 ? {} : { model: options.model },
      ...options.events === void 0 ? {} : { events: options.events },
      ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
      ...resume === void 0 ? {} : { extraArgs: ["--resume", resume] }
    });
    return await backendTurnRunner(backend, {
      promptWithTranscript: resume === void 0
    })(request);
  };
}
function createDelegatedChatSession(options) {
  const claudeCode = options.backend === "claude-code";
  const runner = options.runner ?? (claudeCode ? claudeCodeTurnRunner({
    ...options.model === void 0 ? {} : { model: options.model },
    ...options.events === void 0 ? {} : { events: options.events },
    ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
    ...options.createClaudeCodeBackend === void 0 ? {} : { createBackend: options.createClaudeCodeBackend }
  }) : backendTurnRunner(new CodexBackend({
    ...options.model === void 0 ? {} : { model: options.model },
    sandbox: DEFAULT_SANDBOX_MODE,
    fullAuto: fullAutoForSandbox(DEFAULT_SANDBOX_MODE),
    ...options.events === void 0 ? {} : { events: options.events },
    ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs }
  })));
  return BackendChatSession.fromModelMessages({
    runner,
    workspacePath: options.workspacePath,
    runId: options.runId,
    supportsContinuation: claudeCode,
    ...options.events === void 0 ? {} : { events: options.events }
  }, options.messages ?? [], options.sessionRef);
}

// apps/cli/dist/history.js
import { mkdir as mkdir5, readFile as readFile13, writeFile as writeFile5 } from "node:fs/promises";
import path11 from "node:path";
var HISTORY_LIMIT = 1e3;
var TRIM_THRESHOLD = HISTORY_LIMIT * 2;
function historyFilePath(env) {
  return path11.join(kapelConfigDir(env), "history");
}
async function loadHistory(env) {
  let raw;
  try {
    raw = await readFile13(historyFilePath(env), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const newestFirst = lines.reverse();
  return newestFirst.slice(0, HISTORY_LIMIT);
}
function createHistoryAppender(env) {
  const filePath = historyFilePath(env);
  let chain = Promise.resolve();
  let lastEntry;
  let dirEnsured = false;
  let lineCount;
  async function ensureDir() {
    if (dirEnsured)
      return;
    await mkdir5(path11.dirname(filePath), { recursive: true });
    dirEnsured = true;
  }
  async function currentLineCount() {
    try {
      const raw = await readFile13(filePath, "utf8");
      return raw.split("\n").filter((line) => line.trim() !== "").length;
    } catch {
      return 0;
    }
  }
  async function appendOne(entry) {
    try {
      await ensureDir();
      await writeFile5(filePath, `${entry}
`, { flag: "a" });
      lineCount = lineCount === void 0 ? await currentLineCount() : lineCount + 1;
      if (lineCount > TRIM_THRESHOLD) {
        await trim();
      }
    } catch {
    }
  }
  async function trim() {
    let raw;
    try {
      raw = await readFile13(filePath, "utf8");
    } catch {
      return;
    }
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const trimmed = lines.slice(-HISTORY_LIMIT);
    await writeFile5(filePath, `${trimmed.join("\n")}
`);
    lineCount = trimmed.length;
  }
  return (entry) => {
    if (entry === lastEntry)
      return;
    lastEntry = entry;
    chain = chain.then(() => appendOne(entry));
  };
}

// apps/cli/dist/input.js
import * as readline3 from "node:readline";
function initialAssembly() {
  return { pending: [] };
}
var CONTINUATION_PROMPT = "... ";
function reduceAssemblyLine(state, line) {
  if (line === "" && state.pending.length > 0) {
    return { type: "message", text: state.pending.join("\n") };
  }
  const endsInBackslash = line.endsWith("\\");
  const endsInEscapedBackslash = line.endsWith("\\\\");
  if (endsInBackslash && !endsInEscapedBackslash) {
    const stripped = line.slice(0, -1);
    return {
      type: "continue",
      state: { pending: [...state.pending, stripped] }
    };
  }
  const finalLine = endsInEscapedBackslash ? line.slice(0, -1) : line;
  const lines = [...state.pending, finalLine];
  return { type: "message", text: lines.join("\n") };
}
function historyEntryFor(message) {
  return message.replace(/\n/g, " ").trim();
}
var INPUT_SIGINT = /* @__PURE__ */ Symbol("input-sigint");
function isPromise(value) {
  return typeof value?.then === "function";
}
function toReadlineCompleter(completer) {
  return (line, callback) => {
    const empty = [[], line];
    try {
      const result = completer(line);
      if (isPromise(result)) {
        result.then((value) => callback(null, value), () => callback(null, empty));
        return;
      }
      callback(null, result);
    } catch {
      callback(null, empty);
    }
  };
}
var DEFAULT_PASTE_WINDOW_MS = 15;
function rlHistory(rl) {
  const history = rl.history;
  return Array.isArray(history) ? history : void 0;
}
function createInputManager(options) {
  const pasteWindowMs = options.pasteWindowMs ?? DEFAULT_PASTE_WINDOW_MS;
  const rl = readline3.createInterface({
    input: options.input,
    output: options.output,
    terminal: true,
    history: options.history ? [...options.history] : [],
    historySize: 200,
    ...options.completer ? { completer: toReadlineCompleter(options.completer) } : {}
  });
  let closed = false;
  let readPending;
  let questionPending;
  function clearCoalesceTimer() {
    if (readPending?.coalesceTimer !== void 0) {
      clearTimeout(readPending.coalesceTimer);
      readPending.coalesceTimer = void 0;
    }
  }
  function fixupHistoryFor(message) {
    const entry = historyEntryFor(message);
    if (entry === "")
      return;
    options.onHistoryAppend?.(entry);
    const history = rlHistory(rl);
    if (history === void 0)
      return;
    const linesTyped = message.split("\n").length;
    history.splice(0, Math.min(linesTyped, history.length));
    if (history[0] !== entry) {
      history.unshift(entry);
    }
  }
  function resolveRead(value) {
    if (readPending === void 0)
      return;
    clearCoalesceTimer();
    const { resolve: resolve5 } = readPending;
    readPending = void 0;
    resolve5(value);
  }
  function scheduleCoalesceFlush() {
    if (readPending === void 0)
      return;
    clearCoalesceTimer();
    readPending.coalesceTimer = setTimeout(() => {
      if (readPending === void 0)
        return;
      const message = readPending.coalesced ?? "";
      readPending.assembly = initialAssembly();
      fixupHistoryFor(message);
      resolveRead(message);
    }, pasteWindowMs);
  }
  rl.on("line", (line) => {
    if (questionPending !== void 0) {
      return;
    }
    if (readPending === void 0)
      return;
    const action = reduceAssemblyLine(readPending.assembly, line);
    if (action.type === "continue") {
      readPending.assembly = action.state;
      rl.setPrompt(CONTINUATION_PROMPT);
      rl.prompt();
      return;
    }
    readPending.assembly = initialAssembly();
    readPending.coalesced = readPending.coalesced === void 0 ? action.text : `${readPending.coalesced}
${action.text}`;
    scheduleCoalesceFlush();
  });
  rl.on("SIGINT", () => {
    if (questionPending !== void 0) {
      const { resolve: resolve5 } = questionPending;
      questionPending = void 0;
      resolve5(INPUT_SIGINT);
      return;
    }
    if (readPending !== void 0) {
      readPending.assembly = initialAssembly();
      resolveRead(INPUT_SIGINT);
      return;
    }
    options.onIdleSigint?.();
  });
  rl.on("close", () => {
    closed = true;
    if (questionPending !== void 0) {
      const { resolve: resolve5 } = questionPending;
      questionPending = void 0;
      resolve5(void 0);
    }
    resolveRead(void 0);
  });
  return {
    readMessage(promptText) {
      if (closed)
        return Promise.resolve(void 0);
      if (readPending !== void 0 || questionPending !== void 0) {
        throw new Error("InputManager.readMessage: a read is already in progress");
      }
      return new Promise((resolve5) => {
        readPending = {
          resolve: resolve5,
          assembly: initialAssembly(),
          promptText,
          coalesceTimer: void 0,
          coalesced: void 0
        };
        rl.setPrompt(promptText);
        rl.prompt();
      });
    },
    question(query) {
      if (closed)
        return Promise.resolve(void 0);
      if (readPending !== void 0 || questionPending !== void 0) {
        throw new Error("InputManager.question: a read is already in progress");
      }
      return new Promise((resolve5) => {
        questionPending = { resolve: resolve5 };
        rl.question(query, (answer) => {
          if (questionPending === void 0)
            return;
          questionPending = void 0;
          const history = rlHistory(rl);
          if (history !== void 0 && history[0] === answer) {
            history.shift();
          }
          resolve5(answer);
        });
      });
    },
    async withSuspended(fn) {
      const input = options.input;
      const wasRaw = input.isRaw === true;
      rl.pause();
      input.setRawMode?.(false);
      try {
        return await fn();
      } finally {
        const isTty = options.input.isTTY;
        input.setRawMode?.(wasRaw || isTty === true);
        rl.resume();
        if (readPending !== void 0) {
          rl.setPrompt(readPending.promptText);
          rl.prompt();
        }
      }
    },
    close() {
      if (closed)
        return;
      rl.close();
    }
  };
}

// apps/cli/dist/mention.js
import { execFile as execFile9 } from "node:child_process";
import { readdir as readdir5, stat as stat7 } from "node:fs/promises";
import path12 from "node:path";
import { promisify as promisify6 } from "node:util";
var execFileAsync6 = promisify6(execFile9);
var MATCH_BONUS = 4;
var CONSECUTIVE_BONUS = 8;
var BOUNDARY_BONUS = 6;
var GAP_START_PENALTY = -3;
var GAP_EXTRA_PENALTY = -1;
var GAP_MAX_PENALTY = -10;
var BOUNDARY_CHARS = /* @__PURE__ */ new Set(["/", "\\", "-", "_", ".", " "]);
function isBoundary(candidate, index2) {
  if (index2 === 0)
    return true;
  const previous = candidate[index2 - 1];
  return previous !== void 0 && BOUNDARY_CHARS.has(previous);
}
function gapPenalty(gap) {
  if (gap <= 0)
    return 0;
  return Math.max(GAP_START_PENALTY + (gap - 1) * GAP_EXTRA_PENALTY, GAP_MAX_PENALTY);
}
function fuzzyScore(candidate, query) {
  if (query === "")
    return 0;
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let previous = -1;
  for (const character of needle) {
    const index2 = haystack.indexOf(character, previous + 1);
    if (index2 === -1)
      return void 0;
    if (index2 === previous + 1 && previous !== -1) {
      score += CONSECUTIVE_BONUS;
    } else {
      score += MATCH_BONUS;
      if (previous !== -1)
        score += gapPenalty(index2 - previous - 1);
    }
    if (isBoundary(candidate, index2))
      score += BOUNDARY_BONUS;
    previous = index2;
  }
  return score;
}
function rankMentionMatches(paths, query, limit = MENTION_LIMIT) {
  const scored = [];
  for (const candidate of paths) {
    const score = fuzzyScore(candidate, query);
    if (score === void 0)
      continue;
    scored.push({ path: candidate, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score)
      return b.score - a.score;
    if (a.path.length !== b.path.length)
      return a.path.length - b.path.length;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return scored.slice(0, limit).map((entry) => entry.path);
}
function mentionTokenAt(line) {
  const boundary = Math.max(line.lastIndexOf(" "), line.lastIndexOf("	"));
  const token = line.slice(boundary + 1);
  if (!token.startsWith("@"))
    return void 0;
  return token;
}
var MENTION_LIMIT = 20;
var FILE_LIST_TTL_MS = 5e3;
var MAX_LISTED_FILES2 = 2e3;
var MAX_WALK_DEPTH = 4;
var SKIPPED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist"]);
var MAX_BUFFER_BYTES5 = 32 * 1024 * 1024;
async function gitListFiles(workspacePath) {
  try {
    const { stdout } = await execFileAsync6("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: workspacePath, maxBuffer: MAX_BUFFER_BYTES5 });
    return stdout.split("\n").filter((line) => line !== "");
  } catch {
    return void 0;
  }
}
function toPosix(relativePath) {
  return relativePath.split(path12.sep).join("/");
}
async function walkFiles(workspacePath, maxEntries) {
  const found = [];
  let level = [""];
  for (let depth = 0; depth <= MAX_WALK_DEPTH && level.length > 0; depth += 1) {
    const next = [];
    for (const relativeDir of level) {
      if (found.length >= maxEntries)
        return found;
      let entries;
      try {
        entries = await readdir5(path12.join(workspacePath, relativeDir), {
          withFileTypes: true
        });
      } catch {
        continue;
      }
      const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : 1);
      for (const entry of sorted) {
        if (found.length >= maxEntries)
          return found;
        const relative4 = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name))
            continue;
          if (depth < MAX_WALK_DEPTH)
            next.push(relative4);
          continue;
        }
        if (entry.isFile())
          found.push(toPosix(relative4));
      }
    }
    level = next;
  }
  return found;
}
function createFileLister(options) {
  const ttlMs = options.ttlMs ?? FILE_LIST_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? MAX_LISTED_FILES2;
  const listTracked = options.listTracked ?? gitListFiles;
  let cached;
  let inFlight;
  const load = async () => {
    const tracked = await listTracked(options.workspacePath);
    const paths = tracked === void 0 ? await walkFiles(options.workspacePath, maxEntries) : tracked.slice(0, maxEntries);
    cached = { paths, at: now() };
    return paths;
  };
  return {
    async list() {
      const fresh = cached;
      if (fresh !== void 0 && now() - fresh.at < ttlMs)
        return fresh.paths;
      if (inFlight !== void 0)
        return await inFlight;
      inFlight = load().catch(() => []);
      try {
        return await inFlight;
      } finally {
        inFlight = void 0;
      }
    },
    invalidate() {
      cached = void 0;
    }
  };
}
async function completeMention(files, token, limit = MENTION_LIMIT) {
  const paths = await files.list();
  const hits = rankMentionMatches(paths, token.slice(1), limit);
  return [hits.map((hit) => `@${hit}`), token];
}
var TRAILING_PUNCTUATION = /* @__PURE__ */ new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  '"',
  "'"
]);
var MENTION_PATTERN = /(?:^|[^\w@])@([^\s]+)/g;
function workspaceFileExists(workspacePath, relativePath) {
  const root = path12.resolve(workspacePath);
  const resolved = path12.resolve(root, relativePath);
  const inside = resolved === root || resolved.startsWith(root + path12.sep);
  if (!inside)
    return Promise.resolve(false);
  return stat7(resolved).then((stats) => stats.isFile(), () => false);
}
function mentionCandidates(text2) {
  const out = [];
  for (const match of text2.matchAll(MENTION_PATTERN)) {
    const raw = match[1];
    if (raw === void 0 || raw === "")
      continue;
    const forms = [raw];
    let trimmed = raw;
    while (trimmed.length > 1 && TRAILING_PUNCTUATION.has(trimmed.slice(-1))) {
      trimmed = trimmed.slice(0, -1);
      forms.push(trimmed);
    }
    out.push(forms);
  }
  return out;
}
async function resolveMentions(text2, exists) {
  const found = [];
  for (const forms of mentionCandidates(text2)) {
    for (const form of forms) {
      if (found.includes(form))
        break;
      if (await exists(form)) {
        found.push(form);
        break;
      }
    }
  }
  return found;
}
function mentionAnnotation(paths) {
  return `[mentioned files: ${paths.join(", ")}]`;
}
async function annotateMentions(text2, exists) {
  const paths = await resolveMentions(text2, exists);
  if (paths.length === 0)
    return text2;
  return `${text2}

${mentionAnnotation(paths)}`;
}

// apps/cli/dist/orchestrate.js
import { execFile as execFile10 } from "node:child_process";
import { resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { promisify as promisify7 } from "node:util";
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
var execFileAsync7 = promisify7(execFile10);
async function worktreeIsolationError(workspacePath) {
  try {
    await execFileAsync7("git", ["rev-parse", "HEAD"], { cwd: workspacePath });
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
  if (args.backend === "claude-code") {
    const availability = await ClaudeCodeBackend.checkAvailability();
    if (!availability.installed) {
      throw new Error(claudeCodeInstallGuidance(availability));
    }
    if (!availability.loggedIn) {
      throw new Error(claudeCodeLoginGuidance(availability));
    }
    const resolveAgentModel = createDelegatedModelResolver(args.project);
    const resolveAgentTools = createDelegatedToolsResolver(args.project);
    return (workspacePath) => new ClaudeCodeWorkerExecutor({
      workspacePath,
      runId,
      events: events2,
      resolveAgentModel,
      resolveAgentTools,
      ...taskTimeoutMs === void 0 ? {} : { taskTimeoutMs }
    });
  }
  if (args.backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    if (!availability.installed) {
      throw new Error(codexInstallGuidance(availability));
    }
    if (!availability.loggedIn) {
      throw new Error(codexLoginGuidance(availability));
    }
    const resolveAgentModel = createDelegatedModelResolver(args.project);
    return (workspacePath) => new CodexWorkerExecutor({
      workspacePath,
      runId,
      events: events2,
      resolveAgentModel,
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
function summaryRow(task, spent) {
  return [
    task.status,
    task.spec.id,
    task.assignedAgent ?? "-",
    String(task.attempts),
    spent === void 0 ? "-" : spent.models.join("+"),
    spent === void 0 ? "-" : `${formatTokenCount2(spent.usage.inputTokens)}/${formatTokenCount2(spent.usage.outputTokens)}`,
    spent === void 0 ? "-" : formatCostUsd(spent.costUsd, spent.pricing),
    task.spec.title
  ];
}
function runSummaryLines(tasks, usage) {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const byTask = usage.breakdownBy("task");
  return [
    "",
    ...formatTable(["STATUS", "ID", "AGENT", "TRIES", "MODEL", "TOKENS", "$", "TITLE"], tasks.map((task) => summaryRow(task, byTask.get(task.spec.id)))),
    "",
    `${completed}/${tasks.length} tasks completed`,
    ...usageRollupLines(usage.breakdownBy("model"), { countTasks: true }),
    usageLine(usage.totals())
  ];
}
function modelRollupJson(usage) {
  return [...usage.breakdownBy("model").values()].map((entry) => ({
    model: entry.key,
    tasks: entry.tasks.filter((id) => id !== UNATTRIBUTED).length,
    usage: entry.usage,
    // Never 0 for an unpriced model: 0 would read as "this was free".
    costUsd: entry.pricing === "unknown" ? null : entry.costUsd,
    pricing: entry.pricing
  }));
}
function renderRunSummary(runId, tasks, usage, output, json) {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const ok = completed === tasks.length;
  if (json) {
    const totals = usage.totals();
    const byTask = usage.breakdownBy("task");
    jsonLine2(output, {
      type: "run.summary",
      runId,
      ok,
      tasks: tasks.map((task) => {
        const spent = byTask.get(task.spec.id);
        return {
          id: task.spec.id,
          status: task.status,
          agent: task.assignedAgent,
          attempts: task.attempts,
          ...spent === void 0 ? {} : {
            models: spent.models,
            usage: spent.usage,
            costUsd: spent.pricing === "unknown" ? null : spent.costUsd
          },
          ...task.result === void 0 ? {} : { result: task.result }
        };
      }),
      models: modelRollupJson(usage),
      usage: totals.usage,
      costUsd: totals.costUsd
    });
    return ok ? 0 : 1;
  }
  for (const line of runSummaryLines(tasks, usage))
    output.log(line);
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
  const usage = request.usage ?? new UsageTracker();
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
  return renderRunSummary(runId, tasks, usage, output, options.json);
}
var PLANNER_AGENT = "planner";
function planningThrough(usage, inner) {
  const factory = inner ?? ((args) => new LlmPlanner(args));
  return (args) => factory({
    ...args,
    provider: usageRecordingProvider(args.provider, usage, {
      agent: PLANNER_AGENT
    })
  });
}
function delegatedPlanningThrough(usage, inner) {
  const factory = inner ?? ((args) => new DelegatedPlanner(args));
  return (args) => factory({
    ...args,
    usage: {
      recorder: usage,
      model: delegatedModelIdentity(args.backend, args.model),
      tags: { agent: PLANNER_AGENT }
    }
  });
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
  const usage = new UsageTracker();
  const prepared = await preparePlan(objective, options, {
    ...deps,
    plannerFactory: planningThrough(usage, deps.plannerFactory),
    delegatedPlannerFactory: delegatedPlanningThrough(usage, deps.delegatedPlannerFactory)
  });
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
      usage,
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

// apps/cli/dist/interactive.js
var CLI_VERSION = "0.7.0";
var SHORT_ID2 = 8;
var SESSIONS_LIMIT = 20;
function shortId2(id) {
  return id.slice(0, SHORT_ID2);
}
function toChatLike(session) {
  if ("toModelMessages" in session)
    return session;
  return {
    send: (instruction, context) => session.send(instruction, context),
    toModelMessages: () => session.messages(),
    ...session.compactNow === void 0 ? {} : {
      compactNow: (context) => (
        // biome-ignore lint/style/noNonNullAssertion: narrowed by the check above.
        session.compactNow(context)
      )
    }
  };
}
function resolveSessionReference(records, reference) {
  let note;
  const resolved = resolveChatSessionReference(records, reference, {
    onNote: (found) => {
      note = found;
    }
  });
  if ("error" in resolved)
    return { error: resolved.error };
  return note === void 0 ? { record: resolved.record } : { record: resolved.record, note };
}
function startFrom(transcript) {
  return {
    sessionId: transcript.record.id,
    title: transcript.record.title,
    persisted: true,
    messages: transcript.messages,
    ...transcript.record.name === void 0 ? {} : { name: transcript.record.name }
  };
}
async function resolveStartSession(store, workspacePath, selector, newId = () => crypto.randomUUID()) {
  const wantsResume = selector.continue === true || selector.session !== void 0;
  if (!wantsResume) {
    return {
      start: { sessionId: newId(), title: "", persisted: false, messages: [] }
    };
  }
  if (store === void 0) {
    return {
      error: "--continue and --session need the session database, which --no-save disables. Drop --no-save to resume a conversation."
    };
  }
  const records = await store.listChatSessions(workspacePath);
  if (selector.session !== void 0) {
    const matched = resolveSessionReference(records, selector.session);
    if ("error" in matched)
      return { error: matched.error };
    const transcript2 = await store.loadChatSession(matched.record.id);
    if (transcript2 === void 0) {
      return { error: `Chat session ${matched.record.id} could not be read.` };
    }
    return matched.note === void 0 ? { start: startFrom(transcript2) } : { start: startFrom(transcript2), note: matched.note };
  }
  const latest = records[0];
  if (latest === void 0) {
    return {
      error: `No chat sessions recorded for ${workspacePath} yet \u2014 run \`kapel\` without --continue to start one.`
    };
  }
  const transcript = await store.loadChatSession(latest.id);
  if (transcript === void 0) {
    return { error: `Chat session ${latest.id} could not be read.` };
  }
  return { start: startFrom(transcript) };
}
function sumTotals(...sources) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens;
  let costUsd = 0;
  for (const source of sources) {
    const totals = source.totals();
    inputTokens += totals.usage.inputTokens;
    outputTokens += totals.usage.outputTokens;
    if (totals.usage.cachedInputTokens !== void 0) {
      cachedInputTokens = (cachedInputTokens ?? 0) + totals.usage.cachedInputTokens;
    }
    costUsd += totals.costUsd;
  }
  return {
    usage: {
      inputTokens,
      outputTokens,
      ...cachedInputTokens === void 0 ? {} : { cachedInputTokens }
    },
    costUsd
  };
}
function usageTotalsLine(totals) {
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
function chatUsageBreakdown(native, delegated) {
  const out = new Map(native);
  for (const { label, totals } of delegated) {
    const { inputTokens, outputTokens } = totals.usage;
    if (inputTokens === 0 && outputTokens === 0 && totals.costUsd === 0) {
      continue;
    }
    out.set(label, {
      key: label,
      usage: totals.usage,
      costUsd: totals.costUsd,
      pricing: totals.costUsd > 0 ? "known" : "unknown",
      models: [label],
      agents: [UNATTRIBUTED],
      tasks: [UNATTRIBUTED],
      samples: 1
    });
  }
  return out;
}
function usageDeltaLine(before, after) {
  const input = after.usage.inputTokens - before.usage.inputTokens;
  const output = after.usage.outputTokens - before.usage.outputTokens;
  const cost = after.costUsd - before.costUsd;
  const line = `tokens +${input} in, +${output} out`;
  return cost > 0 ? `${line}  (~$${cost.toFixed(4)})` : line;
}
function modelAliases() {
  return Object.keys(defaultModelCatalog()).sort();
}
var SLASH_COMMANDS = [
  { name: "help", usage: "/help", help: "show this list" },
  { name: "exit", usage: "/exit", help: "leave the session (alias: /quit)" },
  { name: "new", usage: "/new", help: "start a fresh conversation here" },
  {
    name: "sessions",
    usage: "/sessions",
    help: "list this directory's conversations"
  },
  {
    name: "resume",
    usage: "/resume <id|name>",
    help: "switch to a stored conversation"
  },
  {
    name: "name",
    usage: "/name [name]",
    help: "show, or set, this conversation's name"
  },
  {
    name: "fork",
    usage: "/fork [name]",
    help: "branch this conversation into a new session"
  },
  {
    name: "model",
    usage: "/model [alias]",
    help: "show or switch the model for future turns",
    args: modelAliases()
  },
  {
    name: "config",
    usage: "/config",
    help: "re-run setup (backend and models) and apply it here"
  },
  { name: "usage", usage: "/usage", help: "tokens and cost so far" },
  {
    name: "compact",
    usage: "/compact",
    help: "compact the conversation history now"
  },
  {
    name: "undo",
    usage: "/undo",
    help: "restore the files to before the last prompt"
  },
  {
    name: "orchestrate",
    usage: "/orchestrate <objective>",
    help: "run the multi-agent pipeline on an objective"
  }
];
function slashCompleter(line, customNames = []) {
  if (!line.startsWith("/"))
    return [[], line];
  const space = line.indexOf(" ");
  if (space === -1) {
    const names = [
      ...SLASH_COMMANDS.map((command) => `/${command.name}`),
      ...customNames.map((name2) => `/${name2}`)
    ];
    const hits2 = names.filter((name2) => name2.startsWith(line));
    return [hits2.length > 0 ? hits2 : names, line];
  }
  const name = line.slice(1, space).toLowerCase();
  const values = SLASH_COMMANDS.find((command) => command.name === name)?.args;
  if (values === void 0 || values.length === 0)
    return [[], line];
  const argument = line.slice(space + 1);
  const partial = argument.slice(argument.lastIndexOf(" ") + 1);
  const hits = values.filter((value) => value.startsWith(partial));
  return [hits.length > 0 ? [...hits] : [...values], partial];
}
function createReplCompleter(files, customNames) {
  return (line) => {
    if (files !== void 0) {
      const token = mentionTokenAt(line);
      if (token !== void 0)
        return completeMention(files, token);
    }
    return slashCompleter(line, customNames?.() ?? []);
  };
}
function errorText2(error) {
  return error instanceof Error ? error.message : String(error);
}
function bannerModel(backend, modelAlias) {
  return isDelegatedBackend(backend) ? `${backend} \xB7 ${modelAlias}` : modelAlias;
}
function approvalsLine(backend) {
  const cli = backend === "codex" ? "Codex" : "Claude Code";
  return `approvals are enforced by the ${cli} CLI \u2014 kapel does not prompt here`;
}
function instructionsBannerLine(sources) {
  if (sources.length === 0)
    return void 0;
  return `instructions: ${sources.join(", ")}`;
}
function invalidSessionName(candidate) {
  if (candidate === "")
    return "a name cannot be empty.";
  if (candidate.startsWith("/")) {
    return 'a name cannot start with "/" \u2014 that would be ambiguous with slash commands.';
  }
  return void 0;
}
async function createInteractiveController(deps) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  const resolveModel = deps.resolveModel ?? ((alias) => resolveModelAndProvider(process.env, alias));
  const builtinCommandNames = new Set(SLASH_COMMANDS.map((command) => command.name));
  const loadCommands = deps.customCommands ?? (() => loadCustomCommands(deps.workspacePath, builtinCommandNames));
  let backend = deps.backend ?? "native";
  let modelAlias = deps.modelAlias;
  let model = deps.model;
  let provider = deps.provider;
  let sessionId = deps.start.sessionId;
  let title = deps.start.title;
  let sessionName = deps.start.name;
  let persisted = deps.start.persisted;
  let titleDirty = false;
  const factoryArgs = (messages, sessionRef) => ({
    sessionId,
    backend,
    modelAlias,
    messages,
    ...model === void 0 ? {} : { model },
    ...provider === void 0 ? {} : { provider },
    ...sessionRef === void 0 ? {} : { sessionRef }
  });
  let session = await deps.createSession(factoryArgs(deps.start.messages));
  let chat = toChatLike(session);
  const build = async (messages, sessionRef) => {
    session = await deps.createSession(factoryArgs(messages, sessionRef));
    chat = toChatLike(session);
  };
  let customCommands = [];
  let customCommandWarnings = [];
  const refreshCustomCommands = async () => {
    const result = await loadCommands();
    customCommands = result.commands;
    customCommandWarnings = result.warnings;
    deps.onCustomCommandsChanged?.(customCommands.map((command) => command.name));
  };
  const lines = [];
  const emit2 = (line) => {
    lines.push(line);
    deps.write(line);
  };
  const drain = (effect) => {
    const output = lines.slice();
    lines.length = 0;
    return effect === void 0 ? { output } : { output, effect };
  };
  const persist = async () => {
    const store = deps.store;
    if (store === void 0)
      return;
    const snapshot = chat.toModelMessages();
    if (snapshot.length === 0)
      return;
    try {
      if (!persisted) {
        await store.createChatSession({
          id: sessionId,
          workspacePath: deps.workspacePath,
          title,
          modelAlias,
          createdAt: now()
        });
        persisted = true;
        titleDirty = false;
      } else if (titleDirty) {
        await store.setChatSessionTitle(sessionId, title);
        titleDirty = false;
      }
      await store.appendChatMessages(sessionId, snapshot.map((message, seq) => ({ seq, message })));
    } catch (error) {
      emit2(`(not saved: ${errorText2(error)})`);
    }
  };
  const rebuildSession = async (keepSessionRef) => {
    const sessionRef = keepSessionRef ? chat.sessionRef?.() : void 0;
    await build(chat.toModelMessages(), sessionRef);
  };
  const fileExists = deps.fileExists ?? ((relativePath) => workspaceFileExists(deps.workspacePath, relativePath));
  const handleMessage = async (text2, signal) => {
    const checkpointWarning = await deps.checkpoints?.capture(text2);
    if (checkpointWarning !== void 0)
      emit2(checkpointWarning);
    if (title === "") {
      title = chatTitleFrom(text2);
      titleDirty = true;
    }
    const instruction = await annotateMentions(text2, fileExists);
    const before = deps.usage.totals();
    let result;
    try {
      result = await chat.send(instruction, {
        runId: sessionId,
        workspacePath: deps.workspacePath,
        ...signal === void 0 ? {} : { signal }
      });
    } catch (error) {
      emit2(`error: ${errorText2(error)}`);
    }
    await persist();
    if (result !== void 0 && result.status !== "success") {
      emit2(`(${result.status}) ${result.summary}`);
    }
    emit2(usageDeltaLine(before, deps.usage.totals()));
    return drain();
  };
  const listRecords = async () => {
    const store = deps.store;
    if (store === void 0)
      return [];
    return await store.listChatSessions(deps.workspacePath, {
      limit: SESSIONS_LIMIT
    });
  };
  const slashHelp = async () => {
    await refreshCustomCommands();
    emit2("commands:");
    const width = Math.max(...SLASH_COMMANDS.map((command) => command.usage.length));
    for (const command of SLASH_COMMANDS) {
      emit2(`  ${command.usage.padEnd(width)}  ${command.help}`);
    }
    emit2("anything else is sent to the agent.");
    if (customCommands.length > 0) {
      emit2("");
      emit2("custom commands (.agent/commands/):");
      const customWidth = Math.max(...customCommands.map((command) => command.name.length + 1));
      for (const command of customCommands) {
        const usage = `/${command.name}`.padEnd(customWidth);
        emit2(`  ${usage}  ${command.description ?? "(no description)"}`);
      }
    }
    for (const warning of customCommandWarnings) {
      emit2(`warning: ${warning}`);
    }
    return drain();
  };
  const slashNew = async () => {
    await persist();
    sessionId = newId();
    title = "";
    persisted = false;
    titleDirty = false;
    await build([]);
    emit2(`started a new session ${shortId2(sessionId)}`);
    return drain("new-session");
  };
  const slashSessions = async () => {
    if (deps.store === void 0) {
      emit2("sessions are not being recorded (--no-save).");
      return drain();
    }
    const records = await listRecords();
    if (records.length === 0) {
      emit2(`No chat sessions recorded for ${deps.workspacePath} yet.`);
      return drain();
    }
    const showName = records.some((record) => record.name !== void 0);
    const rows = records.map((record) => {
      const row = [record.id === sessionId ? "*" : "", shortId2(record.id)];
      if (showName)
        row.push(record.name ?? "");
      row.push(isoTime(record.updatedAt), String(record.messageCount), record.title === "" ? "(untitled)" : record.title);
      return row;
    });
    const headers = showName ? ["", "ID", "NAME", "UPDATED", "MSGS", "TITLE"] : ["", "ID", "UPDATED", "MSGS", "TITLE"];
    for (const line of formatTable(headers, rows)) {
      emit2(line);
    }
    return drain();
  };
  const slashResume = async (argument) => {
    if (deps.store === void 0) {
      emit2("sessions are not being recorded (--no-save), so there is none to resume.");
      return drain();
    }
    if (argument === "") {
      emit2("usage: /resume <id|name>  \u2014 see /sessions");
      return drain();
    }
    const records = await listRecords();
    const matched = resolveChatSessionReference(records, argument, {
      onNote: (note) => emit2(note)
    });
    if ("error" in matched) {
      emit2(matched.error);
      return drain();
    }
    if (matched.record.id === sessionId) {
      emit2(`already on ${shortId2(sessionId)}`);
      return drain();
    }
    const transcript = await deps.store.loadChatSession(matched.record.id);
    if (transcript === void 0) {
      emit2(`Chat session ${matched.record.id} could not be read.`);
      return drain();
    }
    await persist();
    sessionId = transcript.record.id;
    title = transcript.record.title;
    sessionName = transcript.record.name;
    persisted = true;
    titleDirty = false;
    await build(transcript.messages);
    emit2(`resumed ${title === "" ? shortId2(sessionId) : title} (${transcript.messages.length} messages)`);
    return drain("resumed");
  };
  const slashName = async (argument) => {
    if (argument === "") {
      emit2(sessionName === void 0 ? "(unnamed)" : sessionName);
      return drain();
    }
    const problem = invalidSessionName(argument);
    if (problem !== void 0) {
      emit2(problem);
      return drain();
    }
    sessionName = argument;
    if (deps.store === void 0) {
      emit2(`named "${sessionName}" for this run (not persisted \u2014 sessions are not being recorded, --no-save).`);
      return drain();
    }
    try {
      if (!persisted) {
        await deps.store.createChatSession({
          id: sessionId,
          workspacePath: deps.workspacePath,
          title,
          name: sessionName,
          modelAlias,
          createdAt: now()
        });
        persisted = true;
        titleDirty = false;
      } else {
        await deps.store.renameChatSession(sessionId, sessionName);
      }
    } catch (error) {
      emit2(`(not saved: ${errorText2(error)})`);
      return drain();
    }
    emit2(`named "${sessionName}"`);
    return drain("renamed");
  };
  const slashFork = async (argument) => {
    if (deps.store === void 0) {
      emit2("sessions are not being recorded (--no-save), so there is nothing to fork.");
      return drain();
    }
    if (argument !== "") {
      const problem = invalidSessionName(argument);
      if (problem !== void 0) {
        emit2(problem);
        return drain();
      }
    }
    await persist();
    if (!persisted) {
      emit2("nothing to fork yet \u2014 say something first.");
      return drain();
    }
    const forkName = argument === "" ? void 0 : argument;
    let newSessionId;
    try {
      newSessionId = await deps.store.forkChatSession(sessionId, forkName === void 0 ? {} : { name: forkName });
    } catch (error) {
      emit2(`could not fork: ${errorText2(error)}`);
      return drain();
    }
    const messages = chat.toModelMessages();
    sessionId = newSessionId;
    sessionName = forkName;
    persisted = true;
    titleDirty = false;
    await build(messages);
    emit2(`forked to ${shortId2(sessionId)}${forkName === void 0 ? "" : ` (${forkName})`} \u2014 now on the new session.`);
    return drain("forked");
  };
  const modelLine = () => {
    if (provider === void 0 || model === void 0) {
      return `model: ${modelAlias} (${backend})`;
    }
    return `model: ${modelAlias} (${provider.id}/${model.id})`;
  };
  const slashModel = async (argument) => {
    if (argument === "") {
      emit2(modelLine());
      return drain();
    }
    if (backend === "native") {
      const resolved = await resolveModel(argument);
      if ("error" in resolved) {
        emit2(resolved.error);
        return drain();
      }
      model = resolved.model;
      provider = resolved.provider;
    }
    modelAlias = argument;
    await rebuildSession(true);
    emit2(`model switched to ${modelAlias} \u2014 future turns use it.`);
    return drain("model-changed");
  };
  const slashConfig = async () => {
    if (deps.configure === void 0) {
      emit2("/config needs a terminal \u2014 run `kapel config` from one.");
      return drain();
    }
    const config = await deps.configure();
    if (config === void 0)
      return drain();
    const nextBackend = config.backend;
    const nextAlias = config.models.orchestrator;
    if (nextBackend === backend && nextAlias === modelAlias) {
      emit2("config unchanged.");
      return drain();
    }
    if (nextBackend === "native") {
      const resolved = await resolveModel(nextAlias);
      if ("error" in resolved) {
        emit2(resolved.error);
        emit2("keeping the current backend for this conversation.");
        return drain();
      }
      model = resolved.model;
      provider = resolved.provider;
    } else {
      model = void 0;
      provider = void 0;
    }
    const changes = [];
    if (nextBackend !== backend)
      changes.push(`backend ${backend} \u2192 ${nextBackend}`);
    if (nextAlias !== modelAlias)
      changes.push(`model ${modelAlias} \u2192 ${nextAlias}`);
    const backendChanged = nextBackend !== backend;
    backend = nextBackend;
    modelAlias = nextAlias;
    await rebuildSession(!backendChanged);
    emit2(`${changes.join(", ")} \u2014 future turns use it.`);
    return drain("config-changed");
  };
  const slashCompact = async () => {
    if (chat.compactNow === void 0) {
      const cli = backend === "codex" ? "Codex" : "Claude Code";
      emit2(`/compact is not supported with the ${cli} backend.`);
      return drain();
    }
    const result = await chat.compactNow({
      runId: sessionId,
      workspacePath: deps.workspacePath
    });
    emit2(result.elided === 0 ? "nothing to compact." : `compacted: elided ${result.elided} tool result${result.elided === 1 ? "" : "s"}, saved ~${result.savedChars} chars`);
    return drain();
  };
  const slashUndo = async () => {
    if (deps.checkpoints === void 0) {
      emit2("/undo is not available here.");
      return drain();
    }
    for (const line of undoLines(await deps.checkpoints.undo()))
      emit2(line);
    return drain();
  };
  const slashOrchestrate = async (objective) => {
    if (deps.orchestrate === void 0) {
      emit2("/orchestrate is not available here.");
      return drain();
    }
    if (objective === "") {
      emit2('usage: /orchestrate "<objective>"');
      return drain();
    }
    try {
      const code = await deps.orchestrate(objective);
      if (code !== 0)
        emit2(`orchestrate exited ${code}`);
    } catch (error) {
      emit2(errorText2(error));
    }
    return drain();
  };
  const dispatchCustomCommand = async (command, argument, signal) => {
    const instruction = expandCustomCommand(command, argument);
    if (command.model === void 0) {
      return await handleMessage(instruction, signal);
    }
    if (backend !== "native") {
      emit2(`note: /${command.name} asks for model "${command.model}", but the ${backend} backend has no per-command model to switch \u2014 running on the session's current model.`);
      return await handleMessage(instruction, signal);
    }
    const resolved = await resolveModel(command.model);
    if ("error" in resolved) {
      emit2(`note: /${command.name} asks for model "${command.model}": ${resolved.error} \u2014 running on the session's current model.`);
      return await handleMessage(instruction, signal);
    }
    const savedAlias = modelAlias;
    const savedModel = model;
    const savedProvider = provider;
    modelAlias = command.model;
    model = resolved.model;
    provider = resolved.provider;
    await rebuildSession(true);
    try {
      return await handleMessage(instruction, signal);
    } finally {
      modelAlias = savedAlias;
      model = savedModel;
      provider = savedProvider;
      await rebuildSession(true);
    }
  };
  const handleSlash = async (line, signal) => {
    const space = line.indexOf(" ");
    const name = (space === -1 ? line : line.slice(0, space)).slice(1).toLowerCase();
    const argument = space === -1 ? "" : line.slice(space + 1).trim();
    switch (name) {
      case "help":
      case "?":
        return await slashHelp();
      case "exit":
      case "quit":
        return drain("exit");
      case "new":
        return await slashNew();
      case "sessions":
        return await slashSessions();
      case "resume":
        return await slashResume(argument);
      case "name":
        return await slashName(argument);
      case "fork":
        return await slashFork(argument);
      case "model":
        return await slashModel(argument);
      case "config":
        return await slashConfig();
      case "usage":
        emit2(usageTotalsLine(deps.usage.totals()));
        for (const line2 of usageRollupLines(deps.usage.breakdownBy?.("model") ?? /* @__PURE__ */ new Map())) {
          emit2(`  ${line2}`);
        }
        return drain();
      case "compact":
        return await slashCompact();
      case "undo":
        return await slashUndo();
      case "orchestrate":
        return await slashOrchestrate(argument);
      default: {
        const custom = customCommands.find((c) => c.name === name);
        if (custom !== void 0) {
          return await dispatchCustomCommand(custom, argument, signal);
        }
        emit2(`Unknown command "/${name}". Type /help for the list.`);
        return drain();
      }
    }
  };
  await refreshCustomCommands();
  return {
    sessionId: () => sessionId,
    title: () => title,
    name: () => sessionName,
    modelAlias: () => modelAlias,
    backend: () => backend,
    session: () => session,
    banner: (cwd) => [
      `kapel v${CLI_VERSION}  ${bannerModel(backend, modelAlias)}  session ${shortId2(sessionId)}`,
      cwd,
      ...isDelegatedBackend(backend) ? [approvalsLine(backend)] : [],
      "type /help for commands, /exit to quit",
      "\\ + Enter for multiline input, \u2191/\u2193 to recall, tab-complete /commands and @files",
      ""
    ],
    handleLine: async (line, signal) => {
      const trimmed = line.trim();
      if (trimmed === "")
        return { output: [] };
      if (trimmed.startsWith("/"))
        return await handleSlash(trimmed, signal);
      return await handleMessage(trimmed, signal);
    }
  };
}
async function openChatStore(workspacePath) {
  const agentDir = path13.join(workspacePath, ".agent");
  try {
    await mkdir6(agentDir, { recursive: true });
    return new SqliteSessionStore({ path: defaultSessionDbPath(agentDir) });
  } catch {
    return void 0;
  }
}
var SIGINT_LINE = /* @__PURE__ */ Symbol("sigint");
function inputManagerLineSource(manager) {
  return {
    next: async (promptText) => {
      const result = await manager.readMessage(promptText);
      return result === INPUT_SIGINT ? SIGINT_LINE : result;
    },
    close: () => manager.close()
  };
}
function pipedLineSource() {
  const rl = readline4.createInterface({
    input: process.stdin,
    terminal: false
  });
  const queued = [];
  let waiting;
  let ended = false;
  const deliver = (line) => {
    const waiter = waiting;
    if (waiter === void 0)
      return false;
    waiting = void 0;
    waiter(line);
    return true;
  };
  rl.on("line", (line) => {
    if (!deliver(line))
      queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    deliver(void 0);
  });
  return {
    next: (promptText) => {
      process.stdout.write(promptText);
      const next = queued.shift();
      if (next !== void 0)
        return Promise.resolve(next);
      if (ended)
        return Promise.resolve(void 0);
      return new Promise((resolve5) => {
        waiting = resolve5;
      });
    },
    close: () => rl.close()
  };
}
function dim2(text2, color) {
  return color ? `\x1B[2m${text2}\x1B[0m` : text2;
}
async function startDelegatedOrNative(backend, alias) {
  if (backend === "claude-code") {
    const availability = await ClaudeCodeBackend.checkAvailability();
    if (!availability.installed) {
      return { error: claudeCodeInstallGuidance(availability) };
    }
    if (!availability.loggedIn) {
      return { error: claudeCodeLoginGuidance(availability) };
    }
    return {};
  }
  if (backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    if (!availability.installed) {
      return { error: codexInstallGuidance(availability) };
    }
    if (!availability.loggedIn) {
      return { error: codexLoginGuidance(availability) };
    }
    return {};
  }
  return await resolveModelAndProvider(process.env, alias);
}
async function runInteractive(options) {
  if (options.json) {
    console.error('--json is not supported in interactive mode: there is no stream to script against until you say something. Use the one-shot form instead: kapel --json "<objective>".');
    return 1;
  }
  const workspacePath = path13.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const instructions = loadInstructions(workspacePath, process.env);
  const repoPermission = await loadRepoPermissionRules(workspacePath);
  const permissionRules = resolvePermissionRules(DEFAULT_PERMISSIONS, options.config?.permission, repoPermission);
  const backend = resolveBackendSetting(options.backend, process.env, options.config).value;
  const modelSetting = resolveOrchestratorModel(options.model, process.env, options.config);
  const alias = modelSetting.value;
  const delegatedModel2 = delegatedModelOverride(modelSetting);
  const chatAlias = isDelegatedBackend(backend) ? delegatedModel2 ?? "default" : alias;
  const startup = await startDelegatedOrNative(backend, alias);
  if ("error" in startup) {
    console.error(startup.error);
    return 1;
  }
  const store = options.save === false ? void 0 : await openChatStore(workspacePath);
  try {
    const started = await resolveStartSession(store, workspacePath, {
      ...options.continue === void 0 ? {} : { continue: options.continue },
      ...options.session === void 0 ? {} : { session: options.session }
    });
    if ("error" in started) {
      console.error(started.error);
      return 1;
    }
    const interactiveTty = process.stdin.isTTY === true;
    const promptState = createPromptState();
    const sessionAllowlist = new SessionAllowlist();
    const nativeUsage = new UsageTracker();
    const delegatedUsage = /* @__PURE__ */ new Map();
    const delegatedUsageFor = (target) => {
      const existing = delegatedUsage.get(target);
      if (existing !== void 0)
        return existing;
      const created = new DelegatedUsage();
      delegatedUsage.set(target, created);
      return created;
    };
    const usage = {
      totals: () => sumTotals(nativeUsage, ...delegatedUsage.values()),
      breakdownBy: (dimension) => chatUsageBreakdown(nativeUsage.breakdownBy(dimension), [...delegatedUsage].map(([label, ledger]) => ({
        label,
        totals: ledger.totals()
      })))
    };
    const renderer = new TextRenderer(process.stdout, {
      tokens: () => {
        const totals = usage.totals().usage;
        return totals.inputTokens + totals.outputTokens;
      },
      // A permission question owns the screen while it waits for an answer.
      suspended: () => promptState.active
    });
    const activeTurn = {
      current: void 0
    };
    const mentionFiles = createFileLister({ workspacePath });
    const customCommandNames = { current: [] };
    const inputManager = interactiveTty ? createInputManager({
      input: process.stdin,
      output: process.stdout,
      history: await loadHistory(),
      onHistoryAppend: createHistoryAppender(),
      completer: createReplCompleter(mentionFiles, () => customCommandNames.current),
      onIdleSigint: () => activeTurn.current?.abort()
    }) : void 0;
    const prompter = createPrompter({
      yes: options.yes,
      interactive: interactiveTty,
      state: promptState,
      allowlist: sessionAllowlist,
      ...inputManager === void 0 ? {} : { ask: (query) => inputManager.question(query) }
    });
    const delegatedModelFor = (aliasForBuild) => aliasForBuild === chatAlias ? delegatedModel2 : delegatedModelOverride({ value: aliasForBuild, source: "flag" });
    const delegatedSession = (target, args) => {
      const forwardedModel = delegatedModelFor(args.modelAlias);
      const chat = createDelegatedChatSession({
        backend: target,
        workspacePath,
        runId: args.sessionId,
        messages: args.messages,
        events: renderer,
        ...forwardedModel === void 0 ? {} : { model: forwardedModel },
        ...args.sessionRef === void 0 ? {} : { sessionRef: args.sessionRef },
        ...options.timeoutSeconds === void 0 ? {} : { timeoutMs: options.timeoutSeconds * 1e3 }
      });
      return {
        send: async (instruction, context) => {
          const result = await chat.send(instruction, {
            ...context.signal === void 0 ? {} : { signal: context.signal }
          });
          delegatedUsageFor(target).add(result);
          return result;
        },
        toModelMessages: () => chat.toModelMessages(),
        sessionRef: () => chat.sessionRef()
      };
    };
    const nativeSession = (args) => {
      if (args.model === void 0 || args.provider === void 0) {
        throw new Error("the native backend needs a resolved model and provider.");
      }
      const agent = {
        name: "agent",
        role: "worker",
        model: args.model,
        systemPrompt: options.system ?? composeSystemPrompt(defaultSystemPrompt(workspacePath), instructions),
        tools: builtinTools().map((tool) => tool.name),
        permissions: DEFAULT_PERMISSIONS
      };
      return AgentChatSession.restore(agentLoopOptions({
        agent,
        provider: args.provider,
        permissions: new PermissionEngine(permissionRules, {
          defaultDecision: "ask",
          overlay: sessionAllowlist,
          ...prompter === void 0 ? {} : { prompter }
        }),
        usage: nativeUsage,
        events: renderer,
        maxIterations: options.maxIterations,
        ...options.timeoutSeconds === void 0 ? {} : { timeoutMs: options.timeoutSeconds * 1e3 }
      }), args.messages);
    };
    const createSession = (args) => args.backend === "native" ? nativeSession(args) : delegatedSession(args.backend, args);
    const wizardTty = interactiveTty && process.stdout.isTTY === true && !options.json;
    const controller = await createInteractiveController({
      workspacePath,
      ...store === void 0 ? {} : { store },
      createSession,
      // Through the renderer rather than straight to the console: the REPL's
      // own lines land while a turn's status line may still be on screen, and
      // only the renderer knows how to take the cursor back from it.
      write: (line) => {
        renderer.line(line);
      },
      backend,
      modelAlias: chatAlias,
      ...startup.model === void 0 ? {} : { model: startup.model },
      ...startup.provider === void 0 ? {} : { provider: startup.provider },
      start: started.start,
      usage,
      // One store for the whole REPL: the checkpoints outlive `/new`,
      // `/resume` and `/model`, because the working tree does too.
      checkpoints: createCheckpointStore({ workspacePath }),
      onCustomCommandsChanged: (names) => {
        customCommandNames.current = names;
      },
      orchestrate: (objective) => runOrchestrate(objective, orchestrateOptionsFor(options, alias)),
      ...wizardTty ? {
        configure: () => runConfigWizard({
          // `/config` runs while the REPL's own InputManager still owns
          // stdin — suspend it around the picker so the two don't fight
          // over raw-mode keypresses.
          prompt: ttyWizardPrompt(void 0, inputManager === void 0 ? void 0 : (fn) => inputManager.withSuspended(fn)),
          write: (line) => {
            console.log(line);
          },
          checkBackend: (target) => checkBackendAvailability(target),
          ...options.config === void 0 ? {} : { current: options.config }
        })
      } : {}
    });
    const color = process.stdout.isTTY === true;
    for (const line of controller.banner(workspacePath))
      console.log(line);
    const instructionsLine = instructionsBannerLine(instructions.sources);
    if (instructionsLine !== void 0)
      console.log(dim2(instructionsLine, color));
    if (started.start.persisted) {
      const label = started.start.title === "" ? shortId2(started.start.sessionId) : started.start.title;
      console.log(dim2(`resumed ${label} (${started.start.messages.length} messages)`, color));
    }
    if ("note" in started && started.note !== void 0) {
      console.log(dim2(started.note, color));
    }
    const lineSource = inputManager === void 0 ? pipedLineSource() : inputManagerLineSource(inputManager);
    try {
      return await replLoop({
        controller,
        lines: lineSource,
        promptState,
        promptText: dim2("kapel> ", color),
        color,
        activeTurn
      });
    } finally {
      lineSource.close();
    }
  } finally {
    if (store !== void 0) {
      try {
        store.close();
      } catch {
      }
    }
  }
}
async function replLoop(args) {
  const { controller, lines, promptState, promptText, color, activeTurn } = args;
  let armed = false;
  for (; ; ) {
    const line = await lines.next(promptText);
    if (line === void 0) {
      console.log("");
      return 0;
    }
    if (line === SIGINT_LINE) {
      if (armed) {
        console.log("");
        return 0;
      }
      armed = true;
      console.log(dim2("(/exit to quit, Ctrl-C again to force)", color));
      continue;
    }
    armed = false;
    const turn = new AbortController();
    if (activeTurn !== void 0)
      activeTurn.current = turn;
    const onSigint = () => {
      if (promptState.active)
        return;
      turn.abort();
    };
    process.on("SIGINT", onSigint);
    let result;
    try {
      result = await controller.handleLine(line, turn.signal);
    } finally {
      process.off("SIGINT", onSigint);
      if (activeTurn !== void 0)
        activeTurn.current = void 0;
    }
    if (result.effect === "exit")
      return 0;
  }
}
function orchestrateOptionsFor(options, alias) {
  return {
    cwd: options.cwd,
    json: false,
    model: alias,
    dryRun: false,
    workerMode: DEFAULT_WORKER_MODE,
    backend: "native",
    isolation: DEFAULT_ISOLATION,
    validate: true,
    save: options.save !== false,
    tui: false,
    maxIterations: options.maxIterations,
    ...options.timeoutSeconds === void 0 ? {} : { timeoutSeconds: options.timeoutSeconds }
  };
}

// apps/cli/dist/policy.js
import { readFile as readFile14, writeFile as writeFile6 } from "node:fs/promises";
import path14 from "node:path";
var consoleOutput2 = {
  log: (line) => console.log(line),
  error: (line) => console.error(line)
};
var LOCK_FILE_NAME2 = "orchestration.lock.json";
var defaultCompilerFactory = (args) => new LlmPolicyCompiler(args);
var defaultDelegatedCompilerFactory = (args) => new DelegatedPolicyCompiler(args);
function jsonLine3(output, value) {
  output.log(JSON.stringify(value));
}
async function readOptionalFile2(filePath) {
  try {
    return await readFile14(filePath, "utf8");
  } catch {
    return void 0;
  }
}
function printLocatedList(output, label, located) {
  if (located.length === 0)
    return;
  output.log(`${label}:`);
  for (const item of located) {
    const suffix = item.location === void 0 ? "" : ` [${formatSourceLocation(item.location)}]`;
    output.log(`  - ${item.message}${suffix}`);
  }
}
function jsonLocations(messages, markdown) {
  return locateIssues(messages, markdown).map((issue) => issue.location ?? null);
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
var POLICY_AGENT = "policy";
async function buildPolicyCompiler(options, deps, context) {
  const { workspacePath, project, output } = context;
  const usage = new UsageTracker();
  const knownAgents = [...project.knownAgentNames()];
  const fail2 = (error) => {
    if (options.json)
      jsonLine3(output, { ok: false, error });
    else
      output.error(error);
    return { exitCode: 1 };
  };
  if (isDelegatedBackend(options.backend)) {
    const backend = options.backend;
    const modelId = delegatedModelOverride(resolveOrchestratorModel(options.model, process.env, options.config));
    const factory = deps.delegatedCompilerFactory;
    if (factory === void 0) {
      const unavailable = await delegatedBackendError(backend);
      if (unavailable !== void 0)
        return fail2(unavailable);
    }
    const model = delegatedModelIdentity(backend, modelId);
    const compiler2 = (factory ?? defaultDelegatedCompilerFactory)({
      backend,
      workspacePath,
      knownAgents,
      ...modelId === void 0 ? {} : { model: modelId },
      usage: { recorder: usage, model, tags: { agent: POLICY_AGENT } }
    });
    return { compiler: compiler2, model, usage, delegatedTo: backend };
  }
  const alias = resolveOrchestratorModel(options.model, process.env, options.config).value;
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved)
    return fail2(resolved.error);
  const compilerFactory = deps.compilerFactory ?? defaultCompilerFactory;
  const compiler = compilerFactory({
    provider: usageRecordingProvider(resolved.provider, usage, {
      agent: POLICY_AGENT
    }),
    model: resolved.model,
    knownAgents
  });
  return { compiler, model: resolved.model, usage };
}
async function runPolicyCompile(options, deps = {}) {
  const output = deps.output ?? consoleOutput2;
  const workspacePath = path14.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const loaded = await loadProjectForPolicy(workspacePath, output, options.json);
  if ("exitCode" in loaded)
    return loaded.exitCode;
  const { project, markdown } = loaded;
  const built = await buildPolicyCompiler(options, deps, {
    workspacePath,
    project,
    output
  });
  if ("exitCode" in built)
    return built.exitCode;
  const { compiler, model, usage, delegatedTo } = built;
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
  const lockPath = path14.join(project.root, LOCK_FILE_NAME2);
  await writeFile6(lockPath, serialized, "utf8");
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
      ambiguities,
      // Best-effort `.agent/orchestration.md` locations for each warning/
      // ambiguity above, one entry per index (`null` when unresolved). See
      // `locateIssues` in `@agent/policy`.
      warningLocations: jsonLocations(warnings, markdown),
      ambiguityLocations: jsonLocations(ambiguities, markdown)
    });
    return 0;
  }
  output.log(`Compiled policy using ${model.id} (${model.provider})`);
  output.log(`Lock written to ${lockPath}`);
  output.log(`Routing rules: ${result.policy.routing.length}, review rules: ${result.policy.review.length}, escalation rules: ${result.policy.escalation.length}`);
  output.log(policyUsageLine(usage.totals(), delegatedTo));
  printLocatedList(output, "Warnings", locateIssues(warnings, markdown));
  printLocatedList(output, "Ambiguities", locateIssues(ambiguities, markdown));
  return 0;
}
function policyUsageLine(totals, delegatedTo) {
  const nothingReported = totals.usage.inputTokens === 0 && totals.usage.outputTokens === 0;
  if (nothingReported && delegatedTo !== void 0) {
    return `tokens \u2014 none reported by the ${delegatedTo} CLI`;
  }
  const line = `tokens \u2014 input: ${totals.usage.inputTokens}, output: ${totals.usage.outputTokens}`;
  return totals.costUsd > 0 ? `${line}  (~$${totals.costUsd.toFixed(4)})` : line;
}
async function runPolicyCheck(options, deps = {}) {
  const output = deps.output ?? consoleOutput2;
  const workspacePath = path14.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const loaded = await loadProjectForPolicy(workspacePath, output, options.json);
  if ("exitCode" in loaded)
    return loaded.exitCode;
  const { project, markdown } = loaded;
  const lockPath = path14.join(project.root, LOCK_FILE_NAME2);
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
  const workspacePath = path14.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const loaded = await loadProjectForPolicy(workspacePath, output, options.json);
  if ("exitCode" in loaded)
    return loaded.exitCode;
  const { project, markdown } = loaded;
  const lockPath = path14.join(project.root, LOCK_FILE_NAME2);
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
      // Located against the *current* orchestration.md — when the lock is
      // stale (`fresh: false` above) these are still best-effort against
      // text that may have moved since the lock was compiled.
      warningLocations: jsonLocations(lock.warnings, markdown),
      ambiguityLocations: jsonLocations(lock.ambiguities, markdown),
      fresh: status.fresh
    });
    return 0;
  }
  output.log(description);
  printLocatedList(output, "Warnings", locateIssues(lock.warnings, markdown));
  printLocatedList(output, "Ambiguities", locateIssues(lock.ambiguities, markdown));
  return 0;
}
async function runPolicyDiff(options, deps = {}) {
  const output = deps.output ?? consoleOutput2;
  const workspacePath = path14.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const loaded = await loadProjectForPolicy(workspacePath, output, options.json);
  if ("exitCode" in loaded)
    return loaded.exitCode;
  const { project, markdown } = loaded;
  const lockPath = path14.join(project.root, LOCK_FILE_NAME2);
  const lockContent = await readOptionalFile2(lockPath);
  if (lockContent === void 0 || lockContent.trim() === "") {
    const message = `No policy lock found at ${lockPath}. Run \`kapel policy compile\` first \u2014 there is nothing to diff against.`;
    if (options.json)
      jsonLine3(output, { ok: false, error: message });
    else
      output.error(message);
    return 1;
  }
  let existingLock;
  try {
    existingLock = parseLockfile(lockContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json)
      jsonLine3(output, { ok: false, error: message });
    else
      output.error(message);
    return 1;
  }
  const built = await buildPolicyCompiler(options, deps, {
    workspacePath,
    project,
    output
  });
  if ("exitCode" in built)
    return built.exitCode;
  const { compiler, usage, delegatedTo } = built;
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
  const diff = diffPolicies(existingLock.policy, result.policy);
  if (options.json) {
    jsonLine3(output, {
      ok: true,
      unchanged: diff.unchanged,
      defaults: diff.defaults,
      routing: diff.routing,
      review: diff.review,
      escalation: diff.escalation,
      warnings: result.warnings,
      ambiguities: result.ambiguities
    });
    return 0;
  }
  output.log(diff.unchanged ? "No changes from the locked policy." : "Policy diff (locked -> recompiled):");
  if (!diff.unchanged) {
    output.log("");
    for (const line of formatPolicyDiff(diff))
      output.log(line);
  }
  output.log(policyUsageLine(usage.totals(), delegatedTo));
  printLocatedList(output, "Warnings", locateIssues(result.warnings, markdown));
  printLocatedList(output, "Ambiguities", locateIssues(result.ambiguities, markdown));
  output.log("");
  output.log("Run `kapel policy compile` to update the lock.");
  return 0;
}

// apps/cli/dist/resume-cmd.js
import { readFile as readFile15 } from "node:fs/promises";
import path15 from "node:path";
var LOCK_FILE_NAME3 = "orchestration.lock.json";
async function readOptionalFile3(filePath) {
  try {
    return await readFile15(filePath, "utf8");
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
  const raw = await readOptionalFile3(path15.join(project.root, LOCK_FILE_NAME3));
  const status = checkLock(markdown, raw);
  const tail4 = "Resuming under the policy snapshot recorded with the run \u2014 start a new `kapel orchestrate` to plan under the current one.";
  if (!status.fresh) {
    return `Warning: this project's policy lock is ${status.reason} (\`kapel policy compile\` would refresh it). ${tail4}`;
  }
  if (stableJson(status.lock.policy) !== stableJson(snapshot)) {
    return `Warning: this project's policy has changed since run started. ${tail4}`;
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
  const workspacePath = path15.resolve(options.cwd);
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

// apps/cli/dist/run-claude-code.js
import path16 from "node:path";
async function runClaudeCodeObjective(objective, options) {
  const workspacePath = path16.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const availability = await ClaudeCodeBackend.checkAvailability();
  if (!availability.installed) {
    console.error(claudeCodeInstallGuidance(availability));
    return 1;
  }
  if (!availability.loggedIn) {
    console.error(claudeCodeLoginGuidance(availability));
    return 1;
  }
  const renderer = options.json ? new JsonRenderer() : new TextRenderer();
  const backend = new ClaudeCodeBackend({
    ...options.model === void 0 ? {} : { model: options.model },
    events: renderer,
    ...options.timeoutSeconds === void 0 ? {} : { timeoutMs: options.timeoutSeconds * 1e3 }
  });
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    const result = await backend.run({
      instruction: objective,
      ...options.images !== void 0 && options.images.length > 0 ? { images: options.images } : {}
    }, {
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

// apps/cli/dist/run-codex.js
import path17 from "node:path";
async function runCodexObjective(objective, options) {
  const workspacePath = path17.resolve(options.cwd);
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
    const result = await backend.run({
      instruction: objective,
      ...options.images !== void 0 && options.images.length > 0 ? { images: options.images } : {}
    }, {
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
        spec: toPlannedTask3(request.task),
        status: "running",
        attempts: 1
      };
      error(`worker: ${task.spec.id} as ${request.agent}`);
      return await executor.execute(task, request.agent, void 0, toWorkerExecutionContext(request));
    } catch (failure2) {
      error(`worker: ${failure2 instanceof Error ? failure2.message : String(failure2)}`);
      throw failure2;
    }
  });
}

// apps/cli/dist/index.js
async function runtimeConfig(raw) {
  return await ensureFirstRunConfig({
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true && !raw.json,
    noSetup: raw.setup === false
  });
}
function parsePositive(raw, flag, integer2) {
  const value = integer2 ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${flag} value "${raw}": expected a positive ${integer2 ? "integer" : "number"}.`);
  }
  return value;
}
function collectImage(value, previous) {
  previous.push(value);
  return previous;
}
function toRunOptions(raw, config, images) {
  const maxIterations = parsePositive(raw.maxIterations, "--max-iterations", true);
  const timeoutSeconds = raw.timeout === void 0 ? void 0 : parsePositive(raw.timeout, "--timeout", false);
  return {
    cwd: raw.cwd,
    maxIterations,
    yes: raw.yes,
    json: raw.json,
    ...raw.model === void 0 ? {} : { model: raw.model },
    ...timeoutSeconds === void 0 ? {} : { timeoutSeconds },
    ...raw.system === void 0 ? {} : { system: raw.system },
    ...config === void 0 ? {} : { config },
    ...images.length === 0 ? {} : { images }
  };
}
function delegatedModel(raw, config) {
  return delegatedModelOverride(resolveOrchestratorModel(raw.model, process.env, config));
}
function toCodexRunOptions(raw, config, images) {
  const timeoutSeconds = raw.timeout === void 0 ? void 0 : parsePositive(raw.timeout, "--timeout", false);
  const sandbox = validateSandboxMode(raw.sandbox);
  const model = delegatedModel(raw, config);
  return {
    cwd: raw.cwd,
    json: raw.json,
    sandbox,
    fullAuto: fullAutoForSandbox(sandbox),
    ...model === void 0 ? {} : { model },
    ...timeoutSeconds === void 0 ? {} : { timeoutSeconds },
    ...images.length === 0 ? {} : { images }
  };
}
function toClaudeCodeRunOptions(raw, config, images) {
  const timeoutSeconds = raw.timeout === void 0 ? void 0 : parsePositive(raw.timeout, "--timeout", false);
  const model = delegatedModel(raw, config);
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...model === void 0 ? {} : { model },
    ...timeoutSeconds === void 0 ? {} : { timeoutSeconds },
    ...images.length === 0 ? {} : { images }
  };
}
function toInteractiveOptions(raw, chat = {}, config) {
  const maxIterations = parsePositive(raw.maxIterations, "--max-iterations", true);
  const timeoutSeconds = raw.timeout === void 0 ? void 0 : parsePositive(raw.timeout, "--timeout", false);
  return {
    cwd: raw.cwd,
    maxIterations,
    yes: raw.yes,
    json: raw.json,
    save: chat.save !== false,
    ...raw.model === void 0 ? {} : { model: raw.model },
    ...timeoutSeconds === void 0 ? {} : { timeoutSeconds },
    ...raw.system === void 0 ? {} : { system: raw.system },
    ...chat.continue === void 0 ? {} : { continue: chat.continue },
    ...chat.session === void 0 ? {} : { session: chat.session },
    ...raw.backend === void 0 ? {} : { backend: raw.backend },
    ...config === void 0 ? {} : { config }
  };
}
async function chatAndExit(raw, chat = {}) {
  try {
    const config = await runtimeConfig(raw);
    process.exitCode = await runInteractive(toInteractiveOptions(raw, chat, config));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
async function runAndExit(objectiveParts, raw) {
  const objective = objectiveParts.join(" ").trim();
  if (objective === "") {
    console.error('Usage: kapel [options] "<objective>"');
    process.exitCode = 1;
    return;
  }
  try {
    const objectiveWithStdin = await objectiveWithPipedStdin(objective, process.stdin);
    const resolvedImages = await resolveImageAttachments(raw.image, raw.cwd);
    if (!resolvedImages.ok) {
      console.error(resolvedImages.error);
      process.exitCode = 1;
      return;
    }
    const images = resolvedImages.images;
    const config = await runtimeConfig(raw);
    const backend = resolveBackendSetting(raw.backend, process.env, config).value;
    if (backend === "codex") {
      process.exitCode = await runCodexObjective(objectiveWithStdin, toCodexRunOptions(raw, config, images));
      return;
    }
    if (backend === "claude-code") {
      process.exitCode = await runClaudeCodeObjective(objectiveWithStdin, toClaudeCodeRunOptions(raw, config, images));
      return;
    }
    process.exitCode = await runObjective(objectiveWithStdin, toRunOptions(raw, config, images));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
var program = new Command();
program.name("kapel").description("Kapel \u2014 a multi-model orchestration coding agent: point it at a repository and an objective, and it plans, routes, and edits via LLM tool-call loops.").version(CLI_VERSION).option("--cwd <dir>", "workspace root to operate in", process.cwd()).option("-m, --model <alias>", "model alias to use (see `kapel models`)").option("--max-iterations <n>", "maximum tool-call iterations before giving up", "32").option("--timeout <seconds>", "overall run timeout, in seconds").option("-y, --yes", "auto-approve every permission prompt", false).option("--json", "emit newline-delimited JSON events instead of text", false).option("--system <text>", "override the default system prompt").option("--backend <name>", `execution backend to use: ${BACKEND_NAMES.join(" | ")} (default: native, or AGENT_BACKEND, or your \`kapel config\`)`).option("--sandbox <mode>", `codex sandbox mode: ${SANDBOX_MODES.join(" | ")}`, DEFAULT_SANDBOX_MODE).option("-i, --image <path>", "attach an image (PNG/JPEG/GIF/WEBP; repeatable, up to 4, 5 MiB each) \u2014 supported by the native and codex backends, not claude-code", collectImage, []).option("--no-setup", "skip the first-run setup wizard and use environment variables and defaults");
program.argument("[objective...]", 'the coding objective to work on, e.g. "fix the failing test"').action(async (objective, opts) => {
  if (objective.length === 0) {
    if (process.stdin.isTTY === true) {
      await chatAndExit(opts);
      return;
    }
    program.help();
    return;
  }
  await runAndExit(objective, opts);
});
program.command("chat").description("Open an interactive conversation with the coding agent in this directory").option("-c, --continue", "resume this directory's most recent conversation").option("--session <id>", "resume a specific conversation (id, id prefix, or /name)").option("--no-save", "do not record this conversation in .agent/sessions.db").action(async (opts, command) => {
  await chatAndExit(command.optsWithGlobals(), opts);
});
program.command("exec").description("Run the coding agent loop (same as the default command)").argument("<objective...>", "the coding objective to work on").action(async (objective, _opts, command) => {
  await runAndExit(objective, command.optsWithGlobals());
});
program.command("init").description("Create a .agent configuration in the current repository").option("--force", "overwrite an existing .agent directory", false).action(async (opts, command) => {
  const cwd = command.optsWithGlobals().cwd;
  const config = await loadKapelConfig();
  process.exitCode = await runInit({
    cwd: path18.resolve(cwd),
    force: opts.force,
    ...config === void 0 ? {} : { config }
  });
});
program.command("config").description("Configure which backend and models kapel uses (stored in ~/.kapel/config.json)").option("--show", "print the current configuration and where it lives", false).option("--path", "print the configuration file path", false).action(async (opts) => {
  process.exitCode = await runConfigCommand(opts, {
    log: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true
  });
});
program.command("models").description("List available model aliases and provider credential status").action(async (_opts, command) => {
  const cwd = command.optsWithGlobals().cwd;
  await loadDotEnvFile(path18.resolve(cwd));
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
  console.log('backend claude-code \u2014 uses the Claude Code CLI with your Claude subscription login (run: kapel --backend claude-code "...")');
});
function planOptions(command, config) {
  const raw = command.optsWithGlobals();
  return {
    cwd: raw.cwd,
    json: raw.json,
    // Planning goes through the same backend the run would: under `--backend
    // codex`/`claude-code` that is what keeps `kapel plan` working with no
    // API key at all.
    backend: resolveBackendSetting(raw.backend, process.env, config).value,
    ...raw.model === void 0 ? {} : { model: raw.model },
    ...config === void 0 ? {} : { config }
  };
}
function executionOptions(command, opts, backend) {
  const raw = command.optsWithGlobals();
  const timeoutSeconds = raw.timeout === void 0 ? void 0 : parsePositive(raw.timeout, "--timeout", false);
  const maxIterations = parsePositive(raw.maxIterations, "--max-iterations", true);
  return {
    workerMode: validateWorkerMode(opts.workerMode),
    isolation: validateIsolation(opts.isolation),
    backend,
    maxIterations,
    validate: opts.validate,
    tui: opts.tui,
    ...timeoutSeconds === void 0 ? {} : { timeoutSeconds }
  };
}
function orchestrateOptions(command, opts, config) {
  const raw = command.optsWithGlobals();
  return {
    ...planOptions(command, config),
    ...executionOptions(command, opts, resolveBackendSetting(raw.backend, process.env, config).value),
    dryRun: opts.dryRun,
    save: opts.save
  };
}
function resumeOptions(command, opts, config) {
  const raw = command.optsWithGlobals();
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...executionOptions(command, opts, resolveBackendSetting(raw.backend, process.env, config).value)
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
program.command("plan").description("Plan an objective into a task graph and print it, without executing anything").argument("<objective...>", "the objective to plan").option("--why [taskId]", "print routing rationale for one task, or every task if no id is given").action(async (objective, opts, command) => {
  const config = await runtimeConfig(command.optsWithGlobals());
  await objectiveCommand(objective, 'Usage: kapel plan "<objective>"', (text2) => runPlan(text2, {
    ...planOptions(command, config),
    ...typeof opts.why === "string" ? { why: opts.why } : opts.why === true ? { why: true } : {}
  }));
});
withExecutionOptions(program.command("orchestrate").description("Plan an objective and execute the resulting task graph across routed workers").argument("<objective...>", "the objective to orchestrate")).option("--dry-run", "plan only \u2014 same output as `kapel plan`", false).option("--no-save", "do not record this run in .agent/sessions.db").action(async (objective, opts, command) => {
  const config = await runtimeConfig(command.optsWithGlobals());
  await objectiveCommand(objective, 'Usage: kapel orchestrate "<objective>"', (text2) => runOrchestrate(text2, orchestrateOptions(command, opts, config)));
});
withExecutionOptions(program.command("resume").description("Re-execute the unfinished tasks of a recorded run").argument("<runId>", "the run to resume (see `kapel runs`)")).action(async (runId, opts, command) => {
  try {
    const config = await runtimeConfig(command.optsWithGlobals());
    process.exitCode = await runResume(runId, resumeOptions(command, opts, config));
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
var sessionsCommand = program.command("sessions").description("List interactive chat sessions recorded in this workspace").option("--limit <n>", "how many sessions to list", String(DEFAULT_SESSIONS_LIST_LIMIT)).action(async (opts, command) => {
  const raw = command.optsWithGlobals();
  try {
    process.exitCode = await runSessionsListCommand({
      cwd: raw.cwd,
      json: raw.json,
      limit: parsePositive(opts.limit, "--limit", true)
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
sessionsCommand.command("fork").description("Copy a chat session's transcript into a new, independent session").argument("<session>", "the session to fork (id, id prefix, or name)").option("--name <name>", "name for the new session").action(async (session, opts, command) => {
  const raw = command.optsWithGlobals();
  try {
    process.exitCode = await runSessionsForkCommand({
      cwd: raw.cwd,
      json: raw.json,
      session,
      ...opts.name === void 0 ? {} : { name: opts.name }
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
function policyOptions(command, config) {
  const raw = command.optsWithGlobals();
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...raw.model === void 0 ? {} : { model: raw.model },
    ...config === void 0 ? {} : { config }
  };
}
function policyCompileOptions(command, config) {
  const raw = command.optsWithGlobals();
  return {
    ...policyOptions(command, config),
    backend: resolveBackendSetting(raw.backend, process.env, config).value
  };
}
var POLICY_SUBCOMMANDS = ["compile", "check", "explain", "diff"];
var policyCommand = program.command("policy").description("Manage orchestration policies (compile, check, explain, diff)").argument("[unknownCommand]", "compile | check | explain | diff");
policyCommand.command("compile").description("Compile .agent/orchestration.md into a policy lock using an LLM").action(async (_opts, command) => {
  const config = await runtimeConfig(command.optsWithGlobals());
  process.exitCode = await runPolicyCompile(policyCompileOptions(command, config));
});
policyCommand.command("diff").description("Show what would change if the policy lock were recompiled, without writing it").action(async (_opts, command) => {
  const config = await runtimeConfig(command.optsWithGlobals());
  process.exitCode = await runPolicyDiff(policyCompileOptions(command, config));
});
policyCommand.command("check").description("Check that the policy lock is fresh and valid (no LLM calls)").action(async (_opts, command) => {
  process.exitCode = await runPolicyCheck(policyOptions(command, void 0));
});
policyCommand.command("explain").description("Print a human-readable summary of the compiled policy").action(async (_opts, command) => {
  process.exitCode = await runPolicyExplain(policyOptions(command, void 0));
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
