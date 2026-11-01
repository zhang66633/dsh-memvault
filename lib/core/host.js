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
import { registerMemoryTools } from './tools.js'

/** Default location of the in-plugin store. */
export const DEFAULT_CORE_DB = join(homedir(), '.dsh', 'memvault', 'memvault.db')

export function attachMemoryTools(ctx, {
  storePath = process.env.DSH_MEMVAULT_CORE_DB || DEFAULT_CORE_DB,
  defineTool,
  logger = null,
  embedder = null,
} = {}) {
  if (!ctx || typeof ctx.inject !== 'function') throw new Error('ctx.inject is required')
  if (typeof defineTool !== 'function') throw new Error('defineTool is required')

  return ctx.inject(['tools'], (toolCtx) => {
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
        dispose = registerMemoryTools(toolCtx, { store, defineTool, logger, embedder })
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
  })
}
