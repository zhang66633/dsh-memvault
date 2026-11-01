/**
 * Host wiring for the memory tools: one store, opened only when the tool
 * service actually exists, closed when the plugin unloads.
 *
 * Why lazy: the store file is a new artifact on disk. Opening it during
 * `apply()` would create `~/.dsh/memvault/memvault.db` even for a headless
 * composition that never registers a tool. The `ctx.inject(['tools'], ...)`
 * callback only runs when the service is present, so the file appears exactly
 * when the capability does.
 *
 * A failure to open the store logs and returns; it must not take block
 * injection or extraction down with it.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CoreStore } from './store.js'
import { resolveEmbedder } from './env.js'
import { registerTools } from './tools.js'

/** Default location of the in-plugin store. */
export const DEFAULT_CORE_DB = join(homedir(), '.dsh', 'memvault', 'memvault.db')

export function attachMemoryTools(ctx, {
  storePath = process.env.DSH_MEMVAULT_CORE_DB || DEFAULT_CORE_DB,
  projectDir = '',
  logger = null,
  // Resolved the same way the Python engine resolved it: the project `.env`
  // selects the OpenAI-compatible endpoint when a key is present, otherwise the
  // offline hashing embedder keeps a fresh install working with no key.
  embedder = null,
} = {}) {
  if (!ctx || (typeof ctx.inject !== 'function' && typeof ctx.get !== 'function')) {
    throw new Error('ctx.inject or ctx.get is required')
  }
  const effectiveEmbedder = embedder ?? resolveEmbedder({ projectDir, dbPath: storePath })

  const attach = (toolCtx, tools) => {
    let store
    try {
      store = new CoreStore(storePath)
    } catch (error) {
      logger?.warn?.('dsh-memvault: could not open the memory store; tools stay off', error)
      return
    }
    toolCtx.effect(() => {
      let dispose = null
      try {
        dispose = registerTools(tools, store, { logger, embedder: effectiveEmbedder })
      } catch (error) {
        logger?.warn?.('dsh-memvault: memory tools could not be registered', error)
      }
      return () => {
        try {
          dispose?.()
        } finally {
          store.close()
        }
      }
    })
    logger?.info?.(`dsh-memvault: memory tools registered (${storePath})`)
  }

  // Two shapes are supported on purpose: a plain context exposes the service
  // through `get`, while an injected child context receives it as a property.
  // Checking `get` first keeps the common case synchronous and makes a missing
  // service a no-op instead of a pending injection that never fires.
  const direct = typeof ctx.get === 'function' ? ctx.get('tools') : null
  if (direct) {
    attach(ctx, direct)
    return () => {}
  }
  return ctx.inject(['tools'], (toolCtx) => attach(toolCtx, toolCtx.tools))
}
