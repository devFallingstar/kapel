import { describe, expect, it } from "vitest";
import {
  BEL,
  createNotifier,
  notifySequenceFor,
  notifySupported,
  osc9Sequence,
  sanitizeNotifyMessage,
  shouldNotifyTurnFinished,
  TURN_NOTIFY_THRESHOLD_MS,
} from "../src/notify.js";

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
}

describe("sanitizeNotifyMessage", () => {
  it("passes ordinary text through unchanged", () => {
    expect(sanitizeNotifyMessage("kapel: turn finished (42s)")).toBe(
      "kapel: turn finished (42s)",
    );
  });

  it("strips C0 controls, DEL, and an embedded BEL", () => {
    expect(sanitizeNotifyMessage("a\x07b\x1bc\x00d\x7fe\nf")).toBe("abcdef");
  });
});

describe("osc9Sequence", () => {
  it("wraps a sanitized message in OSC 9, terminated with BEL", () => {
    expect(osc9Sequence("hello")).toBe(`\x1b]9;hello${BEL}`);
  });

  it("sanitizes before wrapping, so an embedded BEL cannot end the sequence early", () => {
    expect(osc9Sequence("a\x07b")).toBe(`\x1b]9;ab${BEL}`);
  });
});

describe("notifySequenceFor", () => {
  it('writes nothing for "off"', () => {
    expect(notifySequenceFor("off", "hello")).toBe("");
  });

  it('writes only the bell for "bell"', () => {
    expect(notifySequenceFor("bell", "hello")).toBe(BEL);
  });

  it('writes only OSC 9 for "osc9"', () => {
    expect(notifySequenceFor("osc9", "hello")).toBe(osc9Sequence("hello"));
  });

  it('writes both, bell first, for "auto"', () => {
    expect(notifySequenceFor("auto", "hello")).toBe(
      `${BEL}${osc9Sequence("hello")}`,
    );
  });
});

describe("notifySupported", () => {
  it("says no with no stream at all", () => {
    expect(notifySupported()).toBe(false);
    expect(notifySupported({ env: { TERM: "xterm-256color" } })).toBe(false);
  });

  it("says no off a non-TTY stream", () => {
    expect(
      notifySupported({
        stream: new FakeStream(false),
        env: { TERM: "xterm-256color" },
      }),
    ).toBe(false);
  });

  it("says no to a terminal that says it cannot", () => {
    for (const term of ["dumb", "DUMB", ""]) {
      expect(
        notifySupported({ stream: new FakeStream(true), env: { TERM: term } }),
      ).toBe(false);
    }
  });

  it("says yes on a TTY with a normal TERM", () => {
    expect(
      notifySupported({
        stream: new FakeStream(true),
        env: { TERM: "xterm-256color" },
      }),
    ).toBe(true);
  });

  it("takes an unset TERM as a terminal — that is Windows", () => {
    expect(notifySupported({ stream: new FakeStream(true), env: {} })).toBe(
      true,
    );
  });
});

describe("shouldNotifyTurnFinished", () => {
  it("is false below the threshold", () => {
    expect(shouldNotifyTurnFinished(0)).toBe(false);
    expect(shouldNotifyTurnFinished(TURN_NOTIFY_THRESHOLD_MS - 1)).toBe(false);
  });

  it("is true at and above the threshold", () => {
    expect(shouldNotifyTurnFinished(TURN_NOTIFY_THRESHOLD_MS)).toBe(true);
    expect(shouldNotifyTurnFinished(TURN_NOTIFY_THRESHOLD_MS + 1)).toBe(true);
  });
});

describe("createNotifier", () => {
  const env = { TERM: "xterm-256color" };

  it('writes both sequences by default ("auto") for a long turn', () => {
    const stream = new FakeStream(true);
    const notifier = createNotifier({ stream, env });
    notifier.turnFinished(TURN_NOTIFY_THRESHOLD_MS);
    expect(stream.text).toBe(
      `${BEL}${osc9Sequence("kapel: turn finished (10s)")}`,
    );
  });

  it("writes nothing for a turn under the threshold", () => {
    const stream = new FakeStream(true);
    const notifier = createNotifier({ stream, env });
    notifier.turnFinished(TURN_NOTIFY_THRESHOLD_MS - 1);
    expect(stream.chunks).toEqual([]);
  });

  it("writes nothing at all off a TTY", () => {
    const stream = new FakeStream(false);
    const notifier = createNotifier({ stream, env });
    notifier.turnFinished(60_000);
    notifier.runFinished("3/3 ok");
    notifier.waitingForApproval();
    expect(stream.chunks).toEqual([]);
  });

  it('writes nothing at all when the setting is "off", even on a TTY', () => {
    const stream = new FakeStream(true);
    const notifier = createNotifier({ stream, env, setting: "off" });
    notifier.turnFinished(60_000);
    notifier.runFinished("3/3 ok");
    notifier.waitingForApproval();
    expect(stream.chunks).toEqual([]);
  });

  it('honors a "bell"-only setting', () => {
    const stream = new FakeStream(true);
    const notifier = createNotifier({ stream, env, setting: "bell" });
    notifier.waitingForApproval();
    expect(stream.text).toBe(BEL);
  });

  it('honors an "osc9"-only setting', () => {
    const stream = new FakeStream(true);
    const notifier = createNotifier({ stream, env, setting: "osc9" });
    notifier.waitingForApproval();
    expect(stream.text).toBe(osc9Sequence("kapel: waiting for approval"));
  });

  it("runFinished always fires on a supported stream, whatever the summary", () => {
    const stream = new FakeStream(true);
    const notifier = createNotifier({ stream, env });
    notifier.runFinished("3/3 ok");
    expect(stream.text).toBe(
      `${BEL}${osc9Sequence("kapel: run finished — 3/3 ok")}`,
    );
  });

  it("waitingForApproval always fires on a supported stream", () => {
    const stream = new FakeStream(true);
    const notifier = createNotifier({ stream, env });
    notifier.waitingForApproval();
    expect(stream.text).toBe(
      `${BEL}${osc9Sequence("kapel: waiting for approval")}`,
    );
  });

  it("swallows a write that throws — a terminal that has gone away", () => {
    const stream = {
      isTTY: true,
      write: () => {
        throw new Error("EPIPE");
      },
    };
    const notifier = createNotifier({ stream, env });
    expect(() => notifier.waitingForApproval()).not.toThrow();
  });
});
