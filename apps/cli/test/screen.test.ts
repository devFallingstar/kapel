import { describe, expect, it } from "vitest";
import {
  altScreenSupported,
  ENTER_ALT_SCREEN,
  enterAltScreen,
  LEAVE_ALT_SCREEN,
  type ProcessLike,
} from "../src/screen.js";

/** A stream that remembers every byte written to it, TTY or not. */
class FakeStream {
  readonly chunks: string[] = [];
  constructor(readonly isTTY: boolean) {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }

  asStream(): NodeJS.WritableStream & { readonly isTTY?: boolean } {
    return this as unknown as NodeJS.WritableStream & {
      readonly isTTY?: boolean;
    };
  }
}

/**
 * A stand-in for `process` that records the handlers registered on it and can
 * fire them, so every teardown path can be driven without ending the test
 * runner.
 */
class FakeProcess implements ProcessLike {
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  readonly exits: number[] = [];
  readonly ticks: Array<() => void> = [];

  on(event: string, listener: (...args: never[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    const index = existing.indexOf(listener);
    if (index >= 0) existing.splice(index, 1);
    this.listeners.set(event, existing);
    return this;
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }

  exit(code?: number): void {
    this.exits.push(code ?? 0);
    // The real `process.exit` runs the `exit` handlers on its way out; this
    // one does the same, which is what makes it a fair test of the backstop.
    this.emit("exit");
  }

  nextTick(callback: () => void): void {
    this.ticks.push(callback);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (...rest: unknown[]) => void)(...args);
    }
  }
}

function fixture(
  overrides: {
    readonly stdoutTty?: boolean;
    readonly stdinTty?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly enabled?: boolean;
  } = {},
): {
  readonly stdout: FakeStream;
  readonly proc: FakeProcess;
  readonly screen: ReturnType<typeof enterAltScreen>;
} {
  const stdout = new FakeStream(overrides.stdoutTty ?? true);
  const proc = new FakeProcess();
  const screen = enterAltScreen({
    stdout: stdout.asStream(),
    stdin: { isTTY: overrides.stdinTty ?? true },
    env: overrides.env ?? { TERM: "xterm-256color" },
    process: proc,
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
  });
  return { stdout, proc, screen };
}

describe("altScreenSupported", () => {
  const env = { TERM: "xterm-256color" };

  it("says yes only when both ends are a terminal", () => {
    expect(
      altScreenSupported({
        stdout: new FakeStream(true).asStream(),
        stdin: { isTTY: true },
        env,
      }),
    ).toBe(true);
    for (const [out, is] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      expect(
        altScreenSupported({
          stdout: new FakeStream(out).asStream(),
          stdin: { isTTY: is },
          env,
        }),
      ).toBe(false);
    }
  });

  it("says no to a terminal that says it cannot", () => {
    for (const term of ["dumb", "DUMB", ""]) {
      expect(
        altScreenSupported({
          stdout: new FakeStream(true).asStream(),
          stdin: { isTTY: true },
          env: { TERM: term },
        }),
      ).toBe(false);
    }
  });

  it("takes an unset TERM as a terminal — that is Windows", () => {
    expect(
      altScreenSupported({
        stdout: new FakeStream(true).asStream(),
        stdin: { isTTY: true },
        env: {},
      }),
    ).toBe(true);
  });

  it("says no when the opt-out asked it to", () => {
    expect(
      altScreenSupported({
        stdout: new FakeStream(true).asStream(),
        stdin: { isTTY: true },
        env,
        enabled: false,
      }),
    ).toBe(false);
  });
});

describe("enterAltScreen", () => {
  it("switches to a cleared alternate buffer on a terminal", () => {
    const { stdout, screen } = fixture();
    expect(screen?.active).toBe(true);
    expect(stdout.text).toBe(ENTER_ALT_SCREEN);
    expect(stdout.text).toContain("[?1049h");
  });

  it("writes nothing at all when it may not — no handlers either", () => {
    for (const overrides of [
      { stdoutTty: false },
      { stdinTty: false },
      { env: { TERM: "dumb" } },
      { enabled: false },
    ]) {
      const { stdout, proc, screen } = fixture(overrides);
      expect(screen).toBeUndefined();
      expect(stdout.chunks).toEqual([]);
      expect([...proc.listeners.keys()]).toEqual([]);
    }
  });

  it("restores on the normal path, once, whatever the caller does", () => {
    const { stdout, screen } = fixture();
    screen?.leave();
    expect(screen?.active).toBe(false);
    expect(stdout.text).toBe(`${ENTER_ALT_SCREEN}${LEAVE_ALT_SCREEN}`);
    screen?.leave();
    screen?.leave();
    expect(stdout.text).toBe(`${ENTER_ALT_SCREEN}${LEAVE_ALT_SCREEN}`);
  });

  it("stops listening once it has left", () => {
    const { proc, screen } = fixture();
    screen?.leave();
    for (const event of [
      "exit",
      "uncaughtException",
      "unhandledRejection",
      "SIGINT",
      "SIGHUP",
      "SIGQUIT",
      "SIGTERM",
    ]) {
      expect(proc.listenerCount(event)).toBe(0);
    }
  });

  it("restores from a process.exit the caller never returns from", () => {
    const { stdout, proc } = fixture();
    proc.exit(0);
    expect(stdout.text.endsWith(LEAVE_ALT_SCREEN)).toBe(true);
  });

  it("restores before an uncaught exception is reported, then rethrows it", () => {
    const { stdout, proc } = fixture();
    const boom = new Error("boom");
    proc.emit("uncaughtException", boom);

    // Restored first, so node's own stack trace lands on the terminal the
    // user keeps rather than on a screen about to disappear...
    expect(stdout.text.endsWith(LEAVE_ALT_SCREEN)).toBe(true);
    // ...and the error is re-raised with no handler left, which is what makes
    // node print it and exit exactly as it would have.
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.ticks).toHaveLength(1);
    expect(() => proc.ticks[0]?.()).toThrow(boom);
  });

  it("restores before an unhandled rejection is reported, then rethrows it", () => {
    // The REPL is asynchronous end to end, so a promise nobody awaited is the
    // likelier of the two crashes — and node has ended the process on one
    // since v15, without running a single `finally`. Same contract as an
    // uncaught exception: screen back first, then node's own report.
    const { stdout, proc } = fixture();
    const boom = new Error("nobody awaited me");
    // The second argument is the offending promise; a resolved stand-in keeps
    // this test from putting a genuinely unhandled rejection into the runner.
    proc.emit("unhandledRejection", boom, Promise.resolve());

    expect(stdout.text.endsWith(LEAVE_ALT_SCREEN)).toBe(true);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
    // The sibling handler goes too, so the re-throw gets node's default
    // handling rather than looping back through this module.
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.ticks).toHaveLength(1);
    expect(() => proc.ticks[0]?.()).toThrow(boom);
  });

  it("restores and exits 128+n on the signals that skip `exit` handlers", () => {
    for (const [signal, code] of [
      ["SIGHUP", 129],
      ["SIGQUIT", 131],
      ["SIGTERM", 143],
    ] as const) {
      const { stdout, proc } = fixture();
      proc.emit(signal);
      expect(stdout.text.endsWith(LEAVE_ALT_SCREEN)).toBe(true);
      expect(proc.exits).toEqual([code]);
    }
  });

  it("stands aside on a SIGINT the REPL is already handling", () => {
    const { stdout, proc } = fixture();
    // A turn is running: `replLoop` has its own handler installed, and the
    // process is going to survive this signal.
    proc.on("SIGINT", () => {});
    proc.emit("SIGINT");
    expect(stdout.text).toBe(ENTER_ALT_SCREEN);
    expect(proc.exits).toEqual([]);
  });

  it("takes a SIGINT nobody else would have survived", () => {
    const { stdout, proc } = fixture();
    proc.emit("SIGINT");
    expect(stdout.text.endsWith(LEAVE_ALT_SCREEN)).toBe(true);
    expect(proc.exits).toEqual([130]);
  });

  it("re-asserts the screen a full-screen child may have taken", () => {
    const { stdout, screen } = fixture();
    stdout.chunks.length = 0;
    screen?.reenter();
    expect(stdout.text).toBe(ENTER_ALT_SCREEN);
  });

  it("re-asserts nothing after it has left", () => {
    const { stdout, screen } = fixture();
    screen?.leave();
    stdout.chunks.length = 0;
    screen?.reenter();
    expect(stdout.chunks).toEqual([]);
  });

  it("survives a terminal that has gone away", () => {
    const proc = new FakeProcess();
    const broken = {
      isTTY: true,
      write: () => {
        throw new Error("EPIPE");
      },
    } as unknown as NodeJS.WritableStream & { readonly isTTY?: boolean };
    const screen = enterAltScreen({
      stdout: broken,
      stdin: { isTTY: true },
      env: { TERM: "xterm" },
      process: proc,
    });
    expect(() => screen?.leave()).not.toThrow();
  });
});
