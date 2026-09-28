/**
 * dsh-memvault — the panel's data API (host side).
 *
 * The panel is a browser half, and a browser cannot read a SQLite file or the
 * extraction state file. So the host half exposes exactly two **exact** routes
 * and the browser half renders what they answer:
 *
 *   GET  /memvault/api/status    → what is injected right now + how extraction is doing
 *   POST /memvault/api/refresh   → drop the render cache and answer with the fresh status
 *
 * Route choice: `exact` beats the SPA fallback in `dsh-host-webserver`'s match
 * order (exact over the whole table, then longest prefix, then fallback), so
 * these land before the shell's index/`/api` handlers and need no cooperation
 * from them.
 *
 * Trust: unlike the `/api` bridge, a route registered here is **not** admitted
 * by `dsh-client-connection` — that gate only guards its own `/api` route and
 * the index exchange. This content is the user's own memory, so the handlers
 * apply the same request-trust rule the bridge documents (`api-request-trust`):
 * a loopback `Host`, an `Origin` that equals it when present, and no
 * `Sec-Fetch-Site: cross-site`. That defends DNS rebinding and a cross-site
 * browser fetch; it is not identity, and the server still binds loopback only.
 */

/** Exact route the panel reads. */
export const STATUS_PATH = '/memvault/api/status'

/** Exact route that forces a re-read (bypasses the render TTL). */
export const REFRESH_PATH = '/memvault/api/refresh'

/** Exact route the panel writes core blocks through. */
export const BLOCKS_PATH = '/memvault/api/blocks'

/** Exact route that extracts the pending windows now (the 立即抽取 button). */
export const FLUSH_PATH = '/memvault/api/flush'

/** Largest accepted JSON body; a core block is at most a few KiB. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Longest block value shipped to the browser. A block can hold more (MemVault's
 * per-block `value_limit` is advisory), so this only clamps what the panel
 * renders and the true length travels beside it as `chars`.
 *
 * Not to be confused with `blocks-write.js`'s `BLOCK_VALUE_MAX`, which is the cap
 * on what a write may send.
 */
export const BLOCK_VALUE_CLAMP = 2000

/**
 * Whether a request may read the panel.
 *
 * Mirrors the documented browser-trust rule: loopback authority, an `Origin`
 * that matches the `Host` when the browser sends one, and no cross-site
 * `Sec-Fetch-Site`. Anything else is refused with 403 — including a request
 * with no `Host` at all.
 *
 * @param headers - node `IncomingHttpHeaders` (or a plain object in tests).
 */
export function isTrustedRequest(headers = {}) {
  const host = String(headers.host ?? '').trim()
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return false
  const origin = headers.origin
  if (origin !== undefined && origin !== null && String(origin) !== `http://${host}`) return false
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
  return true
}

/** Write a JSON response. No-store: the panel always polls. */
export function sendJson(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

const clampValue = (value) => {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > BLOCK_VALUE_CLAMP ? `${text.slice(0, BLOCK_VALUE_CLAMP)}…` : text
}

/**
 * Shape the panel's payload.
 *
 * @param options.read - read-half config plus the cache facts (`cacheAgeMs`,
 *   `renderedChars`, `error`, `enabled`).
 * @param options.blocks - the blocks the last read returned.
 * @param options.extract - write-half config plus `sessions` and `diagnostics`.
 * @param options.at - ISO timestamp of this snapshot.
 * @param options.writable - whether the blocks route accepts writes; the panel
 *   renders itself read-only when it is false, instead of offering buttons that
 *   would answer 403.
 */
export function buildStatus({ read = {}, blocks = [], extract = {}, at = new Date().toISOString(), writable = true } = {}) {
  return {
    at,
    writable: writable !== false,
    read: {
      enabled: read.enabled !== false,
      name: read.name ?? 'memvault:core',
      order: read.order ?? null,
      dbPath: read.dbPath ?? '',
      scopes: (read.scopes ?? []).map((s) => `${s.type}/${s.id}`),
      labels: read.labels ?? [],
      maxChars: read.maxChars ?? null,
      refreshMs: read.refreshMs ?? null,
      cacheAgeMs: read.cacheAgeMs ?? null,
      renderedChars: read.renderedChars ?? 0,
      blockCount: blocks.length,
      error: read.error ?? null,
    },
    blocks: blocks.map((b) => ({
      scope: `${b.scopeType}/${b.scopeId}`,
      scopeType: b.scopeType,
      scopeId: b.scopeId,
      label: b.label,
      limit: b.limit ?? null,
      chars: typeof b.value === 'string' ? b.value.length : 0,
      value: clampValue(b.value),
    })),
    extract: {
      enabled: extract.enabled !== false,
      everyNTurns: extract.everyNTurns ?? null,
      endReasons: extract.endReasons ?? [],
      includeAssistant: extract.includeAssistant === true,
      includeTools: extract.includeTools === true,
      maxInputChars: extract.maxInputChars ?? null,
      minTranscriptChars: extract.minTranscriptChars ?? null,
      timeoutMs: extract.timeoutMs ?? null,
      user: extract.user ?? null,
      agent: extract.agent ?? null,
      run: extract.run ?? null,
      pythonPath: extract.pythonPath ?? '',
      projectDir: extract.projectDir ?? '',
      statePath: extract.statePath ?? '',
      sessions: extract.sessions ?? 0,
      diagnostics: extract.diagnostics ?? [],
      // The window policy and what is currently waiting in it: without this the
      // panel would show knobs but not whether anything is actually queued.
      window: {
        everyNTurns: extract.everyNTurns ?? null,
        idleMs: extract.idleMs ?? null,
        windowTurns: extract.windowTurns ?? null,
        pending: extract.pendingWindows ?? [],
      },
    },
  }
}

/**
 * Read and parse a JSON request body, bounded.
 *
 * Returns `{ body }`, `{ error }` or `{ tooLarge: true }`; never throws and never
 * leaves the request hanging.
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    if (typeof req?.on !== 'function') {
      resolve({ body: {} })
      return
    }
    let raw = ''
    let done = false
    const settle = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > maxBytes) {
        try { req.destroy?.() } catch { /* already gone */ }
        settle({ tooLarge: true })
      }
    })
    req.on('end', () => {
      if (raw.trim() === '') {
        settle({ body: {} })
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
          settle({ error: 'body must be a JSON object' })
          return
        }
        settle({ body: parsed })
      } catch {
        settle({ error: 'body is not valid JSON' })
      }
    })
    req.on('error', () => settle({ error: 'body read failed' }))
  })
}

/**
 * Wire the payload into node-http handlers.
 *
 * @param options.status - `() => payload`; must not throw.
 * @param options.refresh - `() => payload` after forcing a re-read.
 * @param options.writeBlock - `(input) => Promise<{ok, status, error?, action?, result?}>`;
 *   absent means the write route answers 405, so a composition can expose the
 *   panel read-only.
 * @param options.flush - `() => Promise<{flushed}> | {flushed}`; extracts every
 *   pending window now. Absent means the flush route answers 405.
 * @returns `{ status, refresh, blocks, flush }` handlers for `webServer.register`.
 */
export function createPanelApi({ status, refresh, writeBlock = null, flush = null }) {
  const guard = (req, res) => {
    if (!isTrustedRequest(req?.headers)) {
      sendJson(res, 403, { ok: false, error: 'untrusted request: loopback host, matching origin, same-site only' })
      return false
    }
    return true
  }
  const wrap = (fn, method) => async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== method) {
      sendJson(res, 405, { ok: false, error: `${method} only` })
      return
    }
    try {
      sendJson(res, 200, { ok: true, ...(await fn(req)) })
    } catch (error) {
      // A panel must never look like a broken memory bridge: report, do not throw.
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /**
   * The one write route. POST-only, trust-guarded, and gone entirely when the
   * plugin has no writer (config `panel.writes: false`).
   */
  const blocks = async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (!writeBlock) {
      sendJson(res, 403, { ok: false, error: 'writing is disabled (config panel.writes: false)' })
      return
    }
    const read = await readJsonBody(req)
    if (read.tooLarge) {
      sendJson(res, 413, { ok: false, error: `body is larger than ${MAX_BODY_BYTES} bytes` })
      return
    }
    if (read.error) {
      sendJson(res, 400, { ok: false, error: read.error })
      return
    }
    try {
      const out = await writeBlock(read.body)
      if (!out?.ok) {
        sendJson(res, out?.status ?? 502, { ok: false, error: String(out?.error ?? 'write failed') })
        return
      }
      sendJson(res, 200, { ok: true, action: out.action, result: out.result ?? null })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /**
   * Extract every pending window now.
   *
   * The work is queued, not awaited: a window can take a while (a Python process
   * plus an LLM call), and a panel does not need to hold the request open for it.
   * The answer says how many sessions were handed over; the panel refreshes to
   * show the outcomes as they land.
   */
  const flushNow = async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (!flush) {
      sendJson(res, 405, { ok: false, error: 'extraction is disabled (config extract.enabled: false)' })
      return
    }
    try {
      const out = await flush()
      sendJson(res, 200, { ok: true, flushed: out?.flushed ?? 0 })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  return {
    status: wrap(() => status(), 'GET'),
    refresh: wrap(() => refresh(), 'POST'),
    blocks,
    flush: flushNow,
  }
}
