/**
 * `memory_search` / `memory_add` as Host tools.
 *
 * The definitions are built as plain objects instead of importing
 * `@deepseek-ai/dsh-tools`: the registry only requires
 * `output: { schema, render }` and JSON-Schema `parameters` (read from the
 * installed 0.2.1-rc.5 implementation), so building them here keeps the
 * plugin's "no runtime dependencies" promise — and keeps this module loadable
 * by the plain-Node smoke tests.
 *
 * Parameters are JSON Schema, not the authoring DSL: `required` is an array on
 * the object, every object declares `additionalProperties` explicitly, and only
 * the types the runtime accepts (object/array/string/number/integer/boolean) are
 * used. `enum` is expressed in the description and validated in `execute`
 * because the tool layer should not be the only thing saying "user" is a kind.
 *
 * Registration is `ctx.tools.register(tool)`; the returned disposer belongs to
 * the plugin's effect. The tool layer never decides scope silently — an
 * unscoped call is an error the model can correct, not a memory filed under an
 * implicit identity.
 */
import { searchMemories } from './search.js'

export const MEMORY_TYPES = ['user', 'agent', 'procedural']

/** Model-facing JSON: one text block carrying the result object. */
export function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

const SEARCH_OUTPUT = {
  type: 'object',
  properties: {
    results: { type: 'array', items: { type: 'object', additionalProperties: true } },
    answerable: { type: 'boolean' },
    note: { type: 'string' },
  },
  additionalProperties: false,
}

const ADD_OUTPUT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    type: { type: 'string' },
  },
  additionalProperties: false,
}

const SCOPE_PROPERTIES = {
  user_id: { type: 'string', description: 'Scope: the human the memory belongs to.' },
  agent_id: { type: 'string', description: 'Scope: the project/agent the memory belongs to.' },
  run_id: { type: 'string', description: 'Scope: a single session, when the memory is run-specific.' },
}

const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to look for; concrete nouns work best.' },
    limit: { type: 'integer', description: 'How many memories to return (default 10).' },
    ...SCOPE_PROPERTIES,
  },
  required: ['query'],
  additionalProperties: false,
}

const ADD_PARAMETERS = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'One standalone statement, e.g. "用户偏好中文回答。".' },
    type: {
      type: 'string',
      description: 'Kind of memory: user | agent | procedural (default user).',
    },
    metadata: { type: 'object', additionalProperties: true, description: 'Free-form metadata object.' },
    ...SCOPE_PROPERTIES,
  },
  required: ['text'],
  additionalProperties: false,
}

function scopeOf(args) {
  return {
    userId: args.user_id ?? null,
    agentId: args.agent_id ?? null,
    runId: args.run_id ?? null,
  }
}

/** Build the two tool definitions against one store. */
export function buildMemoryTools(store, { embedder = null } = {}) {
  if (!store) throw new Error('store is required')

  const search = {
    name: 'memory_search',
    description: 'Retrieve long-term memories by keyword + vector similarity. '
      + 'Returns the closest memories; when nothing truly answers the question, `answerable` is false and `results` is empty.',
    parameters: SEARCH_PARAMETERS,
    output: jsonOutput(SEARCH_OUTPUT),
    async execute(args) {
      const out = searchMemories(store, args.query, {
        ...scopeOf(args),
        limit: args.limit ?? 10,
        embedder,
      })
      const results = out.answerable === false ? [] : out.results.map((row) => ({
        id: row.id,
        text: row.text,
        type: row.type,
        score: Math.round(row.score * 10_000) / 10_000,
        createdAt: row.createdAt,
      }))
      return { results, answerable: out.answerable !== false, note: out.note ?? '' }
    },
  }

  const add = {
    name: 'memory_add',
    description: 'Store one long-term memory verbatim. Use for a fact the automatic extraction would miss; '
      + 'scope (user_id / agent_id / run_id) is required so the memory is findable later.',
    parameters: ADD_PARAMETERS,
    output: jsonOutput(ADD_OUTPUT),
    async execute(args) {
      const scope = scopeOf(args)
      if (!scope.userId && !scope.agentId && !scope.runId) {
        throw new Error('memory_add requires a scope: at least one of user_id / agent_id / run_id')
      }
      if (args.type !== undefined && !MEMORY_TYPES.includes(args.type)) {
        throw new Error(`memory_add: unknown memory type ${JSON.stringify(args.type)} (user|agent|procedural)`)
      }
      const memory = store.addMemory({
        ...scope,
        text: args.text,
        type: args.type ?? 'user',
        metadata: args.metadata ?? {},
        origin: 'manual',
        actor: 'manual',
      })
      return { id: memory.id, text: memory.text, type: memory.type }
    },
  }

  return [search, add]
}

/** Register both tools on a tools service; returns one disposer for both. */
export function registerTools(tools, store, { logger = null } = {}) {
  if (!tools || typeof tools.register !== 'function') throw new Error('tools service is not available')
  const disposers = buildMemoryTools(store).map((tool) => tools.register(tool))
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch (error) {
        logger?.warn?.('dsh-memvault: failed to dispose a memory tool', error)
      }
    }
  }
}

/** Register on a context's `tools` service (the shape tests and apply use). */
export function registerMemoryTools(ctx, { store, logger = null } = {}) {
  return registerTools(ctx?.tools, store, { logger })
}
