/**
 * Write core memory blocks — the panel's only write action.
 *
 * Transport: the MemVault CLI (`blocks-set` / `blocks-delete`), same as turn
 * extraction and for the same reasons (see `cli.js`). The CLI is what owns the
 * semantics: `core_append` is an **upsert** keyed by `(scope_type, scope_id,
 * label)`, it emits `block.updated`, and it applies `value_limit`. A direct
 * SQLite write would skip the event and the limit.
 *
 * Blocks are cheap to write — no LLM call and no embedding, unlike memories — so
 * a panel button can do it synchronously.
 *
 * Validation is deliberately stricter than MemVault's in two places, because the
 * panel is a UI and a mistake there is a user-visible one:
 *
 *   - an empty value is refused: the reader skips empty values, so such a block
 *     would exist and never be injected — a silent no-op;
 *   - the value is capped at {@link BLOCK_VALUE_MAX}: the CLI takes the value as
 *     an **argv positional**, and argv has a length limit (32 KiB on Windows).
 */
import { runCli } from './cli.js'

/** Hard cap on a block value shipped as one argv element. */
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

/**
 * argv for `blocks-set`.
 *
 * `--` ends option parsing before the positionals, so a value that starts with a
 * dash (`-50%`, `--flag`) is still data rather than an unknown option.
 */
export function buildBlockSetArgs({ type, id, label, value, limit }) {
  const args = ['blocks-set', '--type', type, '--id', id]
  if (limit !== undefined) args.push('--limit', String(limit))
  args.push('--', label)
  if (value !== undefined && value !== '') args.push(value)
  return args
}

/** argv for `blocks-delete`. */
export function buildBlockDeleteArgs({ type, id, label }) {
  return ['blocks-delete', '--type', type, '--id', id, '--', label]
}

/**
 * Validate and run one block action against MemVault.
 *
 * @param options.config - CLI config (`pythonPath`, `projectDir`, `env`, `timeoutMs`).
 * @param options.input - the raw request body.
 * @returns `{ ok, status, error? , action?, result? }`; `status` is the HTTP code
 *   the route should answer with (400 for a bad request, 502 for a CLI failure).
 */
export async function runBlockAction({ config, input, spawn }) {
  const valid = validateBlockAction(input)
  if (!valid.ok) return { ok: false, status: 400, error: valid.error }

  const args = valid.action === 'set' ? buildBlockSetArgs(valid) : buildBlockDeleteArgs(valid)
  const result = await runCli({ config, args, ...(spawn ? { spawn } : {}) })
  if (!result.ok) return { ok: false, status: 502, error: result.error }

  let parsed = null
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    // The CLI prints JSON on success; if a future version does not, the write
    // still happened and the panel refreshes from the store anyway.
    parsed = null
  }
  return { ok: true, status: 200, action: valid.action, result: parsed }
}
