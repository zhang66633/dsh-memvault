/**
 * Review flags — the panel's own judgement about a stored memory.
 *
 * This is the "quality feedback" half of the panel, and the sharpest design
 * decision in it: a flag is **plugin state, not store state**. Nothing is written
 * to MemVault. That keeps the panel's promise ("it never modifies your memories")
 * while still recording the one thing only a human can supply — "this extracted
 * fact is wrong".
 *
 * What that buys: a durable, bounded list of memories worth revisiting, visible
 * and filterable in the browse view, and exportable later (a future refine/replay
 * pass can act on it). What it deliberately does not do: delete or rewrite
 * anything. Those stay with `memory_delete` / `memory_update` / the CLI.
 *
 * Flags live in the same state file as the watermarks and diagnostics, so they
 * need the same discipline: a bounded map, newest kept, atomic write.
 */

/** Most flags kept; the oldest are evicted so the state file cannot grow forever. */
export const MAX_FLAGS = 200

/** Longest note kept per flag. */
export const NOTE_CLAMP = 300

/**
 * Normalise a stored flags object: drop anything malformed, keep the newest
 * {@link MAX_FLAGS} by timestamp. Never throws — a hand-edited state file must not
 * stop the plugin.
 */
export function normalizeFlags(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries = []
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || id === '') continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const at = typeof value.at === 'string' ? value.at : ''
    const note = typeof value.note === 'string' ? value.note.slice(0, NOTE_CLAMP) : ''
    entries.push([id, { at, note }])
  }
  entries.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
  return Object.fromEntries(entries.slice(0, MAX_FLAGS))
}

/**
 * Set or clear one flag and return a new map (never mutates the input).
 *
 * @param flags - current flags (see {@link normalizeFlags}).
 * @param id - memory id.
 * @param flagged - `true` marks it, `false` clears it.
 * @param options.note - free text, clamped.
 * @param options.at - ISO timestamp; defaults to now.
 */
export function setFlag(flags, id, flagged, { note = '', at = new Date().toISOString() } = {}) {
  const next = { ...normalizeFlags(flags) }
  if (typeof id !== 'string' || id === '') return next
  if (flagged === true) {
    next[id] = { at, note: String(note).slice(0, NOTE_CLAMP) }
  } else {
    delete next[id]
  }
  return normalizeFlags(next)
}

/** Ids marked for review, newest first. */
export function flaggedIds(flags) {
  return Object.keys(normalizeFlags(flags))
}
