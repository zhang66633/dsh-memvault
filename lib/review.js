/**
 * The review loop: what a window sent, what it produced, and how a human can ask
 * for it again.
 *
 * Three pieces of plugin state, all bounded, all in the same state file:
 *
 * 1. **retained inputs** — the transcript each extraction actually sent (the last
 *    few windows). Without it a "replay" is impossible: after an extraction the
 *    text used to be gone, leaving only counts. It is also the evidence a human
 *    edits when the extraction was bad *because the input was misread*.
 * 2. **the produced index** — `memoryId → the window that produced it`. The
 *    diagnostics only keep the last five windows, so without a reverse index the
 *    link from a stored memory back to its window would quietly expire.
 * 3. **replay validation** — the rules for asking for another pass.
 *
 * Replay goes through MemVault's **own** `add()` (the CLI), never around it: that
 * is what keeps ADD/UPDATE/DELETE decisions, the `history` audit and the
 * `relations` contradictions in one implementation. So a replay is "send this text
 * through the pipeline again", not "write these facts" — and the store may quite
 * correctly decide to add a paraphrase rather than replace the row a human
 * disliked. That is the trade the user chose: inherit MemVault's judgement, and
 * clean up paraphrase clusters with `consolidate` rather than with a private rule.
 */

/** How many extraction inputs are kept for replay; newest win. */
export const MAX_INPUTS = 5

/** Longest retained input; the plugin's own transcript budget is the real bound. */
export const INPUT_TEXT_CLAMP = 8000

/** How many produced-memory links are kept; newest win. */
export const MAX_PRODUCED_INDEX = 200

/** What `extractor` may say in a replay request. */
export const EXTRACTOR_CHOICES = ['inherit', 'rule', 'llm']

/** Most flagged memories one review listing resolves (each needs a provenance read). */
export const MAX_REVIEW_ITEMS = 50

const clamp = (value, max) => {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? text.slice(0, max) : text
}

/**
 * Keep one extraction input, newest first, bounded.
 *
 * @returns a new map (the input is never mutated).
 */
export function storeInput(inputs = {}, key, { text, seq = null, sessionId = null, turns = null, at = new Date().toISOString() } = {}) {
  if (typeof key !== 'string' || key === '') return pruneInputs(inputs)
  const next = { ...pruneInputs(inputs) }
  next[key] = {
    at,
    seq,
    sessionId,
    turns,
    chars: typeof text === 'string' ? text.length : 0,
    text: clamp(text, INPUT_TEXT_CLAMP),
  }
  return pruneInputs(next)
}

/** Drop anything malformed and keep the newest {@link MAX_INPUTS}. */
export function pruneInputs(inputs = {}) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {}
  const entries = []
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof key !== 'string' || key === '') continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (typeof value.text !== 'string' || value.text === '') continue
    entries.push([key, {
      at: typeof value.at === 'string' ? value.at : '',
      seq: value.seq ?? null,
      sessionId: value.sessionId ?? null,
      turns: value.turns ?? null,
      chars: typeof value.chars === 'number' ? value.chars : value.text.length,
      text: clamp(value.text, INPUT_TEXT_CLAMP),
    }])
  }
  entries.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
  return Object.fromEntries(entries.slice(0, MAX_INPUTS))
}

/**
 * Record which memories a window produced, so a stored memory can be traced back
 * to its window even after the diagnostic is gone.
 *
 * @returns a new map, newest first, capped.
 */
export function recordProduced(index = {}, entries = [], meta = {}) {
  const next = { ...pruneProduced(index) }
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = typeof entry?.id === 'string' ? entry.id : null
    if (id === null) continue
    next[id] = {
      at: meta.at ?? new Date().toISOString(),
      seq: meta.seq ?? null,
      sessionId: meta.sessionId ?? null,
      inputKey: meta.inputKey ?? null,
      ...(meta.replayOf ? { replayOf: meta.replayOf } : {}),
    }
  }
  return pruneProduced(next)
}

/** Drop anything malformed and keep the newest {@link MAX_PRODUCED_INDEX} links. */
export function pruneProduced(index = {}) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return {}
  const entries = []
  for (const [id, value] of Object.entries(index)) {
    if (typeof id !== 'string' || id === '') continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    entries.push([id, {
      at: typeof value.at === 'string' ? value.at : '',
      seq: value.seq ?? null,
      sessionId: value.sessionId ?? null,
      inputKey: value.inputKey ?? null,
      ...(value.replayOf ? { replayOf: value.replayOf } : {}),
    }])
  }
  entries.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
  return Object.fromEntries(entries.slice(0, MAX_PRODUCED_INDEX))
}

/**
 * Validate a replay request.
 *
 * The text defaults to the retained input (so "just run it again" is one click)
 * and may be edited (so "the extractor misread this sentence" is fixable). An
 * unknown key is a client error, not a silent no-op.
 *
 * @param input - `{ key, text?, extractor? }` from the request body.
 * @param options.inputs - retained inputs.
 * @param options.minTranscriptChars - the plugin's own floor, so a replay cannot
 *   undercut the guard the automatic path applies.
 * @returns `{ ok: true, key, text, extractor, env, entry }` or `{ ok: false, status, error }`.
 */
export function validateReplay(input = {}, { inputs = {}, minTranscriptChars = 1 } = {}) {
  const key = typeof input?.key === 'string' ? input.key.trim() : ''
  const stored = Object.hasOwn(inputs ?? {}, key) ? inputs[key] : null
  if (key === '' || stored === null) {
    return { ok: false, status: 404, error: 'unknown input key; the window may have been evicted (only the last few are kept)' }
  }

  const extractor = typeof input?.extractor === 'string' && input.extractor !== '' ? input.extractor : 'inherit'
  if (!EXTRACTOR_CHOICES.includes(extractor)) {
    return { ok: false, status: 400, error: `extractor must be one of ${EXTRACTOR_CHOICES.join(' | ')}` }
  }

  const text = input?.text === undefined || input?.text === null ? stored.text : String(input.text)
  if (text.length > INPUT_TEXT_CLAMP) {
    return { ok: false, status: 400, error: `text is ${text.length} characters; the limit is ${INPUT_TEXT_CLAMP}` }
  }
  if (text.replace(/\s/g, '').length < minTranscriptChars) {
    return { ok: false, status: 400, error: `text is below minTranscriptChars (${minTranscriptChars}); the pipeline would skip it` }
  }

  // `inherit` adds nothing: whatever the plugin config (and the project .env)
  // already selects stays selected. Forcing one is explicit.
  const env = extractor === 'inherit' ? {} : { MEMVAULT_EXTRACTOR: extractor }
  return { ok: true, key, text, extractor, env, entry: stored }
}

/**
 * One review-queue entry: the flagged memory, why it is flagged, where it came
 * from, and whether the window behind it can still be replayed.
 *
 * @param options.row - the shaped memory row (`memories.shapeMemoryRow`).
 * @param options.flag - `{ at, note }` from the flag map.
 * @param options.window - the produced-index entry for this id, if any.
 * @param options.provenance - `{ history, relations }` for this id.
 * @param options.replayable - whether that window's input is still retained.
 */
export function shapeReviewItem({ row, flag = null, window: producedBy = null, provenance = null, replayable = false } = {}) {
  return {
    ...row,
    flaggedAt: flag?.at ?? null,
    note: flag?.note ?? '',
    window: producedBy === null || producedBy === undefined ? null : {
      seq: producedBy.seq ?? null,
      sessionId: producedBy.sessionId ?? null,
      inputKey: producedBy.inputKey ?? null,
      at: producedBy.at ?? null,
      replayOf: producedBy.replayOf ?? null,
    },
    replayable: replayable === true,
    history: provenance?.history ?? [],
    relations: provenance?.relations ?? [],
  }
}

/**
 * The request a human hands to a model: the flagged memories with everything
 * needed to propose a fix.
 *
 * This is the plugin's half of the chosen flow — "the model proposes, the human
 * approves" — and it deliberately stays on this side of the line. The plugin does
 * not propose the fix and does not write it: it hands over the ids, the texts and
 * the provenance, and the model's own memory tools, behind DSH's approval, do any
 * editing.
 */
export function buildReviewRequest(items = [], { limit = MAX_REVIEW_ITEMS } = {}) {
  const usable = (Array.isArray(items) ? items : []).slice(0, limit)
  if (usable.length === 0) return ''
  const lines = [
    `MemVault 复核请求：下面 ${usable.length} 条记忆被标为待复核。请逐条判断该保留、改写还是删除，并给出理由；`,
    '改写时请给出替换后的完整文本。在我确认之前不要执行任何写操作。',
    '',
  ]
  usable.forEach((item, index) => {
    lines.push(`${index + 1}. id: ${item.id}`)
    lines.push(`   原文: ${item.memory}`)
    if (item.note) lines.push(`   我标记的理由: ${item.note}`)
    if (item.window) lines.push(`   来自: 窗口 @${item.window.seq ?? '?'}（${item.window.at ?? '未知时间'}）`)
    if (item.history?.length) lines.push(`   审计: ${item.history.map((entry) => entry.action ?? '?').join(' → ')}`)
    if (item.relations?.length) {
      lines.push(`   关联: ${item.relations.map((rel) => `${rel.direction === 'out' ? '→' : '←'}${String(rel.id).slice(0, 10)}`).join(' ')}`)
    }
  })
  return lines.join('\n')
}
