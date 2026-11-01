/**
 * Host wiring: the store opens only with the tools service and closes on unload.
 *
 * The fake ctx executes effects the way Cordis does — immediately, keeping the
 * returned disposer — because a fake that only stored the function would hide
 * the one bug this file exists to catch (tools never registered).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attachMemoryTools } from '../lib/core/host.js'

const identity = (options) => options

function fakeContext() {
  const state = { injected: [], cleanup: null, disposers: [], registered: [] }
  const ctx = {
    inject(services, callback) {
      state.injected.push(services)
      callback({
        tools: {
          register(tool) {
            state.registered.push(tool.name)
            return () => state.disposers.push(tool.name)
          },
        },
        effect(fn) {
          state.cleanup = fn()
        },
      })
      return () => {}
    },
  }
  return { ctx, state }
}

/** Dispose the store before removing the directory: Windows locks the file. */
function tempDir(t, state) {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-host-'))
  t.after(() => {
    try {
      state?.cleanup?.()
    } catch {
      // The store may already be closed by the test itself.
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('registers memory_search and memory_add when the tool service exists', (t) => {
  const { ctx, state } = fakeContext()
  const dir = tempDir(t, state)
  const warnings = []
  attachMemoryTools(ctx, {
    storePath: join(dir, 'core.db'),
    defineTool: identity,
    logger: { warn: (...args) => warnings.push(args), info: () => {} },
  })
  assert.deepEqual(state.injected, [['tools']])
  assert.deepEqual(state.registered, ['memory_search', 'memory_add'])
  assert.equal(typeof state.cleanup, 'function')
  assert.deepEqual(warnings, [])
})

test('the effect disposer unregisters the tools', (t) => {
  const { ctx, state } = fakeContext()
  const dir = tempDir(t, state)
  attachMemoryTools(ctx, { storePath: join(dir, 'core.db'), defineTool: identity })
  state.cleanup()
  assert.deepEqual(state.disposers, ['memory_search', 'memory_add'])
})

test('a store that cannot be opened logs instead of throwing', (t) => {
  const { ctx, state } = fakeContext()
  const dir = tempDir(t, state)
  // A file where a directory would have to be: mkdir fails inside the store.
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, '')
  const warnings = []
  attachMemoryTools(ctx, {
    storePath: join(blocker, 'nested', 'core.db'),
    defineTool: identity,
    logger: { warn: (...args) => warnings.push(args), info: () => {} },
  })
  assert.equal(state.registered.length, 0)
  assert.equal(warnings.length, 1)
})
