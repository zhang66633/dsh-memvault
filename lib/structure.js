/**
 * The structure view's data source: how the store is actually laid out.
 *
 * Three things this answers that a flat list cannot:
 *
 * 1. **Scopes are dimensions, not a partition.** One row carries `user_id` *and*
 *    `agent_id` *and* `run_id`; it is counted under each of them. A view that
 *    showed "the project's memories" as a separate pile would be lying about the
 *    model, so the counts here are per dimension value.
 * 2. **Which blocks are actually injected.** The store holds blocks; the plugin
 *    injects the ones in its configured scopes. The difference is invisible
 *    without putting them side by side.
 * 3. **The relation graph, as it is.** Contradiction edges with their weights,
 *    plus how many memories have no edge at all — the isolated ones are usually
 *    where a bad extraction hides.
 *
 * Read-only, bounded (edges/nodes capped), never selects `embedding`.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

/** Relations kept at most; newest/most-weighted first. */
export const MAX_STRUCTURE_EDGES = 120

/** Nodes drawn at most (a legible circle, not a hairball). */
export const MAX_STRUCTURE_NODES = 120

/** Memory text shipped per node. */
export const NODE_TEXT_CLAMP = 120

const clampText = (text, max = NODE_TEXT_CLAMP) => {
  const value = typeof text === 'string' ? text : ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

const emptyByType = () => ({ user: 0, agent: 0, procedural: 0 })

/**
 * @param options.dbPath - the store.
 * @param options.injectedScopes - `['user/lenovo', 'agent/x', …]` from the plugin's
 *   own config, so the view can mark blocks that never reach the prompt.
 * @param options.flags - the plugin's review marks (plugin state, not store state).
 * @param options.retypedCount - rows the store's type refinement moved.
 * @returns `{ totals, dimensions, graph, topRelations, sampled }` or throws if the
 *   store is unreadable (the route reports that instead of showing stale figures).
 */
export function buildStructure({
  dbPath,
  injectedScopes = [],
  flags = {},
  retypedCount = 0,
  maxEdges = MAX_STRUCTURE_EDGES,
  maxNodes = MAX_STRUCTURE_NODES,
} = {}) {
  // No store yet is a normal state, not an error: nothing has been written, so the
  // view says "not initialized" instead of failing. A store that *exists* but cannot
  // be read still throws — that one the panel should report.
  const blank = {
    initialized: false,
    totals: { memories: 0, byType: emptyByType(), flagged: Object.keys(flags).length, retyped: 0, blocks: 0, injectedBlocks: 0 },
    dimensions: [{ key: 'user', values: [] }, { key: 'agent', values: [] }, { key: 'run', values: [] }],
    graph: { nodes: [], edges: [], isolated: 0, totalNodes: 0, totalEdges: 0, sampled: false },
    topRelations: [],
  }
  if (!existsSync(dbPath)) return blank

  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
  try {
    // A store that exists but has no schema yet is a fresh install too: the panel
    // must say "nothing written yet" instead of surfacing a SQL error.
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
    if (!tables.has('memories')) return blank

    const injected = new Set(injectedScopes)
    const totals = { memories: 0, byType: emptyByType(), flagged: 0, retyped: retypedCount, blocks: 0, injectedBlocks: 0 }

    // ── counts per dimension value ───────────────────────────────────────────
    const dimensions = { user: new Map(), agent: new Map(), run: new Map() }
    for (const row of db.prepare(
      `SELECT COALESCE(user_id, '') AS u, COALESCE(agent_id, '') AS a, COALESCE(run_id, '') AS r,
              COALESCE(memory_type, '') AS t, COUNT(*) AS n
         FROM memories GROUP BY 1, 2, 3, 4`,
    ).all()) {
      totals.memories += row.n
      if (Object.hasOwn(totals.byType, row.t)) totals.byType[row.t] += row.n
      for (const [key, value] of [['user', row.u], ['agent', row.a], ['run', row.r]]) {
        if (value === '') continue
        const bucket = dimensions[key].get(value) ?? { id: value, memories: 0, byType: emptyByType(), blocks: [] }
        bucket.memories += row.n
        if (Object.hasOwn(bucket.byType, row.t)) bucket.byType[row.t] += row.n
        dimensions[key].set(value, bucket)
      }
    }

    // ── blocks, with a mark for the ones the plugin actually injects ─────────
    // Each table is checked separately: a store written by an older MemVault (or a
    // half-created one) can lack `blocks` or `relations`, and the view should draw
    // what exists rather than fail whole.
    const blockRows = tables.has('blocks')
      ? db.prepare(
        'SELECT scope_type, scope_id, label, value, value_limit FROM blocks ORDER BY scope_type, scope_id, position',
      ).all()
      : []
    for (const block of blockRows) {
      totals.blocks += 1
      const isInjected = injected.has(`${block.scope_type}/${block.scope_id}`)
      if (isInjected) totals.injectedBlocks += 1
      const bucket = dimensions[block.scope_type]?.get(block.scope_id)
        ?? { id: block.scope_id, memories: 0, byType: emptyByType(), blocks: [] }
      bucket.blocks.push({
        label: block.label,
        chars: (block.value ?? '').length,
        limit: block.value_limit,
        injected: isInjected,
      })
      dimensions[block.scope_type]?.set(block.scope_id, bucket)
    }

    // ── the relation graph ───────────────────────────────────────────────────
    const edges = tables.has('relations')
      ? db.prepare(
        'SELECT source_id AS source, target_id AS target, weight FROM relations ORDER BY weight DESC LIMIT ?',
      ).all(maxEdges)
      : []
    const nodeIds = [...new Set(edges.flatMap((edge) => [edge.source, edge.target]))]
    const nodes = new Map()
    if (nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => '?').join(', ')
      for (const row of db.prepare(
        `SELECT id, memory, memory_type, user_id, agent_id, metadata FROM memories WHERE id IN (${placeholders})`,
      ).all(...nodeIds)) {
        nodes.set(row.id, {
          id: row.id,
          type: row.memory_type ?? '?',
          chars: (row.memory ?? '').length,
          text: clampText(row.memory),
          user: row.user_id ?? null,
          agent: row.agent_id ?? null,
          flagged: Object.hasOwn(flags, row.id),
          // The same marker the browse view badges on: written by the store's own
          // type refinement, so the graph can show where a heuristic acted.
          retyped: row.metadata !== null && String(row.metadata).includes('"retyped_from"'),
          degree: 0,
        })
      }
    }
    const keptEdges = []
    for (const edge of edges) {
      const source = nodes.get(edge.source)
      const target = nodes.get(edge.target)
      // A deleted memory leaves its edges behind, so an edge can dangle: drop it
      // rather than draw a node that does not exist.
      if (source === undefined || target === undefined) continue
      source.degree += 1
      target.degree += 1
      keptEdges.push({ source: edge.source, target: edge.target, weight: edge.weight })
    }
    const allNodes = [...nodes.values()].sort((a, b) => b.degree - a.degree)
    const drawn = allNodes.slice(0, maxNodes)
    const drawnIds = new Set(drawn.map((node) => node.id))
    const drawnEdges = keptEdges.filter((edge) => drawnIds.has(edge.source) && drawnIds.has(edge.target))

    const isolated = tables.has('relations')
      ? db.prepare(
        `SELECT COUNT(*) AS n FROM memories m
          WHERE NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_id = m.id OR r.target_id = m.id)`,
      ).get()?.n ?? 0
      : totals.memories

    totals.flagged = Object.keys(flags).length

    return {
      totals,
      dimensions: Object.entries(dimensions).map(([key, values]) => ({
        key,
        values: [...values.values()].sort((a, b) => b.memories - a.memories),
      })),
      graph: {
        nodes: drawn,
        edges: drawnEdges,
        isolated,
        totalNodes: allNodes.length,
        totalEdges: keptEdges.length,
        sampled: allNodes.length > drawn.length || keptEdges.length > drawnEdges.length,
      },
      topRelations: drawnEdges.slice(0, 10).map((edge) => ({
        weight: edge.weight,
        a: { id: edge.source, text: nodes.get(edge.source).text },
        b: { id: edge.target, text: nodes.get(edge.target).text },
      })),
    }
  } finally {
    db.close()
  }
}
