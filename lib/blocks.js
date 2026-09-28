/**
 * Read MemVault's core memory blocks, with no dependency on the MemVault
 * service being up.
 *
 * Transport choice: a **direct read-only SQLite read** via Node's built-in
 * `node:sqlite` (Node >= 22.5). The alternatives were worse for a prompt
 * injector that must answer synchronously on every assemble:
 *
 *   - HTTP REST (`/api/v1/blocks`) needs the FastAPI server running on 8780;
 *     if it is down the prompt silently loses memory.
 *   - spawning the Python CLI costs ~200-300 ms per refresh and needs a
 *     process spawn per turn.
 *   - `node:sqlite` costs ~1 ms, needs no server, no subprocess and no
 *     third-party dependency.
 *
 * The store is shared with the MemVault server and MCP clients, but this only
 * ever SELECTs, and SQLite handles concurrent readers fine.
 */
import { DatabaseSync } from 'node:sqlite'

/** Default store; matches MEMVAULT_DB_PATH in the MemVault project .env. */
export const DEFAULT_DB_PATH = process.env.MEMVAULT_DB_PATH ?? 'D:/Claude_code/memory/data/memvault.db'

/**
 * Which blocks to inject. MemVault keys blocks by `(scope_type, scope_id)`
 * (`scope_type` is `user` or `agent`), so both halves must be given explicitly —
 * there is no "current scope" in a foreign process.
 */
export const DEFAULT_SCOPES = [
  { type: 'user', id: 'lenovo' },
  { type: 'agent', id: 'claude-code-memory' },
]

/**
 * Read the configured blocks in `position` order.
 *
 * @param {object} options
 * @param {string} [options.dbPath] - path to memvault.db.
 * @param {Array<{type: string, id: string}>} [options.scopes] - scope pairs.
 * @param {string[]} [options.labels] - only these labels (empty/absent = all).
 * @returns {Array<{scopeType: string, scopeId: string, label: string, value: string}>}
 */
export function readCoreBlocks({ dbPath = DEFAULT_DB_PATH, scopes = DEFAULT_SCOPES, labels = [] } = {}) {
  const wanted = scopes.filter((s) => s && s.type && s.id)
  if (wanted.length === 0) return []

  // `timeout` is a busy timeout (Node docs: `new DatabaseSync(path, { timeout })`,
  // added v24.0.0), not an HTTP-style one. The store is shared with the MemVault
  // server and other clients, so a read landing while someone writes should wait
  // instead of surfacing SQLITE_BUSY to the prompt assembler.
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
  try {
    const wantedLabels = new Set(labels)
    const out = []
    for (const scope of wanted) {
      const rows = db.prepare(
        'SELECT label, value, value_limit FROM blocks WHERE scope_type = ? AND scope_id = ? ORDER BY position',
      ).all(scope.type, scope.id)
      for (const row of rows) {
        const value = typeof row.value === 'string' ? row.value.trim() : ''
        if (value.length === 0) continue
        if (wantedLabels.size > 0 && !wantedLabels.has(row.label)) continue
        out.push({
          scopeType: scope.type,
          scopeId: scope.id,
          label: row.label,
          value,
          // Advisory, and shown by the panel: MemVault stores it per block
          // (default 2000) and does not truncate to it.
          limit: typeof row.value_limit === 'number' ? row.value_limit : null,
        })
      }
    }
    return out
  } finally {
    db.close()
  }
}

/**
 * Render blocks as prompt text, capped at `maxChars`.
 *
 * Returns '' when there is nothing to say: an empty contribution is dropped by
 * the assembler, which is what we want (no header noise on an empty store).
 *
 * Budget contract: `maxChars` bounds the **whole returned string**. Space for the
 * omission note is reserved up front, so appending a note can never push the
 * result over budget. The header is always emitted — without it the lines are
 * unattributable — so a `maxChars` smaller than the header yields the header
 * alone (the documented floor; callers should pass a real budget).
 *
 * @param {Array} blocks - output of {@link readCoreBlocks}.
 * @param {object} [options]
 * @param {number} [options.maxChars] - budget for the whole rendered string.
 * @param {string} [options.header] - first line.
 */
export function formatCoreBlocks(blocks, {
  maxChars = 4000,
  header = 'MemVault core memory (persistent facts about the user and this agent; already loaded — no need to call a tool to read them):',
} = {}) {
  if (!blocks || blocks.length === 0) return ''

  // Reserved for "(N more block(s) omitted to stay within M chars)".
  const NOTE_RESERVE = 90
  const budget = maxChars - header.length - NOTE_RESERVE

  const lines = [header]
  let used = 0
  let dropped = 0
  for (const b of blocks) {
    const line = `- [${b.scopeType}/${b.scopeId}/${b.label}] ${b.value}`
    if (used + line.length + 1 > budget) { dropped += 1; continue }
    lines.push(line)
    used += line.length + 1
  }
  if (dropped > 0) {
    const note = `(${dropped} more block(s) omitted to stay within ${maxChars} chars)`
    // Only emit the note if the whole string still fits: the invariant is
    // "output <= maxChars whenever maxChars >= header length".
    if (header.length + used + note.length + 1 <= maxChars) lines.push(note)
  }
  return lines.join('\n')
}
