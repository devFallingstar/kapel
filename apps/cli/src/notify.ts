/**
 * Attention signals for a session nobody is looking at.
 *
 * A chat turn or an orchestration run can take minutes, and the terminal
 * running it is exactly the kind of window people tab away from — to read
 * something, to answer a message, to let a long build finish somewhere else.
 * Two moments in particular are worth reaching for the user's attention even
 * when they are not watching:
 *
 * - the run or turn is *done*, so there is an answer waiting; and
 * - the run is *stuck* on a permission question, which is worse — the whole
 *   pipeline is blocked on an answer nobody has been asked for yet, and every
 *   minute it sits there is a minute wasted rather than a minute saved.
 *
 * Two escape sequences do the reaching, sent together by default:
 *
 * - `BEL` (`\x07`) — the terminal's own bell. Every terminal either beeps,
 *   flashes, or (having been told not to) does nothing; there is no way to
 *   ask it which, so sending it costs nothing on a terminal that ignores it.
 * - `OSC 9` (`\x1b]9;<text>\x07`) — the informal "post a desktop
 *   notification" sequence iTerm2, WezTerm, Windows Terminal, Ghostty and
 *   kitty all implement. A terminal that has never heard of it treats it as
 *   an unrecognised OSC command and drops it silently — so, like the bell
 *   itself, sending it is always safe to *try*.
 *
 * "Always safe to try" is not the same as "always fine to send". A pipe, a
 * redirect, or a `TERM=dumb` run has nothing on the other end that would ever
 * turn either sequence into an alert, and writing arbitrary escape bytes into
 * a file or a downstream parser is exactly the kind of surprise this module
 * exists to avoid causing anywhere else. So the gate is the same one
 * `screen.ts` uses for the alternate screen: the output stream has to claim
 * to be a TTY, and `TERM` has to not be actively disclaiming one. See
 * {@link notifySupported}.
 */

/** A writable that may know whether it is a terminal — the half `notifySupported` reads. */
export interface NotifyStream {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/** The four things `notify` (config field, `KAPEL_NO_NOTIFY`) can be set to. */
export type NotifySetting = "off" | "bell" | "osc9" | "auto";

/** The bell alone: audible or visual, whichever the terminal prefers. */
export const BEL = "\x07";

/**
 * How long a chat turn has to run before finishing it is worth a signal.
 *
 * A quick exchange — "what does this function do", a one-line fix already
 * confirmed — finishes before anyone has had time to look away, and dinging
 * for every reply would make the signal noise instead of a signal. Ten
 * seconds is long enough that tabbing away has become a real possibility and
 * short enough that a genuinely long turn is never made to wait for it.
 */
export const TURN_NOTIFY_THRESHOLD_MS = 10_000;

/** Whether a chat turn that took `elapsedMs` is worth notifying about. */
export function shouldNotifyTurnFinished(elapsedMs: number): boolean {
  return elapsedMs >= TURN_NOTIFY_THRESHOLD_MS;
}

/**
 * Strips control characters (C0 plus `DEL`) out of text bound for an OSC 9
 * payload.
 *
 * The sequence is terminated by its own trailing `BEL`, so a message that
 * happened to contain one — copied tool output, a stray byte in a file name —
 * would end the sequence early and spill the rest as literal text onto the
 * terminal. Every other C0 control (a raw newline, an escape byte that could
 * start a *second* sequence) is just as unwelcome inside one line of "what
 * happened", so the whole class is removed rather than only the one that
 * would technically break the syntax.
 */
export function sanitizeNotifyMessage(message: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the whole point is stripping them.
  return message.replace(/[\x00-\x1f\x7f]/g, "");
}

/** `OSC 9 ; <message> BEL` — the desktop-notification request, terminated and sanitized. */
export function osc9Sequence(message: string): string {
  return `\x1b]9;${sanitizeNotifyMessage(message)}${BEL}`;
}

/**
 * The bytes one notification writes for a given setting — `""` for `"off"`,
 * both sequences for `"auto"`, one or the other for `"bell"`/`"osc9"`.
 *
 * Pure and total: every setting yields exactly the bytes it names, with no
 * knowledge of TTYs or environments — that half is {@link notifySupported}'s,
 * kept separate so each can be tested (and reasoned about) on its own.
 */
export function notifySequenceFor(
  setting: NotifySetting,
  message: string,
): string {
  if (setting === "off") return "";
  const bell = setting === "osc9" ? "" : BEL;
  const osc9 = setting === "bell" ? "" : osc9Sequence(message);
  return `${bell}${osc9}`;
}

/** What {@link notifySupported} reads to decide whether a sequence may be written at all. */
export interface NotifyGateOptions {
  readonly stream?: NotifyStream;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Whether this process may write a notification sequence at all.
 *
 * Mirrors `screen.ts`'s `altScreenSupported` gate on purpose — both are
 * asking the same underlying question ("is there a terminal on the other end
 * of this stream that would do something sane with an escape sequence") —
 * except a notification only ever writes to *one* stream, so only that
 * stream's `isTTY` matters; there is no second, input side of the check the
 * way the alt-screen swap needs one.
 */
export function notifySupported(options: NotifyGateOptions = {}): boolean {
  if (options.stream?.isTTY !== true) return false;
  const term = (options.env ?? process.env).TERM;
  // An unset `TERM` is normal on Windows, where a TTY is still a terminal
  // that understands these sequences; `dumb` (or empty) is an explicit "I
  // cannot".
  if (term !== undefined && (term === "" || term.toLowerCase() === "dumb")) {
    return false;
  }
  return true;
}

/** Terse, specific attention signals — see the module doc for what each one means. */
export interface Notifier {
  /**
   * A chat turn ended — successfully or not, but never for one the user
   * themselves cut short (see `TURN_NOTIFY_THRESHOLD_MS` and the call site in
   * `interactive.ts`, which is what decides "not aborted"; this only decides
   * "not too quick to matter"). A no-op below {@link TURN_NOTIFY_THRESHOLD_MS}.
   */
  turnFinished(elapsedMs: number): void;
  /**
   * An orchestration run ended, in the REPL or standalone. Always fires —
   * unlike a chat turn, a run is never quick enough that the signal would be
   * noise, and it is the one event a caller may specifically be waiting on
   * from another room.
   */
  runFinished(summary: string): void;
  /**
   * A permission prompt has started waiting for an answer. Fires
   * unconditionally, every time one opens: a run blocked on a question
   * nobody has seen is the single worst thing this module exists to prevent,
   * and there is no threshold that makes "everything downstream is stalled"
   * a quiet event.
   */
  waitingForApproval(): void;
}

export interface CreateNotifierOptions {
  /** Where the sequences are written — the same stream the caller's status/output machinery owns. */
  readonly stream: NotifyStream;
  readonly env?: NodeJS.ProcessEnv;
  /** The `notify` setting already resolved by `config-runtime.ts`. Defaults to `"auto"`. */
  readonly setting?: NotifySetting;
}

/**
 * Builds a {@link Notifier} bound to one output stream.
 *
 * Every public method funnels through one `send`, which re-checks
 * {@link notifySupported} rather than caching the answer at construction —
 * cheap (two property reads) and correct for a stream whose `isTTY` could in
 * principle change under a long-lived notifier, which costs nothing to keep
 * honest about.
 *
 * A stream write is wrapped in `try`/`catch`: a terminal that has gone away
 * (the process is exiting, the pty closed) must not turn a courtesy ding into
 * the error the user is left looking at.
 */
export function createNotifier(options: CreateNotifierOptions): Notifier {
  const setting = options.setting ?? "auto";

  const send = (message: string): void => {
    if (setting === "off") return;
    if (
      !notifySupported({
        stream: options.stream,
        ...(options.env === undefined ? {} : { env: options.env }),
      })
    ) {
      return;
    }
    const sequence = notifySequenceFor(setting, message);
    if (sequence === "") return;
    try {
      options.stream.write(sequence);
    } catch {
      // See the doc comment above: a stream that cannot be written to is not
      // this feature's failure to report.
    }
  };

  return {
    turnFinished(elapsedMs: number): void {
      if (!shouldNotifyTurnFinished(elapsedMs)) return;
      const seconds = Math.round(elapsedMs / 1000);
      send(`kapel: turn finished (${seconds}s)`);
    },
    runFinished(summary: string): void {
      send(`kapel: run finished — ${summary}`);
    },
    waitingForApproval(): void {
      send("kapel: waiting for approval");
    },
  };
}
