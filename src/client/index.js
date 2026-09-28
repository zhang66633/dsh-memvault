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
const { createElement: h, Fragment, useEffect, useState } = require('react')

/** Must equal the package name: it is the bundle id the host serves under /plugins. */
const NAME = 'dsh-memvault'

const STATUS_URL = '/memvault/api/status'
const REFRESH_URL = '/memvault/api/refresh'
const BLOCKS_URL = '/memvault/api/blocks'
const FLUSH_URL = '/memvault/api/flush'
const MEMORIES_URL = '/memvault/api/memories'
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
  editor: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' },
  textarea: {
    width: '100%', boxSizing: 'border-box', minHeight: '72px', resize: 'vertical',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px',
    padding: '6px 8px', borderRadius: '6px', border: `1px solid ${C.border2}`,
    background: C.bg, color: C.fg,
  },
  input: {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px',
    padding: '4px 8px', borderRadius: '6px', border: `1px solid ${C.border2}`,
    background: C.bg, color: C.fg,
  },
  rowActions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  small: (tone, filled) => ({
    fontSize: '11.5px', padding: '3px 10px', borderRadius: '7px', cursor: 'pointer',
    border: `1px solid ${tone}`, background: filled ? tone : 'transparent',
    color: filled ? '#fff' : tone,
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

/** One core block, with inline editing when the panel is allowed to write. */
function BlockRow({ block, writable, busy, onWrite }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(block.value)
  const over = block.limit ? block.chars > block.limit : false

  const save = async () => {
    const done = await onWrite({
      action: 'set', type: block.scopeType, id: block.scopeId, label: block.label, value: text,
    })
    if (done) setEditing(false)
  }
  const remove = async () => {
    if (!window.confirm(`删除核心块 ${block.scope}/${block.label}？\n\n这会把该块从库里删掉，下一步起不再注入。`)) return
    await onWrite({ action: 'delete', type: block.scopeType, id: block.scopeId, label: block.label })
  }

  return h('div', { style: S.block },
    h('div', { style: S.blockHead },
      h('span', { style: S.tag }, `[${block.scope}/${block.label}]`),
      h('span', { style: S.badge(over ? C.warn : C.idle) },
        `${block.chars}${block.limit ? ` / ${block.limit}` : ''} 字符`),
      over && h('span', { style: S.badge(C.warn) }, '超出建议上限'),
      writable && !editing && h('span', { style: S.spacer }),
      writable && !editing && h('button', { style: S.small(C.muted), disabled: busy, onClick: () => { setText(block.value); setEditing(true) } }, '编辑'),
      writable && !editing && h('button', { style: S.small(C.err), disabled: busy, onClick: remove }, '删除'),
    ),
    editing
      ? h('div', { style: S.editor },
          h('textarea', {
            style: S.textarea, value: text, spellCheck: false,
            onChange: (e) => setText(e.target.value),
          }),
          h('div', { style: S.rowActions },
            h('button', { style: S.small(C.brand, true), disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            h('button', { style: S.small(C.muted), disabled: busy, onClick: () => setEditing(false) }, '取消'),
            h('span', { style: S.hint }, `写回 ${block.scope}/${block.label}（upsert），改完下一次 assemble 立刻生效`),
          ),
        )
      : h('div', { style: S.body }, block.value),
  )
}

/** Create-or-replace form; appended under the block list. */
function AddBlock({ writable, busy, onWrite, defaults }) {
  const [open, setOpen] = useState(false)
  const [scopeType, setScopeType] = useState(defaults.scopeType)
  const [scopeId, setScopeId] = useState(defaults.scopeId)
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')

  if (!writable) return null
  if (!open) {
    return h('button', { style: S.small(C.brand), onClick: () => setOpen(true) }, '+ 新增核心块')
  }
  const submit = async () => {
    const done = await onWrite({ action: 'set', type: scopeType, id: scopeId, label, value: text })
    if (done) { setLabel(''); setText(''); setOpen(false) }
  }
  return h('div', { style: { ...S.block, borderStyle: 'dashed' } },
    h('div', { style: S.rowActions },
      h('select', { style: S.input, value: scopeType, onChange: (e) => setScopeType(e.target.value) },
        h('option', { value: 'user' }, 'user'),
        h('option', { value: 'agent' }, 'agent'),
      ),
      h('input', { style: { ...S.input, width: '160px' }, value: scopeId, placeholder: 'scope id', onChange: (e) => setScopeId(e.target.value) }),
      h('input', { style: { ...S.input, width: '140px' }, value: label, placeholder: 'label', onChange: (e) => setLabel(e.target.value) }),
    ),
    h('div', { style: S.editor },
      h('textarea', { style: S.textarea, value: text, spellCheck: false, placeholder: '块的内容（会进入 system prompt）', onChange: (e) => setText(e.target.value) }),
      h('div', { style: S.rowActions },
        h('button', { style: S.small(C.brand, true), disabled: busy, onClick: submit }, busy ? '写入中…' : '新增 / 覆盖'),
        h('button', { style: S.small(C.muted), disabled: busy, onClick: () => setOpen(false) }, '取消'),
      ),
    ),
  )
}

const TYPE_LABEL = { user: '用户', agent: '智能体', procedural: '程序性' }
const PAGE_SIZES = [10, 20, 50, 100]

/** Copy a memory id, so it can be handed to a tool call without selecting text. */
function CopyId({ id }) {
  const [copied, setCopied] = useState(false)
  return h('button', {
    style: S.small(copied ? C.ok : C.muted),
    title: id,
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(id)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      } catch { /* clipboard refused; the title still shows the id */ }
    },
  }, copied ? '已复制' : '复制 id')
}

function MemoryRow({ row }) {
  const meta = [
    row.user ? `user=${row.user}` : null,
    row.agent ? `agent=${row.agent}` : null,
    row.run ? `run=${row.run}` : null,
    row.updatedAt ? `更新 ${new Date(row.updatedAt).toLocaleString()}` : null,
  ].filter(Boolean).join('  ·  ')
  return h('div', { style: S.block },
    h('div', { style: S.blockHead },
      h('span', { style: S.badge(C.idle) }, TYPE_LABEL[row.type] ?? row.type ?? '?'),
      h('span', { style: S.mono, title: row.id }, `${String(row.id).slice(0, 12)}…`),
      h('span', { style: S.badge(C.idle) }, `${row.chars} 字符`),
      h('span', { style: S.spacer }),
      h(CopyId, { id: row.id }),
    ),
    h('div', { style: S.body }, row.memory),
    h('div', { style: { ...S.hint, marginTop: '4px' } }, meta),
    row.metadata && h('div', { style: { ...S.mono, color: C.muted, marginTop: '4px' } },
      JSON.stringify(row.metadata)),
  )
}

/**
 * The stored-memory browser.
 *
 * Deliberately a substring browse over `memories.memory`, not ranked retrieval:
 * semantic search is the model's `memory_search` (it needs the embedder), and a
 * panel that polled it would cost a retrieval per refresh. The label says so.
 */
function MemoriesView({ onError }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState({ q: '', type: '', limit: 20, offset: 0 })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    const params = new URLSearchParams()
    if (query.q) params.set('q', query.q)
    if (query.type) params.set('type', query.type)
    params.set('limit', String(query.limit))
    params.set('offset', String(query.offset))
    setLoading(true)
    fetch(`${MEMORIES_URL}?${params}`)
      .then(async (res) => ({ res, json: await res.json().catch(() => null) }))
      .then(({ res, json }) => {
        if (!alive) return
        if (!res.ok || json?.ok !== true) setError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
        else { setError(null); setData(json) }
      })
      .catch((err) => { if (alive) setError(String(err?.message ?? err)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [query])

  useEffect(() => { if (error) onError?.(error) }, [error, onError])

  const submit = (event) => {
    event?.preventDefault?.()
    setQuery((current) => ({ ...current, q: draft, offset: 0 }))
  }
  const total = data?.total ?? 0
  const from = total === 0 ? 0 : (data?.offset ?? 0) + 1
  const to = Math.min(total, (data?.offset ?? 0) + (data?.rows?.length ?? 0))

  return h(Fragment, null,
    h(Card, { title: '浏览已存的记忆（只读）' },
      h('form', { style: { ...S.rowActions, marginBottom: '10px' }, onSubmit: submit },
        h('input', {
          style: { ...S.input, flex: 1, minWidth: '180px' },
          value: draft, placeholder: '子串匹配（不是语义检索）',
          onChange: (e) => setDraft(e.target.value),
        }),
        h('select', {
          style: S.input, value: query.type,
          onChange: (e) => setQuery((c) => ({ ...c, type: e.target.value, offset: 0 })),
        },
          h('option', { value: '' }, '全部类型'),
          ...Object.entries(TYPE_LABEL).map(([value, label]) => h('option', { key: value, value }, label)),
        ),
        h('select', {
          style: S.input, value: String(query.limit),
          onChange: (e) => setQuery((c) => ({ ...c, limit: Number(e.target.value), offset: 0 })),
        }, ...PAGE_SIZES.map((size) => h('option', { key: size, value: String(size) }, `每页 ${size}`))),
        h('button', { type: 'submit', style: S.small(C.brand, true), disabled: loading }, loading ? '查询中…' : '查询'),
      ),
      h('div', { style: S.hint },
        `共 ${total} 条${total > 0 ? ` · 显示第 ${from}–${to} 条` : ''} · 子串匹配（非语义检索；语义召回请让模型调 memory_search）`),
    ),
    error && h('div', { style: S.banner(C.err) }, `读取记忆失败：${error}`),
    !error && (data?.rows?.length ?? 0) === 0 && h('div', { style: S.empty }, '没有匹配的记忆。'),
    !error && (data?.rows ?? []).map((row) => h(MemoryRow, { key: row.id, row })),
    !error && total > (data?.limit ?? 0) && h('div', { style: { ...S.rowActions, marginTop: '10px' } },
      h('button', {
        style: S.small(C.muted), disabled: (data?.offset ?? 0) === 0,
        onClick: () => setQuery((c) => ({ ...c, offset: Math.max(0, c.offset - c.limit) })),
      }, '上一页'),
      h('span', { style: S.hint }, `${(data?.offset ?? 0) / (data?.limit ?? 1) + 1} / ${Math.ceil(total / (data?.limit ?? 1))}`),
      h('button', {
        style: S.small(C.muted), disabled: to >= total,
        onClick: () => setQuery((c) => ({ ...c, offset: c.offset + c.limit })),
      }, '下一页'),
    ),
  )
}

function MemoryPanel() {
  const [view, setView] = useState('blocks')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [writeError, setWriteError] = useState(null)
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

  /** One write, then a forced re-read so the list shows what the store now says. */
  const write = async (payload) => {
    setBusy(true)
    try {
      const res = await fetch(BLOCKS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.ok !== true) {
        setWriteError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
        return false
      }
      setWriteError(null)
      await load(true)
      return true
    } catch (err) {
      setWriteError(String(err?.message ?? err))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** Ask the host to extract every pending window now. */
  const flushNow = async () => {
    if (!window.confirm('立即抽取会把当前待抽取的窗口交给 MemVault（每个窗口一次 LLM 调用）。继续？')) return
    setBusy(true)
    try {
      const res = await fetch(FLUSH_URL, { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.ok !== true) {
        setWriteError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
      } else {
        setWriteError(null)
        await new Promise((r) => setTimeout(r, 400))
        await load(false)
      }
    } catch (err) {
      setWriteError(String(err?.message ?? err))
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
  const scopes = (read?.scopes ?? []).map((s) => s.split('/'))
  // MemVault writes are always addressed as one explicit scope; default the add
  // form to the first configured one instead of making the user retype it.
  const defaults = { scopeType: scopes[0]?.[0] ?? 'user', scopeId: scopes[0]?.[1] ?? '' }
  const writable = data?.writable !== false

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
        h('button', { style: S.small(C.warn), disabled: busy || extract?.enabled === false, onClick: flushNow, title: '把当前待抽取的窗口立刻交给 MemVault' }, '立即抽取'),
      ),

      error && h('div', { style: S.banner(C.err) }, error),
      writeError && h('div', { style: S.banner(C.err) }, `写入失败：${writeError}`),
      read?.error && h('div', { style: S.banner(C.warn) }, `读取 ${read.dbPath} 失败：${read.error} —— 继续注入上一次的好文本。`),
      (data?.configIssues?.problems?.length > 0) && h('div', { style: S.banner(C.warn) },
        `配置有问题（已按默认值继续）：${data.configIssues.problems.join('；')}`),
      (data?.configIssues?.unknown?.length > 0) && h('div', { style: S.banner(C.warn) },
        `配置里有未声明的键（已忽略）：${data.configIssues.unknown.join(', ')}`),
      !writable && h('div', { style: S.banner(C.idle) }, '面板当前为只读（config panel.writes: false）。'),

      h('div', { style: { ...S.rowActions, marginBottom: '12px' } },
        h('button', {
          style: S.small(view === 'blocks' ? C.brand : C.muted, view === 'blocks'),
          onClick: () => setView('blocks'),
        }, '注入与抽取'),
        h('button', {
          style: S.small(view === 'memories' ? C.brand : C.muted, view === 'memories'),
          onClick: () => setView('memories'),
        }, '浏览记忆'),
      ),

      view === 'blocks' ? h(Fragment, null,
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

      h(Card, { title: `核心块（${data?.blocks?.length ?? 0}）` },
        (data?.blocks?.length ?? 0) === 0
          ? h('div', { style: S.empty }, '没有块 —— 空贡献会被组装器丢弃，轨迹里也就不会出现这一条。用下面的表单或 MemVault 的 cli blocks-set 建一个。')
          : data.blocks.map((b, i) => h(BlockRow, {
              key: `${b.scope}/${b.label}/${i}`,
              block: b,
              writable,
              busy,
              onWrite: write,
            })),
        h(AddBlock, { writable, busy, onWrite: write, defaults }),
      ),

      h(Card, { title: '抽取（写半边）' },
        h('div', { style: S.grid },
          h(KV, { k: '状态', v: extract?.enabled === false ? '已关闭（只读）' : '开启' }),
          h(KV, { k: '窗口策略', v: extract?.window ? `≥${extract.window.everyNTurns} 轮起，静默 ${Math.round((extract.window.idleMs ?? 0) / 1000)} s 或满 ${extract.window.windowTurns} 轮就抽取` : '—' }),
          h(KV, { k: '待抽取', v: extract?.window?.pending?.length
            ? extract.window.pending.map((p) => `${String(p.sessionId).slice(-8)} · ${p.turns} 轮`).join('   ')
            : '空' }),
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
          ? h('div', { style: S.empty }, '还没有记录。窗口安静下来（或满窗）后写一条（ok / skipped / failed）。')
          : h('div', { style: S.diag },
              h('span', { style: { ...S.k, fontWeight: 600 } }, '时间'),
              h('span', { style: { ...S.k, fontWeight: 600 } }, '轮数'),
              h('span', { style: { ...S.k, fontWeight: 600 } }, '字符'),
              h('span', { style: { ...S.k, fontWeight: 600 } }, '结果'),
              extract.diagnostics.flatMap((d, i) => [
                h('span', { key: `t${i}`, style: S.mono, title: d.seq === null || d.seq === undefined ? '' : `seq @${d.seq}` },
                  new Date(d.at).toLocaleString()),
                h('span', { key: `s${i}`, style: S.mono }, String(d.turns ?? '—')),
                h('span', { key: `c${i}`, style: S.mono }, String(d.transcriptChars ?? '—')),
                h('span', { key: `o${i}`, style: { ...S.mono, color: outcomeTone(d.outcome) }, title: d.outcome },
                  `${d.recovered === true ? '↻ ' : ''}${d.outcome}`),
              ]),
            ),
      ),
      ) : h(MemoriesView, { onError: setError }),
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
