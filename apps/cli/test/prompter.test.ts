import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createPrompter,
  createPromptState,
  formatPermissionQuery,
  previewInput,
} from "../src/prompter.js";

function request(overrides: Partial<{ tool: string; input: unknown }> = {}) {
  return {
    tool: overrides.tool ?? "bash",
    input: overrides.input ?? { command: "ls" },
    agent: "worker",
  };
}

// --- formatPermissionQuery ----------------------------------------------------

describe("formatPermissionQuery", () => {
  it("shows the tool name and a preview of its input", () => {
    const query = formatPermissionQuery(request());
    expect(query).toBe(`allow bash? ${previewInput({ command: "ls" })} [y/N] `);
    expect(query).toContain("[y/N]");
  });
});

// --- createPrompter: --yes and non-interactive --------------------------------

describe("createPrompter", () => {
  it("always approves under --yes", async () => {
    const prompter = createPrompter({
      yes: true,
      interactive: true,
      state: createPromptState(),
    });
    await expect(prompter?.ask(request())).resolves.toBe(true);
  });

  it("is undefined when not interactive and not --yes", () => {
    const prompter = createPrompter({
      yes: false,
      interactive: false,
      state: createPromptState(),
    });
    expect(prompter).toBeUndefined();
  });

  // --- injected `ask` path ------------------------------------------------

  it("treats a 'y' answer from the injected ask as approval", async () => {
    const state = createPromptState();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state,
      ask: async () => "y",
    });
    await expect(prompter?.ask(request())).resolves.toBe(true);
  });

  it("treats 'Y' (any case, with whitespace) as approval too", async () => {
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async () => "  Y  ",
    });
    await expect(prompter?.ask(request())).resolves.toBe(true);
  });

  it("treats an 'n' answer from the injected ask as denial", async () => {
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async () => "n",
    });
    await expect(prompter?.ask(request())).resolves.toBe(false);
  });

  it("treats an undefined answer (closed stream) as denial", async () => {
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async () => undefined,
    });
    await expect(prompter?.ask(request())).resolves.toBe(false);
  });

  it("treats a symbol answer (e.g. INPUT_SIGINT) as denial", async () => {
    const sigint = Symbol("sigint");
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async () => sigint,
    });
    await expect(prompter?.ask(request())).resolves.toBe(false);
  });

  it("toggles state.active around the ask call", async () => {
    const state = createPromptState();
    const seenDuring: boolean[] = [];
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state,
      ask: async () => {
        seenDuring.push(state.active);
        return "y";
      },
    });

    expect(state.active).toBe(false);
    await prompter?.ask(request());
    expect(seenDuring).toEqual([true]);
    expect(state.active).toBe(false);
  });

  it("passes the injected ask the same query text askOnce would show", async () => {
    let received: string | undefined;
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async (query) => {
        received = query;
        return "y";
      },
    });
    const req = request({ tool: "write_file", input: { path: "a.txt" } });
    await prompter?.ask(req);
    expect(received).toBe(formatPermissionQuery(req));
  });

  // --- unmodified askOnce (fake-stream) path -------------------------------

  it("askOnce path (no `ask` injected): resolves true on 'y' via readline, unchanged", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const state = createPromptState();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state,
      input,
      output,
    });

    const result = prompter?.ask(request());
    input.write("y\n");
    await expect(result).resolves.toBe(true);
    expect(chunks.join("")).toContain("allow bash?");
  });

  it("askOnce path: resolves false on anything but y/yes", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const output = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });

    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      input,
      output,
    });

    const result = prompter?.ask(request());
    input.write("nope\n");
    await expect(result).resolves.toBe(false);
  });

  it("askOnce path: resolves false on Ctrl-C (SIGINT)", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const output = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });

    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      input,
      output,
    });

    const result = prompter?.ask(request());
    input.write("\x03");
    await expect(result).resolves.toBe(false);
  });
});
