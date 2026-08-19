import type { AgentEvent, EventSink } from "@agent/protocol";
import { render } from "ink";
import { createElement } from "react";
import { OrchestrationApp } from "./app.js";
import {
  finishTuiState,
  initialTuiState,
  reduceTuiEvent,
  type TuiInit,
  type TuiState,
} from "./model.js";

export interface TuiController {
  /** Feed the dashboard: hand this to the runtime as its event sink. */
  readonly sink: EventSink;
  /** Current state — handy for assertions and for a final non-TUI summary. */
  readonly state: TuiState;
  /** Marks the run finished and paints the outcome immediately. */
  finish(outcome: string): void;
  /** Flushes a last frame, tears ink down, clears every timer. */
  unmount(): Promise<void>;
}

export interface StartTuiOptions extends TuiInit {
  readonly stdout?: NodeJS.WriteStream;
  /** Injectable clock; only used for the elapsed-time display. */
  readonly clock?: () => number;
}

/** Coalescing window for event-driven repaints. */
const RENDER_INTERVAL_MS = 50;
/** How often the header's elapsed time is refreshed while idle. */
const TICK_INTERVAL_MS = 1000;

/**
 * Mounts the dashboard and returns the imperative handle the run driver uses.
 *
 * Every repaint goes through a trailing-edge 50ms window, so a burst of events
 * (a chatty worker loop) costs one frame rather than one frame per event; the
 * 1s tick keeps the elapsed clock moving when nothing is happening.
 */
export function startOrchestrationTui(init?: StartTuiOptions): TuiController {
  const clock = init?.clock ?? Date.now;
  let state = initialTuiState(init);
  let pending: ReturnType<typeof setTimeout> | undefined;
  let unmounted = false;

  const instance = render(
    createElement(OrchestrationApp, { state, now: clock() }),
    {
      ...(init?.stdout === undefined ? {} : { stdout: init.stdout }),
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  const paint = (): void => {
    if (unmounted) return;
    instance.rerender(createElement(OrchestrationApp, { state, now: clock() }));
  };

  const clearPending = (): void => {
    if (pending === undefined) return;
    clearTimeout(pending);
    pending = undefined;
  };

  const schedule = (): void => {
    if (unmounted || pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      paint();
    }, RENDER_INTERVAL_MS);
    unref(pending);
  };

  const tick = setInterval(paint, TICK_INTERVAL_MS);
  unref(tick);

  const sink: EventSink = {
    emit(event: AgentEvent): void {
      // The sink sits in the runtime's hot path: a rendering problem must
      // never become the run's problem.
      try {
        state = reduceTuiEvent(state, event);
        schedule();
      } catch {
        // ignored on purpose
      }
    },
  };

  return {
    sink,
    get state(): TuiState {
      return state;
    },
    finish(outcome: string): void {
      try {
        state = finishTuiState(state, outcome);
        clearPending();
        paint();
      } catch {
        // ignored on purpose
      }
    },
    async unmount(): Promise<void> {
      if (unmounted) return;
      clearPending();
      clearInterval(tick);
      paint();
      unmounted = true;
      // `waitUntilExit()` installs the resolver, so it has to be called before
      // `unmount()` — afterwards it would hand back a promise nothing settles.
      const exited = instance.waitUntilExit();
      instance.unmount();
      await exited;
    },
  };
}

/** Keeps dashboard timers from holding the process open. */
function unref(timer: unknown): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof (timer as { unref: unknown }).unref === "function"
  ) {
    (timer as { unref: () => void }).unref();
  }
}
