window.__ModuleLoader__.load({ id: "dsh-memvault", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
// generated from src/client/index.js by scripts/build-client.mjs — do not edit
// source-sha256: 6b4a8c08b26c4ec1
/**
 * dsh-memvault — browser half: the memory panel.
 *
 * This file is the **factory body** of the client bundle, not an ES module: the
 * DSH client module system materializes a bundle as
 * `window.__ModuleLoader__.load({ id, factory: (require) => …exports })`, i.e.
 * CommonJS inside a factory. `scripts/build-client.mjs` wraps this file in that
 * envelope; `lib/client.js` is the committed artifact (the host serves built
 * bundles, so it must exist before launch).
 *
 * Writing it by hand keeps the package at **zero dependencies**: everything this
 * panel imports is a platform module the shell already seeds (React), so no
 * bundler and no `node_modules` are involved.
 *
 * Surfaces: a tab in the conversation view ring (primary, visible while working)
 * and a page under Settings → Plugins (discoverability). Both read
 * `/memvault/api/status` from the host half and render the same component.
 *
 * @module dsh-memvault/client
 */
const { createElement: h, useEffect, useState } = require('react')

/** Must equal the package name: it is the bundle id the host serves under /plugins. */
const NAME = 'dsh-memvault'

const STATUS_URL = '/memvault/api/status'
const REFRESH_URL = '/memvault/api/refresh'
const POLL_MS = 15000

const C = {
  bg: 'var(--dsw-alias-bg-base, #ffffff)',
  layer1: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
  layer2: 'var(--dsw-alias-bg-layer-2, #eef0f4)',
  border: 'var(--dsw-alias-border-l1, #e3e6ec)',
  border2: 'var(--dsw-alias-border-l2, #ccd2dc)',
  fg: 'var(--dsw-alias-label-primary, #1b1f27)',
  muted: 'var(--dsw-alias-label-secondary, #667085)',
  brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
  ok: 'var(--dsw-alias-state-success-primary, #12805c)',
  warn: 'var(--dsw-alias-state-warn-primary, #b25e09)',
  err: 'var(--dsw-alias-state-error-primary, #c62d2d)',
  idle: 'var(--dsw-alias-state-idle-primary, #98a2b3)',
}

const S = {
  root: { height: '100%', overflow: 'auto', background: C.bg, color: C.fg, fontSize: '13px', lineHeight: 1.55 },
  wrap: { maxWidth: '960px', margin: '0 auto', padding: '18px 22px 40px' },
  bar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' },
  title: { fontSize: '15px', fontWeight: 600 },
  dot: (tone) => ({ width: '8px', height: '8px', borderRadius: '50%', background: tone, flex: '0 0 8px' }),
  hint: { color: C.muted, fontSize: '12px' },
  spacer: { flex: 1 },
  btn: (primary) => ({
    fontSize: '12px', padding: '4px 12px', borderRadius: '8px', cursor: 'pointer',
    border: `1px solid ${primary ? C.brand : C.border2}`,
    background: primary ? C.brand : 'transparent',
    color: primary ? '#fff' : C.fg,
  }),
  card: { border: `1px solid ${C.border}`, borderRadius: '10px', background: C.layer1, padding: '12px 14px', marginBottom: '14px' },
  cardTitle: { fontSize: '12px', fontWeight: 600, color: C.muted, letterSpacing: '.04em', textTransform: 'uppercase', marginBottom: '8px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '6px 18px' },
  kv: { display: 'flex', gap: '8px', alignItems: 'baseline', minWidth: 0 },
  k: { color: C.muted, fontSize: '12px', flex: '0 0 auto' },
  v: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
  block: { border: `1px solid ${C.border}`, borderRadius: '8px', background: C.bg, padding: '8px 10px', marginBottom: '8px' },
  blockHead: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: '4px' },
  tag: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11px', color: C.brand },
  badge: (tone) => ({ fontSize: '11px', padding: '0 6px', borderRadius: '6px', background: C.layer2, color: tone }),
  body: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12.5px' },
  diag: { display: 'grid', gridTemplateColumns: '150px 60px 70px 1fr', gap: '2px 10px', fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11.5px' },
  empty: { color: C.muted, fontSize: '12px' },
  banner: (tone) => ({
    border: `1px solid ${tone}`, borderRadius: '8px', padding: '8px 10px', marginBottom: '14px',
    color: tone, fontSize: '12px', background: C.layer1,
  }),
}

const outcomeTone = (outcome) => (String(outcome ?? '').startsWith('ok') ? C.ok
  : String(outcome ?? '').startsWith('skipped') ? C.idle : C.err)

function KV({ k, v, mono = true }) {
  return h('div', { style: S.kv },
    h('span', { style: S.k }, k),
    h('span', { style: mono ? S.v : undefined, title: typeof v === 'string' ? v : undefined }, v === null || v === undefined || v === '' ? '—' : String(v)),
  )
}

function Card({ title, children }) {
  return h('div', { style: S.card }, h('div', { style: S.cardTitle }, title), children)
}

function fmtAge(ms) {
  if (ms === null || ms === undefined) return '尚未读取'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60000) return `${Math.round(ms / 1000)} s`
  return `${Math.round(ms / 60000)} min`
}

function MemoryPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async (force) => {
    setBusy(true)
    try {
      const res = force
        ? await fetch(REFRESH_URL, { method: 'POST' })
        : await fetch(STATUS_URL)
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.ok !== true) {
        setError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
      } else {
        setError(null)
        setData(json)
      }
    } catch (err) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let alive = true
    const tick = () => { if (alive) load(false) }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const read = data?.read
  const extract = data?.extract
  const tone = error ? C.err : read?.error ? C.warn : C.ok
  const state = error ? '面板离线' : read?.error ? '读取失败（沿用上次注入）' : read?.enabled === false ? '注入已关闭' : '注入中'

  return h('div', { style: S.root },
    h('div', { style: S.wrap },
      h('div', { style: S.bar },
        h('span', { style: S.dot(tone) }),
        h('span', { style: S.title }, 'MemVault 记忆桥'),
        h('span', { style: S.hint }, state),
        h('span', { style: S.spacer }),
        h('span', { style: S.hint }, data?.at ? `快照 ${new Date(data.at).toLocaleTimeString()}` : ''),
        h('button', { style: S.btn(false), disabled: busy, onClick: () => load(false) }, busy ? '读取中…' : '刷新'),
        h('button', { style: S.btn(true), disabled: busy, onClick: () => load(true), title: '跳过 30 秒缓存，立刻重读核心块' }, '立即重读'),
      ),

      error && h('div', { style: S.banner(C.err) }, error),
      read?.error && h('div', { style: S.banner(C.warn) }, `读取 ${read.dbPath} 失败：${read.error} —— 继续注入上一次的好文本。`),

      h(Card, { title: '注入（读半边）' },
        h('div', { style: S.grid },
          h(KV, { k: '上下文名', v: read?.name }),
          h(KV, { k: 'order', v: read?.order }),
          h(KV, { k: '块数 / 字符', v: read ? `${read.blockCount} 块 · ${read.renderedChars} / ${read.maxChars} 字符` : '—' }),
          h(KV, { k: '缓存年龄', v: read ? `${fmtAge(read.cacheAgeMs)}（TTL ${Math.round((read.refreshMs ?? 0) / 1000)} s）` : '—' }),
          h(KV, { k: '作用域', v: read?.scopes?.join('  ') }),
          h(KV, { k: 'label 过滤', v: read?.labels?.length ? read.labels.join(', ') : '全部' }),
          h(KV, { k: '库文件', v: read?.dbPath }),
        ),
      ),

      h(Card, { title: `当前注入的块（${data?.blocks?.length ?? 0}）` },
        (data?.blocks?.length ?? 0) === 0
          ? h('div', { style: S.empty }, '没有块 —— 空贡献会被组装器丢弃，轨迹里也就不会出现这一条。用 MemVault 的 cli blocks-set 建块。')
          : data.blocks.map((b, i) => h('div', { key: `${b.scope}/${b.label}/${i}`, style: S.block },
              h('div', { style: S.blockHead },
                h('span', { style: S.tag }, `[${b.scope}/${b.label}]`),
                h('span', { style: S.badge(C.idle) }, `${b.chars} 字符`),
              ),
              h('div', { style: S.body }, b.value),
            )),
      ),

      h(Card, { title: '抽取（写半边）' },
        h('div', { style: S.grid },
          h(KV, { k: '状态', v: extract?.enabled === false ? '已关闭（只读）' : '开启' }),
          h(KV, { k: '每 N 回合', v: extract?.everyNTurns }),
          h(KV, { k: '接受的结束原因', v: extract?.endReasons?.join(' / ') }),
          h(KV, { k: '送助手/工具', v: `${extract?.includeAssistant ? '是' : '否'} / ${extract?.includeTools ? '是' : '否'}` }),
          h(KV, { k: '转写预算', v: extract ? `≤ ${extract.maxInputChars} 字符，< ${extract.minTranscriptChars} 跳过` : '—' }),
          h(KV, { k: '作用域', v: extract ? `user=${extract.user ?? '—'} agent=${extract.agent ?? '—'}` : '—' }),
          h(KV, { k: '解释器', v: extract?.pythonPath }),
          h(KV, { k: '水位会话数', v: extract?.sessions }),
          h(KV, { k: '状态文件', v: extract?.statePath }),
        ),
      ),

      h(Card, { title: `最近抽取（${extract?.diagnostics?.length ?? 0}）` },
        (extract?.diagnostics?.length ?? 0) === 0
          ? h('div', { style: S.empty }, '还没有记录。每完成 N 个回合写一条（ok / skipped / failed）。')
          : h('div', { style: S.diag },
              h('span', { style: { ...S.k, fontWeight: 600 } }, '时间'),
              h('span', { style: { ...S.k, fontWeight: 600 } }, '回合'),
              h('span', { style: { ...S.k, fontWeight: 600 } }, '字符'),
              h('span', { style: { ...S.k, fontWeight: 600 } }, '结果'),
              extract.diagnostics.flatMap((d, i) => [
                h('span', { key: `t${i}`, style: S.mono }, new Date(d.at).toLocaleString()),
                h('span', { key: `s${i}`, style: S.mono }, `@${d.seq}`),
                h('span', { key: `c${i}`, style: S.mono }, String(d.transcriptChars ?? '—')),
                h('span', { key: `o${i}`, style: { ...S.mono, color: outcomeTone(d.outcome) }, title: d.outcome }, d.outcome),
              ]),
            ),
      ),
    ),
  )
}

/**
 * Client plugin body: register the panel into the conversation view ring and the
 * Plugins settings section. Registrations ride the slot service's effect
 * wrapper, so unloading the plugin removes both.
 * @param ctx - client root context.
 */
function apply(ctx) {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'memvault',
    order: 30,
    label: () => '记忆',
  }, MemoryPanel))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'memvault',
    order: 30,
    label: () => 'MemVault 记忆桥',
  }, MemoryPanel))
}

module.exports = { name: NAME, inject: ['slots'], apply }

return module.exports; } });
//# sourceSHA256=6b4a8c08b26c4ec1
