/**
 * `memory_search` / `memory_add` as Host tools (M2).
 *
 * Shaped after the DSH first-party tool API: `defineTool({ name, description,
 * parameters, output, execute })`, where `output` renders the value for the
 * model. The real `defineTool` lives in `@deepseek-ai/dsh-tools` inside the
 * Harness runtime, so it is a parameter here: tests pass an identity function
 * and assert the contract this plugin owns (names, schemas, execution), while
 * the plugin passes the runtime's implementation.
 *
 * Registration is `ctx.tools.register(tool)`; the returned disposer belongs to
 * the plugin's effect. The tool layer never decides scope silently 鈥?an
 * unscoped call is an error the model can correct, not a memory filed under an
 * implicit identity.
 */
import { searchMemories } from './search.js'

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
    results: { type: 'array', items: { type: 'json' } },
    answerable: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['results'],
}

const ADD_OUTPUT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    type: { type: 'string' },
  },
  required: ['id'],
}

const SCOPE_PARAMS = {
  user_id: { type: 'string', description: 'Scope: the human the memory belongs to.' },
  agent_id: { type: 'string', description: 'Scope: the project/agent the memory belongs to.' },
  run_id: { type: 'string', description: 'Scope: a single session, when the memory is run-specific.' },
}

const SEARCH_PARAMS = {
  query: { type: 'string', required: true, description: 'What to look for; concrete nouns work best.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many memories to return (default 10).' },
  ...SCOPE_PARAMS,
}

const ADD_PARAMS = {
  text: { type: 'string', required: true, description: 'One standalone statement, e.g. "鐢ㄦ埛鍋忓ソ涓枃鍥炵瓟銆?.' },
  type: { type: 'string', enum: ['user', 'agent', 'procedural'], description: 'Kind of memory (default user).' },
  metadata: { type: 'json', description: 'Free-form metadata object.' },
  ...SCOPE_PARAMS,
}

function scopeOf(args) {
  return {
    userId: args.user_id ?? null,
    agentId: args.agent_id ?? null,
    runId: args.run_id ?? null,
  }
}

/** Build the two tool definitions against one store. */
export function buildMemoryTools(store, defineTool, { embedder = null } = {}) {
  if (!store) throw new Error('store is required')
  if (typeof defineTool !== 'function') throw new Error('defineTool is required')

  const search = defineTool({
    name: 'memory_search',
    description: 'Retrieve long-term memories by keyword + vector similarity. '
      + 'Returns the closest memories; when nothing truly answers the question, `answerable` is false and `results` is empty.',
    parameters: SEARCH_PARAMS,
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
      return { results, answerable: out.answerable === false ? false : true, note: out.note ?? '' }
    },
  })

  const add = defineTool({
    name: 'memory_add',
    description: 'Store one long-term memory verbatim. Use for a fact the automatic extraction would miss; '
      + 'scope (user_id / agent_id / run_id) is required so the memory is findable later.',
    parameters: ADD_PARAMS,
    output: jsonOutput(ADD_OUTPUT),
    async execute(args) {
      const scope = scopeOf(args)
      if (!scope.userId && !scope.agentId && !scope.runId) {
        throw new Error('memory_add requires a scope: at least one of user_id / agent_id / run_id')
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
  })

  return [search, add]
}

/** Register both tools and return one disposer for all of them. */
export function registerMemoryTools(ctx, { store, defineTool, logger = null } = {}) {
  const tools = ctx?.tools
  if (!tools || typeof tools.register !== 'function') throw new Error('ctx.tools is not available')
  const disposers = buildMemoryTools(store, defineTool).map((tool) => tools.register(tool))
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


