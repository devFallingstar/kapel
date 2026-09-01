/**
 * The clean screen a `kapel` session runs on.
 *
 * Opening the REPL should look like opening any other full-screen terminal
 * program — a blank screen, nothing of the shell's scrollback showing — and
 * quitting it should hand the terminal back exactly as it was found, with the
 * history the user had before still there. That is precisely what the
 * alternate screen buffer is for: the same `smcup`/`rmcup` pair `vim` and
 * `less` use, `ESC[?1049h` to switch to a scratch buffer and `ESC[?1049l` to
 * switch back and restore what was underneath.
 *
 * Two rules keep it safe:
 *
 * - **A terminal on both ends, or nothing.** The switch is written only when
 *   stdout *and* stdin are TTYs and `TERM` says something a terminal would
 *   say. A piped, redirected or `TERM=dumb` run produces the same bytes it
 *   produced before this module existed — not one escape more.
 * - **Never leave the user stranded.** Ending up back in the shell with the
 *   alternate buffer still showing is worse than never having a clean screen
 *   at all, so {@link enterAltScreen} registers the restore on every way this
 *   process can end: the normal return (the caller's `finally`), an explicit
 *   `process.exit` anywhere (the `exit` event, which can still write, because
 *   `ESC[?1049l` is one synchronous write), an uncaught exception or unhandled
 *   rejection (restored *before* node prints the stack, so the stack lands on
 *   the real screen), and `SIGTERM`/`SIGHUP`/`SIGQUIT`, none of which run
 *   `exit` handlers on their own.
 *
 * `SIGINT` is deliberately conditional — see {@link enterAltScreen}.
 */

/** A writable that may know whether it is a terminal. */
export type ScreenStream = NodeJS.WritableStream & { readonly isTTY?: boolean };

/** A readable that may know whether it is a terminal. */
export type ScreenInput = { readonly isTTY?: boolean };

/**
 * Switch to the alternate buffer, home the cursor, clear it — and turn
 * *alternate scroll* (`?1007`) off for the stay.
 *
 * The clear is not redundant: terminals differ on whether `?1049h` blanks the
 * buffer it switches to, and "a clean screen" is the whole feature.
 *
 * The `?1007` pair exists because with alternate scroll on (many emulators'
 * default), a mouse wheel turned over the alternate buffer is translated
 * into arrow-key presses — which walked the prompt's input history instead
 * of scrolling anything. History recall belongs to the arrow keys alone, so
 * the mode is saved (`XTSAVE`, `?1007s`), switched off, and restored on
 * leave (`XTRESTORE`, `?1007r`); a terminal that knows neither sequence
 * ignores both.
 */
export const ENTER_ALT_SCREEN = "[?1049h[H[2J[?1007s[?1007l";

/** Restore alternate scroll, then the normal buffer and its scrollback. */
export const LEAVE_ALT_SCREEN = "[?1007r[?1049l";

/** Signals that would otherwise end the process without running `exit` handlers. */
const FATAL_SIGNALS = {
  SIGHUP: 1,
  SIGQUIT: 3,
  SIGTERM: 15,
} as const;

/** The slice of `process` this module touches, so tests can drive it. */
export interface ProcessLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  listenerCount(event: string): number;
  exit(code?: number): void;
  nextTick(callback: () => void): void;
}

export interface AltScreenOptions {
  readonly stdout?: ScreenStream;
  readonly stdin?: ScreenInput;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * `false` opts out entirely — `kapel --no-altscreen`, for people who would
   * rather keep the transcript in their terminal's own scrollback.
   */
  readonly enabled?: boolean;
  /** Injected by tests; defaults to the real `process`. */
  readonly process?: ProcessLike;
}

/** A session on the alternate screen, and the one way back off it. */
export interface AltScreen {
  /** False once {@link leave} has run. */
  readonly active: boolean;
  /**
   * Puts the alternate screen back after something else may have taken it —
   * a child process that is a full-screen program in its own right. Clears,
   * because whatever the child left there is not ours; the caller repaints.
   * A no-op after {@link leave}.
   */
  reenter(): void;
  /** Restores the user's terminal. Idempotent, and safe to call from anywhere. */
  leave(): void;
}

/**
 * Whether this process may take over the screen.
 *
 * Exported for the tests that pin the piped-run contract: everything about
 * this feature hangs on answering `false` off a terminal.
 */
export function altScreenSupported(options: AltScreenOptions = {}): boolean {
  if (options.enabled === false) return false;
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  if (stdout.isTTY !== true || stdin.isTTY !== true) return false;
  const term = (options.env ?? process.env).TERM;
  // An unset `TERM` is normal on Windows, where a TTY is a terminal that
  // understands this sequence; `dumb` (or empty) is an explicit "I cannot".
  if (term !== undefined && (term === "" || term.toLowerCase() === "dumb")) {
    return false;
  }
  return true;
}

/** Writes without ever letting a closed or broken terminal throw. */
function writeQuietly(stream: ScreenStream, text: string): void {
  try {
    stream.write(text);
  } catch {
    // A terminal that has gone away cannot be restored, and failing to
    // restore it must never be the error the user is left with.
  }
}

/**
 * Switches to the alternate screen and returns the handle that switches back,
 * or `undefined` when this run is not one that may (see
 * {@link altScreenSupported}), in which case nothing at all is written.
 *
 * The returned handle's `leave` is registered on every terminating path
 * before this function returns, so the caller's own `finally` is belt to the
 * handlers' braces rather than the only thing standing between a crash and a
 * stranded terminal.
 */
export function enterAltScreen(
  options: AltScreenOptions = {},
): AltScreen | undefined {
  if (!altScreenSupported(options)) return undefined;

  const stdout = options.stdout ?? process.stdout;
  const proc = options.process ?? (process as unknown as ProcessLike);
  let active = true;

  const restore = (): void => {
    if (!active) return;
    active = false;
    writeQuietly(stdout, LEAVE_ALT_SCREEN);
  };

  const onExit = (): void => {
    restore();
  };

  /**
   * The screen goes back first so node's own report is printed onto the
   * terminal the user keeps, and then the default handling is put back and the
   * error re-thrown from a clean stack: with no listener left, node prints it
   * and exits exactly as it would have without this module.
   *
   * Shared by `uncaughtException` and `unhandledRejection` because the REPL is
   * asynchronous from end to end — a promise nobody awaited is the *likelier*
   * of the two crashes here, and node has ended the process on one since v15.
   * Registering for it costs the default report, so this hands that report
   * back rather than swallowing it.
   */
  const onCrash = (error: unknown): void => {
    detach();
    restore();
    proc.nextTick(() => {
      throw error;
    });
  };

  const signalHandlers = new Map<string, () => void>();
  for (const [name, number] of Object.entries(FATAL_SIGNALS)) {
    signalHandlers.set(name, () => {
      detach();
      restore();
      proc.exit(128 + number);
    });
  }

  /**
   * `SIGINT`, but only when nobody else is listening for it.
   *
   * The REPL owns Ctrl-C: on a terminal its raw-mode editor consumes the
   * keypress and no signal is ever delivered, and mid-turn it installs its
   * own handler to cancel the turn and carry on. Acting there would tear the
   * screen down under a session that is still running, so this handler stands
   * aside whenever another listener exists. When it is the only one, though,
   * the signal would have ended the process outright — without running `exit`
   * handlers — and that is the case worth catching: a Ctrl-C during startup,
   * or while a spawned `codex login` has the terminal.
   */
  const onSigint = (): void => {
    if (proc.listenerCount("SIGINT") > 1) return;
    detach();
    restore();
    proc.exit(130);
  };

  function detach(): void {
    proc.off("exit", onExit as (...args: never[]) => void);
    proc.off("uncaughtException", onCrash as (...args: never[]) => void);
    proc.off("unhandledRejection", onCrash as (...args: never[]) => void);
    proc.off("SIGINT", onSigint as (...args: never[]) => void);
    for (const [name, handler] of signalHandlers) {
      proc.off(name, handler as (...args: never[]) => void);
    }
  }

  proc.on("exit", onExit as (...args: never[]) => void);
  proc.on("uncaughtException", onCrash as (...args: never[]) => void);
  proc.on("unhandledRejection", onCrash as (...args: never[]) => void);
  proc.on("SIGINT", onSigint as (...args: never[]) => void);
  for (const [name, handler] of signalHandlers) {
    proc.on(name, handler as (...args: never[]) => void);
  }

  writeQuietly(stdout, ENTER_ALT_SCREEN);

  return {
    get active(): boolean {
      return active;
    },
    reenter(): void {
      if (!active) return;
      writeQuietly(stdout, ENTER_ALT_SCREEN);
    },
    leave(): void {
      if (!active) return;
      detach();
      restore();
    },
  };
}
