/**
 * Core block writes on the in-plugin store (the panel's only write action).
 *
 * Validation is reused from `lib/blocks-write.js` unchanged — same limits and
 * the same "an empty value would be invisible" refusal. What changed is the
 * transport: no Python CLI, just an upsert on `blocks`, which is what the
 * prompt reader reads. The old comment argued a direct write would skip
 * MemVault's events and `value_limit`; with the store in-process there is no
 * event bus to skip, and the limit is written here.
 */
import { validateBlockAction } from '../blocks-write.js'

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
