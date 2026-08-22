import { PassThrough, Writable } from "node:stream";
import { SessionAllowlist } from "@agent/coding-agent";
import { describe, expect, it } from "vitest";
import {
  createPrompter,
  createPromptState,
  formatPermissionPrompt,
  formatPermissionQuery,
  PERMISSION_ANSWER_HINT,
  parsePermissionAnswer,
  permissionFeedback,
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
  it("keeps the question bare for a tool that has a real preview block", () => {
    const query = formatPermissionQuery(request());
    expect(query).toBe("allow bash? [y/n/a, or say what to do instead] ");
  });

  it("keeps the compact JSON inline for a tool with no preview block", () => {
    const req = request({ tool: "grep", input: { pattern: "add" } });
    const query = formatPermissionQuery(req);
    expect(query).toBe(
      `allow grep? ${previewInput({ pattern: "add" })} ${PERMISSION_ANSWER_HINT} `,
    );
  });

  it("offers all three letters", () => {
    expect(formatPermissionQuery(request())).toContain("[y/n/a,");
  });

  it("advertises the fourth answer, which has no letter to type", () => {
    expect(formatPermissionQuery(request())).toContain(
      "or say what to do instead",
    );
  });
});

// --- formatPermissionPrompt ---------------------------------------------------

describe("formatPermissionPrompt", () => {
  it("puts the bash command in the block, not in the question", () => {
    const prompt = formatPermissionPrompt(
      request({ input: { command: "npm test" } }),
    );
    expect(prompt.block).toBe("  npm test");
    expect(prompt.query).toBe(`allow bash? ${PERMISSION_ANSWER_HINT} `);
  });

  it("has no block for an unknown tool", () => {
    expect(formatPermissionPrompt(request({ tool: "glob" })).block).toBe(
      undefined,
    );
  });
});

// --- parsePermissionAnswer ----------------------------------------------------

describe("parsePermissionAnswer", () => {
  const cases: ReadonlyArray<[string | undefined | symbol, string]> = [
    ["y", "once"],
    ["Y", "once"],
    ["  yes  ", "once"],
    ["YES", "once"],
    ["a", "always"],
    ["A", "always"],
    ["  always ", "always"],
    ["n", "deny"],
    ["no", "deny"],
    ["", "deny"],
    ["   ", "deny"],
    ["NO", "deny"],
    [undefined, "deny"],
    [Symbol("input-sigint"), "deny"],
    // Anything that is not one of the four letters is the user talking.
    ["nope", "feedback"],
    ["ya", "feedback"],
    ["use the config file instead", "feedback"],
    ["왜 이 파일을 지우려는 거야?", "feedback"],
  ];

  for (const [answer, expected] of cases) {
    it(`reads ${String(answer)} as ${expected}`, () => {
      expect(parsePermissionAnswer(answer)).toBe(expected);
    });
  }
});

// --- permissionFeedback -------------------------------------------------------

describe("permissionFeedback", () => {
  it("returns the typed words, trimmed", () => {
    expect(permissionFeedback("  use the config file instead  ")).toBe(
      "use the config file instead",
    );
  });

  it("keeps multi-byte text byte-for-byte", () => {
    expect(permissionFeedback("왜 이 파일을 지우려는 거야?")).toBe(
      "왜 이 파일을 지우려는 거야?",
    );
  });

  it("has nothing to say for y, n, a or no answer at all", () => {
    for (const answer of ["y", "yes", "n", "no", "a", "always", "", "   "]) {
      expect(permissionFeedback(answer)).toBeUndefined();
    }
    expect(permissionFeedback(undefined)).toBeUndefined();
    expect(permissionFeedback(Symbol("sigint"))).toBeUndefined();
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

  // --- notify wiring -------------------------------------------------------

  it("rings waitingForApproval once, before the question is asked", async () => {
    const calls: string[] = [];
    const state = createPromptState();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state,
      ask: async () => {
        calls.push("asked");
        return "y";
      },
      notify: {
        turnFinished: () => calls.push("turnFinished"),
        runFinished: () => calls.push("runFinished"),
        waitingForApproval: () => calls.push("waitingForApproval"),
      },
    });
    await prompter?.ask(request());
    expect(calls).toEqual(["waitingForApproval", "asked"]);
  });

  it("rings once per ask, on every answer including a denial", async () => {
    let count = 0;
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async () => "n",
      notify: {
        turnFinished: () => {},
        runFinished: () => {},
        waitingForApproval: () => {
          count += 1;
        },
      },
    });
    await prompter?.ask(request());
    await prompter?.ask(request());
    expect(count).toBe(2);
  });

  it("never rings under --yes — there is no waiting to signal", async () => {
    let rang = false;
    const prompter = createPrompter({
      yes: true,
      interactive: true,
      state: createPromptState(),
      notify: {
        turnFinished: () => {},
        runFinished: () => {},
        waitingForApproval: () => {
          rang = true;
        },
      },
    });
    await prompter?.ask(request());
    expect(rang).toBe(false);
  });

  it("works with no notify at all — the default for every test above", async () => {
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async () => "y",
    });
    await expect(prompter?.ask(request())).resolves.toBe(true);
  });

  it("passes the injected ask the same query text askOnce would show", async () => {
    let received: string | undefined;
    const prompter = createPrompter({
      // `color: false` so this asserts the *text*, not the styling: on a
      // terminal the question is handed over bold (see `createPrompter`).
      color: false,
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

  it("askOnce path: resolves false on a bare 'n'", async () => {
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
    input.write("n\n");
    await expect(result).resolves.toBe(false);
  });

  it("askOnce path: a typed sentence denies and carries the words", async () => {
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
    input.write("왜 이 파일을 지우려는 거야?\n");
    await expect(result).resolves.toEqual({
      allowed: false,
      feedback: "왜 이 파일을 지우려는 거야?",
    });
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

// --- the fourth answer: deny, with words --------------------------------------

describe("createPrompter: answering in prose", () => {
  it("denies and hands back what the user typed", async () => {
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async () => "use the config file instead",
    });

    await expect(prompter?.ask(request())).resolves.toEqual({
      allowed: false,
      feedback: "use the config file instead",
    });
  });

  it("carries a multi-byte answer through verbatim", async () => {
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      ask: async () => "  왜 이 파일을 지우려는 거야?  ",
    });

    await expect(prompter?.ask(request())).resolves.toEqual({
      allowed: false,
      feedback: "왜 이 파일을 지우려는 거야?",
    });
  });

  it("keeps y/n/a on the plain boolean they always answered with", async () => {
    const answers: Record<string, boolean> = {
      y: true,
      a: true,
      n: false,
      "": false,
      "   ": false,
    };
    for (const [raw, expected] of Object.entries(answers)) {
      const prompter = createPrompter({
        yes: false,
        interactive: true,
        state: createPromptState(),
        output: collector().stream,
        ask: async () => raw,
      });
      await expect(prompter?.ask(request())).resolves.toBe(expected);
    }
  });

  it("remembers nothing: a spoken refusal never touches the allowlist", async () => {
    const allowlist = new SessionAllowlist();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: collector().stream,
      allowlist,
      ask: async () => "always ask me first",
    });

    const req = request({ input: { command: "rm -rf build" } });
    await expect(prompter?.ask(req)).resolves.toEqual({
      allowed: false,
      feedback: "always ask me first",
    });
    expect(allowlist.allows(req)).toBe(false);
    expect(allowlist.entries()).toEqual([]);
  });

  it("still releases the status line after a spoken refusal", async () => {
    const state = createPromptState();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state,
      output: collector().stream,
      ask: async () => "why?",
    });

    await prompter?.ask(request());
    expect(state.active).toBe(false);
  });
});

// --- three-way answers and the session allowlist ------------------------------

function collector(): {
  readonly stream: Writable;
  readonly text: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join("") };
}

describe("createPrompter: previews and 'always'", () => {
  it("writes the bash command preview above the question", async () => {
    const out = collector();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: out.stream,
      ask: async () => "y",
    });

    await prompter?.ask(request({ input: { command: "npm test --run foo" } }));
    expect(out.text()).toContain("  npm test --run foo\n");
  });

  it("writes a -/+ diff for edit_file", async () => {
    const out = collector();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: out.stream,
      ask: async () => "y",
    });

    await prompter?.ask(
      request({
        tool: "edit_file",
        input: { path: "calc.js", oldText: "a - b", newText: "a + b" },
      }),
    );
    expect(out.text()).toContain("  calc.js");
    expect(out.text()).toContain("  - a - b");
    expect(out.text()).toContain("  + a + b");
  });

  it("remembers a bash prefix when answered with 'a'", async () => {
    const out = collector();
    const allowlist = new SessionAllowlist();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: out.stream,
      allowlist,
      ask: async () => "a",
    });

    const req = request({ input: { command: "npm test --run foo" } });
    await expect(prompter?.ask(req)).resolves.toBe(true);
    expect(allowlist.allows(req)).toBe(true);
    expect(
      allowlist.allows(request({ input: { command: "npm test -w x" } })),
    ).toBe(true);
    expect(
      allowlist.allows(request({ input: { command: "npm publish" } })),
    ).toBe(false);
    expect(out.text()).toContain("remembered for this session: bash npm test");
  });

  it("remembers other tools by name when answered with 'a'", async () => {
    const allowlist = new SessionAllowlist();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: collector().stream,
      allowlist,
      ask: async () => "always",
    });

    const req = request({
      tool: "edit_file",
      input: { path: "a.ts", oldText: "x", newText: "y" },
    });
    await expect(prompter?.ask(req)).resolves.toBe(true);
    expect(allowlist.allows(req)).toBe(true);
    expect(
      allowlist.allows(
        request({
          tool: "edit_file",
          input: { path: "other.ts", oldText: "p", newText: "q" },
        }),
      ),
    ).toBe(true);
    expect(allowlist.allows(request({ tool: "write_file" }))).toBe(false);
  });

  it("offers `a` in the preview only when an allowlist is wired", async () => {
    const withList = collector();
    await createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: withList.stream,
      allowlist: new SessionAllowlist(),
      ask: async () => "n",
    })?.ask(request({ input: { command: "ls" } }));
    expect(withList.text()).toContain("a = always allow bash ls");

    const without = collector();
    await createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: without.stream,
      ask: async () => "n",
    })?.ask(request({ input: { command: "ls" } }));
    expect(without.text()).not.toContain("a = always allow");
  });

  it("allows once, and says so, when a compound command cannot be remembered", async () => {
    const out = collector();
    const allowlist = new SessionAllowlist();
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: out.stream,
      allowlist,
      ask: async () => "a",
    });

    const req = request({ input: { command: "npm test && rm -rf ." } });
    await expect(prompter?.ask(req)).resolves.toBe(true);
    expect(allowlist.allows(req)).toBe(false);
    expect(out.text()).toContain("allowed once");
    expect(out.text()).not.toContain("a = always allow");
  });

  it("still allows once for 'a' when no allowlist is wired", async () => {
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: collector().stream,
      ask: async () => "a",
    });
    await expect(prompter?.ask(request())).resolves.toBe(true);
  });

  it("colours the preview only when the output is a TTY", async () => {
    const editRequest = request({
      tool: "edit_file",
      input: { path: "a.ts", oldText: "x", newText: "y" },
    });

    const plain = collector();
    await createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: plain.stream,
      ask: async () => "n",
    })?.ask(editRequest);
    expect(plain.text()).not.toContain("\u001b[");

    const colored = collector();
    await createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: colored.stream,
      color: true,
      ask: async () => "n",
    })?.ask(editRequest);
    expect(colored.text()).toContain("\u001b[31m");
    expect(colored.text()).toContain("\u001b[32m");
  });

  it("erases the status line's row before writing, on a terminal only", async () => {
    const tty = collector();
    await createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: tty.stream,
      color: true,
      ask: async () => "n",
    })?.ask(request({ input: { command: "ls" } }));
    expect(tty.text().startsWith("\u001b[2K\r")).toBe(true);

    const piped = collector();
    await createPrompter({
      yes: false,
      interactive: true,
      state: createPromptState(),
      output: piped.stream,
      ask: async () => "n",
    })?.ask(request({ input: { command: "ls" } }));
    expect(piped.text()).toBe("  ls\n");
  });

  it("keeps the status line suspended for the whole prompt, preview included", async () => {
    const state = createPromptState();
    const seen: boolean[] = [];
    const out = new Writable({
      write(_chunk, _enc, cb) {
        seen.push(state.active);
        cb();
      },
    });
    const prompter = createPrompter({
      yes: false,
      interactive: true,
      state,
      output: out,
      allowlist: new SessionAllowlist(),
      ask: async () => "a",
    });

    await prompter?.ask(request({ input: { command: "ls" } }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((active) => active)).toBe(true);
    expect(state.active).toBe(false);
  });
});
