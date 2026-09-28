/**
 * Async, windowed extraction.
 *
 * v0.2–0.4 extracted **one turn per call**: every Nth `turn/end` rendered that
 * single turn and spawned the CLI. That is both expensive (one Python process
 * plus one LLM call per extracted turn) and noisy — a single "yes, do it" turn
 * carries almost no signal, while a real session's three or four turns together
 * carry the actual decision.
 *
 * This module owns when to extract instead:
 *
 *   - finished turns accumulate in a per-session window;
 *   - reaching `everyNTurns` **arms an idle timer**: if the session stays quiet
 *     for `idleMs`, the window is handed over in the background — during a pause,
 *     not while the user is waiting for an answer;
 *   - a new turn before the timer fires re-arms it, so an active session keeps
 *     accumulating into one bigger, higher-signal call;
 *   - reaching `windowTurns` hands the window over immediately, so a session that
 *     never pauses still gets extracted and the window cannot grow without bound.
 *
 * Deliberately free of the harness: it takes plain objects, a `flush` callback and
 * injectable timers, so the whole policy is testable without DSH or a real clock.
 */

/** Defaults; see README for what each one does. */
export const DEFAULT_WINDOW = {
  /** Turns that must accumulate before an idle timer is armed. */
  everyNTurns: 3,
  /** Quiet time that hands the window over. */
  idleMs: 20_000,
  /** Hard cap: extract as soon as the window reaches this many turns. */
  windowTurns: 8,
}

/**
 * @param options.everyNTurns - minimum turns before extraction is considered.
 * @param options.windowTurns - maximum turns per extraction.
 * @param options.idleMs - quiet period that triggers a flush.
 * @param options.flush - `(sessionId, turns) => void`, called with the window.
 * @param options.setTimer/clearTimer - injectable timers (tests).
 */
export function createTurnWindow({
  everyNTurns = DEFAULT_WINDOW.everyNTurns,
  windowTurns = DEFAULT_WINDOW.windowTurns,
  idleMs = DEFAULT_WINDOW.idleMs,
  flush = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isInteger(everyNTurns) || everyNTurns < 1) throw new Error('everyNTurns must be a positive integer')
  if (!Number.isInteger(windowTurns) || windowTurns < 1) throw new Error('windowTurns must be a positive integer')
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new Error('idleMs must be a non-negative number')

  const sessions = new Map()
  const stateOf = (id) => {
    let state = sessions.get(id)
    if (state === undefined) {
      state = { turns: [], timer: null }
      sessions.set(id, state)
    }
    return state
  }
  const disarm = (state) => {
    if (state.timer !== null) {
      clearTimer(state.timer)
      state.timer = null
    }
  }
  const take = (id) => {
    const state = sessions.get(id)
    if (state === undefined || state.turns.length === 0) return []
    disarm(state)
    const turns = state.turns
    state.turns = []
    return turns
  }
  const run = (id) => {
    const turns = take(id)
    if (turns.length > 0) flush(id, turns)
    return turns.length
  }

  return {
    /**
     * Record one finished turn.
     *
     * @returns `{ action: 'waiting' | 'armed' | 'flushed', turns }` — the decision
     *   this push made, which the caller can log and the tests assert on.
     */
    push(id, turn) {
      const state = stateOf(id)
      state.turns.push(turn)
      const size = state.turns.length

      if (size >= windowTurns) {
        run(id)
        return { action: 'flushed', turns: size }
      }
      if (size >= everyNTurns) {
        // Re-arm: the clock measures quiet time *after the latest* turn.
        disarm(state)
        const timer = setTimer(() => {
          state.timer = null
          run(id)
        }, idleMs)
        // Never hold the process open just to wait for a quiet period.
        timer?.unref?.()
        state.timer = timer
        return { action: 'armed', turns: size }
      }
      return { action: 'waiting', turns: size }
    },

    /** Extract this session's window now (a manual flush). Returns how many turns went. */
    flushNow: run,

    /** Extract every window now. Returns the number of sessions flushed. */
    flushAll() {
      let flushed = 0
      for (const id of [...sessions.keys()]) {
        if (run(id) > 0) flushed += 1
      }
      return flushed
    },

    /** Turns waiting in one session's window. */
    pending(id) {
      return sessions.get(id)?.turns.length ?? 0
    },

    /** Read-only view of a window, for rendering and for persistence. */
    turns(id) {
      return sessions.get(id)?.turns ?? []
    },

    /** `[{ sessionId, turns }]` for every non-empty window, newest turn first. */
    pendingWindows() {
      return [...sessions.entries()]
        .filter(([, state]) => state.turns.length > 0)
        .map(([sessionId, state]) => ({
          sessionId,
          turns: state.turns.length,
          at: state.turns.at(-1)?.at ?? null,
        }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    },

    /** Drop every timer without extracting (plugin disposal). */
    dispose() {
      for (const state of sessions.values()) disarm(state)
      sessions.clear()
    },
  }
}
