/**
 * Core block writes on the in-plugin store (the panel's only write action).
 *
 * Validation lives here now that the Python transport is gone: same limits and
 * the same "an empty value would be invisible" refusal, but no argv builders —
 * there is no CLI to feed. The write is an upsert on `blocks`, which is what the
 * prompt reader reads; the old comment argued a direct write would skip
 * MemVault's events and `value_limit`, and with the store in-process there is no
 * event bus to skip and the limit is written here.
 */

/** Hard cap on a block value. */
export const BLOCK_VALUE_MAX = 8000

/** Hard cap on a block label. */
export const BLOCK_LABEL_MAX = 120

/** Accepted actions. */
export const BLOCK_ACTIONS = ['set', 'delete']

/**
 * Validate a panel write request.
 *
 * @returns `{ ok: true, action, type, id, label, value, limit }` or
 *   `{ ok: false, error }`. Never throws.
 */
export function validateBlockAction(input = {}) {
  const action = String(input?.action ?? '').trim()
  if (!BLOCK_ACTIONS.includes(action)) return { ok: false, error: `action must be one of ${BLOCK_ACTIONS.join(' | ')}` }

  const type = String(input?.type ?? '').trim()
  if (type !== 'user' && type !== 'agent') return { ok: false, error: 'type must be user or agent' }

  const id = String(input?.id ?? '').trim()
  if (id === '') return { ok: false, error: 'id is required' }
  if (id.length > 200) return { ok: false, error: 'id is longer than 200 characters' }

  const label = String(input?.label ?? '').trim()
  if (label === '') return { ok: false, error: 'label is required' }
  if (label.length > BLOCK_LABEL_MAX) return { ok: false, error: `label is longer than ${BLOCK_LABEL_MAX} characters` }
  if (/[\r\n]/.test(label)) return { ok: false, error: 'label must be a single line' }

  const value = input?.value === undefined || input?.value === null ? '' : String(input.value)
  if (value.length > BLOCK_VALUE_MAX) {
    return { ok: false, error: `value is ${value.length} characters; the panel limit is ${BLOCK_VALUE_MAX}` }
  }

  let limit
  if (input?.limit !== undefined && input?.limit !== null && input?.limit !== '') {
    limit = Number(input.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
      return { ok: false, error: 'limit must be a positive integer' }
    }
  }

  if (action === 'delete') {
    if (value !== '') return { ok: false, error: 'delete takes no value' }
    return { ok: true, action, type, id, label, value: '', limit: undefined }
  }
  if (value.trim() === '') {
    return { ok: false, error: 'value is required: the prompt reader skips empty blocks, so an empty write would be invisible' }
  }
  return { ok: true, action, type, id, label, value, limit }
}

export async function runBlockActionCore({ store, input } = {}) {
  const valid = validateBlockAction(input)
  if (!valid.ok) return { ok: false, status: 400, error: valid.error }

  if (valid.action === 'delete') {
    store.db.prepare(
      'DELETE FROM blocks WHERE scope_type = ? AND scope_id = ? AND label = ?',
    ).run(valid.type, valid.id, valid.label)
    return { ok: true, status: 200, action: 'delete', result: { deleted: true } }
  }

  const block = store.setBlock({
    scopeType: valid.type,
    scopeId: valid.id,
    label: valid.label,
    value: valid.value,
    valueLimit: valid.limit ?? 2000,
  })
  return { ok: true, status: 200, action: 'set', result: block }
}
