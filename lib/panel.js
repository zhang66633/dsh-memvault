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

/** Longest block value shipped to the browser; the full length is reported separately. */
export const BLOCK_VALUE_MAX = 2000

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
  return text.length > BLOCK_VALUE_MAX ? `${text.slice(0, BLOCK_VALUE_MAX)}…` : text
}

/**
 * Shape the panel's payload.
 *
 * @param options.read - read-half config plus the cache facts (`cacheAgeMs`,
 *   `renderedChars`, `error`, `enabled`).
 * @param options.blocks - the blocks the last read returned.
 * @param options.extract - write-half config plus `sessions` and `diagnostics`.
 * @param options.at - ISO timestamp of this snapshot.
 */
export function buildStatus({ read = {}, blocks = [], extract = {}, at = new Date().toISOString() } = {}) {
  return {
    at,
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
      label: b.label,
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
    },
  }
}

/**
 * Wire the payload into node-http handlers.
 *
 * @param options.status - `() => payload`; must not throw.
 * @param options.refresh - `() => payload` after forcing a re-read.
 * @returns `{ status, refresh }` handlers for `webServer.register`.
 */
export function createPanelApi({ status, refresh }) {
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
      sendJson(res, 200, { ok: true, ...(await fn()) })
    } catch (error) {
      // A panel must never look like a broken memory bridge: report, do not throw.
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }
  return {
    status: wrap(() => status(), 'GET'),
    refresh: wrap(() => refresh(), 'POST'),
  }
}
