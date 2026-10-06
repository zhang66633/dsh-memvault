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
const MEMORY_URL = '/memvault/api/memory'
const FLAG_URL = '/memvault/api/flag'
const REINDEX_URL = '/memvault/api/reindex'
const REVIEW_URL = '/memvault/api/review'
const REPLAY_URL = '/memvault/api/replay'
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

/** File sizes for the setup card: one SQLite store is normally KB–MB. */
function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
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

/**
 * One memory's provenance: MemVault audits every decision in `history` (with the
 * old and new text) and records contradictions as `relations`. That is the answer
 * to "how did this become what it is", which is what a quality judgement needs.
 */
function MemoryDetails({ id }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    fetch(`${MEMORY_URL}?id=${encodeURIComponent(id)}`)
      .then(async (res) => ({ res, json: await res.json().catch(() => null) }))
      .then(({ res, json }) => {
        if (!alive) return
        if (!res.ok || json?.ok !== true) setError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
        else { setError(null); setData(json) }
      })
      .catch((err) => { if (alive) setError(String(err?.message ?? err)) })
    return () => { alive = false }
  }, [id])

  return h('div', { style: { ...S.block, background: C.layer2, marginTop: '6px' } },
    error && h('div', { style: S.banner(C.err) }, error),
    !error && !data && h('div', { style: S.empty }, '读取中…'),
    !error && data && h(Fragment, null,
      h('div', { style: S.cardTitle }, `历史（${data.history?.length ?? 0}）`),
      (data.history?.length ?? 0) === 0
        ? h('div', { style: S.empty }, '没有审计记录。')
        : data.history.map((entry, i) => h('div', { key: i, style: { marginBottom: '8px' } },
            h('div', { style: S.mono },
              h('span', { style: S.badge(entry.action === 'DELETE' ? C.err : C.ok) }, entry.action ?? '?'),
              ' ',
              entry.at ? new Date(entry.at).toLocaleString() : '—'),
            entry.old && h('div', { ...S.body, style: { ...S.body, color: C.muted } }, `旧：${entry.old}`),
            entry.new && h('div', { style: S.body }, `新：${entry.new}`),
          )),
      h('div', { style: S.cardTitle }, `关系（${data.relations?.length ?? 0}）`),
      (data.relations?.length ?? 0) === 0
        ? h('div', { style: S.empty }, '没有记录到矛盾或关联。')
        : data.relations.map((rel) => h('div', { key: `${rel.direction}-${rel.id}`, style: { ...S.block, background: C.bg } },
            h('div', { style: S.blockHead },
              h('span', { style: S.badge(C.idle) }, rel.direction === 'out' ? '→ 指向' : '← 来自'),
              h('span', { style: S.mono, title: rel.id }, `${String(rel.id).slice(0, 12)}…`),
              h('span', { style: S.badge(rel.alive ? C.idle : C.warn) }, rel.weight === null ? '—' : `权重 ${Number(rel.weight).toFixed(3)}`),
              !rel.alive && h('span', { style: S.badge(C.warn) }, '对方已不存在'),
            ),
            rel.text && h('div', { style: S.body }, rel.text),
          )),
    ),
  )
}

/**
 * The review queue.
 *
 * Two actions, and neither of them lets the panel decide what is right:
 *
 *   - **复制修正请求** copies a ready-made request (ids, texts, provenance) for the
 *     user to hand to the model. The model proposes; DSH's approval is the gate.
 *   - **重抽** sends a retained window's text through MemVault's own pipeline
 *     again — optionally edited, optionally with the other extractor. This is the
 *     panel's only action that writes the store, and it writes it through
 *     MemVault (`add()`), so ADD/UPDATE/DELETE and the audit trail stay in one
 *     place. It is confirmed, because "run it again" can add a paraphrase.
 */
function ReviewCard({ refreshToken, onChanged, onError }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [extractor, setExtractor] = useState('inherit')
  const [busy, setBusy] = useState(false)

  const load = () => {
    fetch(REVIEW_URL)
      .then(async (res) => ({ res, json: await res.json().catch(() => null) }))
      .then(({ res, json }) => {
        if (!res.ok || json?.ok !== true) setError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
        else { setError(null); setData(json) }
      })
      .catch((err) => setError(String(err?.message ?? err)))
  }
  useEffect(load, [refreshToken])
  useEffect(() => { if (error) onError?.(error) }, [error, onError])

  const copyRequest = async () => {
    try {
      await navigator.clipboard.writeText(data?.request ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) { setError(String(err?.message ?? err)) }
  }

  const openReplay = (item) => {
    setEditing(item)
    setDraft(item.inputText ?? '')
    setExtractor('inherit')
  }

  /**
   * Clear a review mark from the queue itself.
   *
   * Without this, the only way to un-flag was to leave the review view, find the
   * row in the browse list and toggle it there — which is backwards: the queue is
   * where a human decides "this one is fine after all".
   *
   * It clears the *flag*, never the memory: deleting or rewriting a stored fact
   * still goes through the model and DSH's approval, which is the boundary the
   * whole panel is built around.
   */
  const unflag = async (id) => {
    setBusy(true)
    try {
      const res = await fetch(FLAG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, flagged: false }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.ok !== true) setError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
      else {
        setError(null)
        load() // the queue shrank — re-read it, don't guess
        onChanged?.() // and let the browse view refresh its badges/counter too
      }
    } catch (err) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const runReplay = async () => {
    if (!window.confirm('重抽会把这段对话重新交给 MemVault（走它自己的判定，可能新增一条、也可能更新已有的一条）。继续？')) return
    setBusy(true)
    try {
      const res = await fetch(REPLAY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: editing.window.inputKey, text: draft, extractor }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.ok !== true) setError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
      else { setError(null); setEditing(null); onChanged?.() }
    } catch (err) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const items = data?.items ?? []
  if (error) return h('div', { style: S.banner(C.err) }, `读取复核队列失败：${error}`)
  if (items.length === 0) return null

  return h(Card, { title: `待复核（${data.total}${data.truncated ? '+' : ''}）` },
    h('div', { style: S.rowActions },
      h('span', { style: S.hint }, '标记只在本插件里；改库要经你确认——重抽走 MemVault 自己的判定，删改交给模型 + DSH 批准。'),
      h('span', { style: S.spacer }),
      h('button', { style: S.small(copied ? C.ok : C.brand), onClick: copyRequest },
        copied ? '已复制' : '复制修正请求（给模型）'),
    ),
    items.map((item) => h('div', { key: item.id, style: { ...S.block, borderColor: C.warn, marginTop: '8px' } },
      h('div', { style: S.blockHead },
        h('span', { style: S.badge(C.warn) }, '待复核'),
        h('span', { style: S.mono, title: item.id }, `${String(item.id).slice(0, 12)}…`),
        item.note && h('span', { style: S.badge(C.idle) }, item.note),
        h('span', { style: S.spacer }),
        item.replayable && h('button', { style: S.small(C.brand), onClick: () => openReplay(item) }, '重抽这个窗口'),
        h('button', { style: S.small(C.muted), disabled: busy, onClick: () => unflag(item.id) }, '取消标记'),
        h(CopyId, { id: item.id }),
      ),
      h('div', { style: S.body }, item.memory),
      h('div', { style: { ...S.hint, marginTop: '4px' } },
        [
          item.window ? `来自窗口 @${item.window.seq ?? '?'}（${item.window.at ? new Date(item.window.at).toLocaleString() : '时间未知'}）` : '来源窗口已滚出保留窗口',
          item.replayable ? '原文仍在，可重抽' : '原文已滚出（只保留最近几个窗口）',
          item.history?.length ? `审计 ${item.history.map((entry) => entry.action ?? '?').join('→')}` : null,
        ].filter(Boolean).join('  ·  ')),
      editing?.id === item.id && h('div', { style: S.editor },
        h('textarea', {
          style: { ...S.textarea, minHeight: '140px' }, value: draft, spellCheck: false,
          onChange: (e) => setDraft(e.target.value),
        }),
        h('div', { style: S.rowActions },
          h('select', { style: S.input, value: extractor, onChange: (e) => setExtractor(e.target.value) },
            h('option', { value: 'inherit' }, '抽取器：沿用当前配置'),
            h('option', { value: 'rule' }, '抽取器：rule（离线、确定性）'),
            h('option', { value: 'llm' }, '抽取器：llm（走配置的网关）')),
          h('button', { style: S.small(C.warn, true), disabled: busy, onClick: runReplay }, busy ? '已排队…' : '确认重抽'),
          h('button', { style: S.small(C.muted), disabled: busy, onClick: () => setEditing(null) }, '取消'),
          h('span', { style: S.hint }, '可以先把这段对话改对，再让管线重抽。'),
        ),
      ),
    )),
  )
}

const STRUCTURE_URL = '/memvault/api/structure'

/** Node colour by memory type, so the graph and the bars agree. */
const TYPE_COLOR = { user: C.brand, agent: C.ok, procedural: C.warn }

/**
 * A one-line stacked bar of a `{ user, agent, procedural }` count map.
 *
 * Widths are shares of that scope's own total, so two scopes with different sizes
 * still compare by *shape* — which is the question the structure view answers.
 */
function TypeBar({ byType, height = 8 }) {
  const total = Object.values(byType ?? {}).reduce((sum, n) => sum + n, 0)
  if (total === 0) return null
  return h('div', {
    style: { display: 'flex', height, borderRadius: '4px', overflow: 'hidden', margin: '6px 0', background: C.layer2 },
  }, Object.entries(byType).filter(([, n]) => n > 0).map(([type, n]) => h('span', {
    key: type,
    title: `${TYPE_LABEL[type] ?? type}: ${n}`,
    style: { width: `${(n / total) * 100}%`, background: TYPE_COLOR[type] ?? C.idle },
  })))
}

/**
 * The relation graph, drawn as a circle.
 *
 * No force layout on purpose: a spring simulation needs an animation loop and a
 * library, and for the job here — "which memories belong to the same contradiction
 * cluster, and which are alone" — a ring with weighted edges is legible and
 * deterministic (the same store draws the same picture twice).
 */
function RelationGraph({ graph, selectedId, onPick }) {
  // Only memories that actually have an edge: with 320 rows of which ~10 relate to
  // anything, drawing the isolated ones too produced a dense black ring where the
  // relations were the last thing you could see. The isolated count is reported in
  // the totals card instead — a number, not 300 identical dots.
  const MAX_DRAWN_EDGES = 40
  const edges = [...(graph?.edges ?? [])]
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .slice(0, MAX_DRAWN_EDGES)
  const involved = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  const nodes = (graph?.nodes ?? []).filter((node) => involved.has(node.id))
  if (nodes.length === 0) {
    return h('div', { style: S.empty },
      (graph?.isolated ?? 0) > 0
        ? `${graph.isolated} 条记忆之间没有任何关系边——它们不属于任何矛盾簇，所以这里没有东西可画。`
        : '还没有关系边。矛盾关系是在写入时由 MemVault 判定的，所以这块空着通常只说明“还没写入过互相冲突的事实”。')
  }
  const size = 440
  const radius = size / 2 - 34
  const place = new Map(nodes.map((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2
    return [node.id, [size / 2 + radius * Math.cos(angle), size / 2 + radius * Math.sin(angle)]]
  }))
  return h('svg', { viewBox: `0 0 ${size} ${size}`, style: { width: '100%', maxWidth: `${size}px`, display: 'block', margin: '0 auto' } },
    edges.filter((edge) => place.has(edge.source) && place.has(edge.target)).map((edge, index) => {
      const from = place.get(edge.source)
      const to = place.get(edge.target)
      const weight = Number(edge.weight) || 0
      return h('line', {
        key: `e${index}`,
        x1: from[0], y1: from[1], x2: to[0], y2: to[1],
        stroke: weight >= 0.7 ? C.warn : C.muted,
        strokeWidth: 0.6 + weight * 3.4,
        opacity: 0.25 + weight * 0.65,
      })
    }),
    nodes.map((node) => {
      const point = place.get(node.id)
      const selected = node.id === selectedId
      const r = (selected ? 9 : 5.5) + Math.min(6, node.degree ?? 0)
      return h('g', { key: node.id, onClick: () => onPick(node), style: { cursor: 'pointer' } },
        h('circle', {
          cx: point[0], cy: point[1], r,
          fill: TYPE_COLOR[node.type] ?? C.idle,
          stroke: selected ? C.fg : node.flagged ? C.warn : 'none',
          strokeWidth: selected ? 3 : node.flagged ? 2 : 0,
        }),
        h('title', null, `${node.id}\n${TYPE_LABEL[node.type] ?? node.type} · ${node.chars} 字符 · 度 ${node.degree}\n${node.text}`),
      )
    }),
  )
}

/**
 * The structure view: what the store is made of, not what is in it.
 *
 * Three questions a flat list cannot answer: which scope dimension holds what,
 * which blocks actually reach the prompt, and how the contradiction graph is
 * shaped (including the memories that have no edges at all — usually where a bad
 * extraction hides, since nothing contradicts it).
 */
function StructureView({ onError }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = () => {
    setLoading(true)
    fetch(STRUCTURE_URL)
      .then(async (res) => ({ res, json: await res.json().catch(() => null) }))
      .then(({ res, json }) => {
        if (!res.ok || json?.ok !== true) setError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
        else { setError(null); setData(json) }
      })
      .catch((err) => setError(String(err?.message ?? err)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])
  useEffect(() => { if (error) onError?.(error) }, [error, onError])

  if (error) return h('div', { style: S.banner(C.err) }, `读取记忆结构失败：${error}`)
  if (data === null) return h('div', { style: S.empty }, loading ? '读取中…' : '—')

  const totals = data.totals ?? {}
  const graph = data.graph ?? {}
  const typeEntries = Object.entries(totals.byType ?? {}).filter(([, n]) => n > 0)

  return h(Fragment, null,
    h(Card, { title: '结构总览' },
      h('div', { style: S.grid },
        h(KV, { k: '记忆总数', v: String(totals.memories ?? 0) }),
        h(KV, { k: '类型分布', v: typeEntries.map(([type, n]) => `${TYPE_LABEL[type] ?? type} ${n}`).join(' · ') || '—' }),
        h(KV, { k: '待复核', v: String(totals.flagged ?? 0) }),
        h(KV, { k: '自动改型', v: String(totals.retyped ?? 0) }),
        h(KV, { k: '核心块', v: `${totals.blocks ?? 0} 个 · 其中 ${totals.injectedBlocks ?? 0} 个在注入范围内` }),
        h(KV, { k: '关系', v: `${graph.totalEdges ?? 0} 条边 · ${graph.isolated ?? 0} 条记忆完全孤立` }),
      ),
      data.initialized === false && h('div', { style: { ...S.hint, marginTop: '8px' } },
        '这个库还没有任何表——要么还没写入过，要么 dbPath 指向了一个新文件。'),
      graph.sampled && h('div', { style: { ...S.hint, marginTop: '8px' } },
        `图已截断：显示 ${graph.nodes.length} / ${graph.totalNodes} 个节点、${graph.edges.length} / ${graph.totalEdges} 条边（按度数取前若干，避免线团）。`),
      h('div', { style: { ...S.rowActions, marginTop: '10px' } },
        h('button', { style: S.small(C.brand), disabled: loading, onClick: load }, loading ? '刷新中…' : '刷新'),
        h('span', { style: S.hint }, '作用域是**维度**不是分区：同一行同时属于 user 与 agent，所以两栏的数字会重复计数——这就是隔离模型的真实形状。'),
      ),
    ),

    h('div', { style: S.grid },
      (data.dimensions ?? []).filter((dim) => dim.values.length > 0).map((dim) =>
        h(Card, { key: dim.key, title: `${dim.key} 维度（${dim.values.length}）` },
          dim.values.slice(0, 8).map((value) => h('div', { key: value.id, style: S.block },
            h('div', { style: S.blockHead },
              h('span', { style: S.badge(C.idle) }, dim.key),
              h('span', { style: S.mono }, value.id),
              h('span', { style: S.spacer }),
              h('span', { style: S.badge(C.idle) }, `${value.memories} 条记忆`),
              value.blocks.length > 0 && h('span', { style: S.badge(C.brand) }, `${value.blocks.length} 块`),
            ),
            h(TypeBar, { byType: value.byType }),
            value.blocks.length > 0 && h('div', { style: { marginTop: '6px' } },
              value.blocks.map((block) => h('div', { key: block.label, style: { marginTop: '4px' } },
                h('div', { style: { ...S.hint, display: 'flex', gap: '6px', alignItems: 'center' } },
                  h('span', { style: S.mono }, block.label),
                  h('span', { style: S.badge(block.injected ? C.ok : C.idle) }, block.injected ? '已注入' : '未注入'),
                  h('span', { style: S.spacer }),
                  h('span', null, `${block.chars} / ${block.limit}`),
                ),
                h('div', { style: { height: '4px', background: C.layer2, borderRadius: '2px', marginTop: '2px' } },
                  h('div', {
                    style: {
                      width: `${Math.min(100, Math.round((block.chars / Math.max(1, block.limit)) * 100))}%`,
                      height: '100%', borderRadius: '2px',
                      background: block.chars > block.limit * 0.9 ? C.warn : C.ok,
                    },
                  })),
              )),
            ),
          )),
        ),
      ),
    ),

    h(Card, { title: `关系图（${graph.nodes.length} 个节点 / ${graph.edges.length} 条边）` },
      h(RelationGraph, { graph, selectedId: selected?.id, onPick: setSelected }),
      (graph.totalEdges ?? 0) > 0 && (data.graph?.edges?.length ?? 0) >= 40 && h('div', { style: { ...S.hint, marginTop: '6px' } },
        `只画了最重的 40 条边（库中共 ${graph.totalEdges} 条）；节点也只用这些边的两端，否则 120 个点会连成一个看不出关系的圆环。`),
      h('div', { style: { ...S.hint, marginTop: '8px' } },
        '节点=记忆，连线=矛盾关系，线宽与不透明度随权重；节点大小随度数。点一个节点看它本身，详情里能看到完整的 ADD/UPDATE/DELETE 审计链。'),
    ),

    selected && h(Card, { title: '选中的记忆' },
      h('div', { style: S.blockHead },
        h('span', { style: S.badge(TYPE_COLOR[selected.type] ?? C.idle) }, TYPE_LABEL[selected.type] ?? selected.type),
        h('span', { style: S.mono, title: selected.id }, `${String(selected.id).slice(0, 12)}…`),
        h('span', { style: S.badge(C.idle) }, `${selected.chars} 字符 · 度 ${selected.degree}`),
        selected.flagged && h('span', { style: S.badge(C.warn) }, '待复核'),
        selected.retyped && h('span', { style: S.badge(C.idle) }, '自动改型'),
        h('span', { style: S.spacer }),
        h(CopyId, { id: selected.id }),
      ),
      h('div', { style: S.body }, selected.text),
      h(MemoryDetails, { id: selected.id }),
    ),

    h(Card, { title: '权重最高的关系' },
      (() => {
        const pairs = data.topRelations ?? []
        if (pairs.length === 0) return h('div', { style: S.empty }, '没有关系边。')
        // Two sources of noise in the raw list: the same pair can be stored in both
        // directions, and one memory can pair with several others. Dedupe the first
        // (symmetric key) and group the second, so one row reads
        // "A ↔ (B₁ 0.84 · B₂ 0.82)" instead of two near-identical rows.
        const seen = new Set()
        const groups = new Map()
        for (const pair of pairs) {
          const key = [pair.a.id, pair.b.id].sort().join('~')
          if (seen.has(key)) continue
          seen.add(key)
          const group = groups.get(pair.a.id) ?? { id: pair.a.id, text: pair.a.text, others: [] }
          group.others.push({ weight: pair.weight, id: pair.b.id, text: pair.b.text })
          groups.set(pair.a.id, group)
        }
        return [...groups.values()].map((group) => h('div', { key: group.id, style: { ...S.block, marginTop: '6px' } },
          h('div', { style: { ...S.hint, display: 'flex', gap: '6px', alignItems: 'center' } },
            h(CopyId, { id: group.id }),
            h('span', { style: S.spacer }),
            h('span', { style: S.badge(C.warn) }, `${group.others.length} 条关系`),
          ),
          h('div', { style: { ...S.body, marginTop: '2px' } }, group.text),
          group.others.map((other) => h('div', {
            key: other.id,
            style: { ...S.hint, display: 'flex', gap: '6px', alignItems: 'baseline', marginTop: '4px' },
          },
            h('span', { style: S.badge(other.weight >= 0.7 ? C.warn : C.idle) }, other.weight.toFixed(3)),
            h('span', { style: S.mono }, other.id.slice(0, 10)),
            h('span', { style: { flex: '1 1 auto', wordBreak: 'break-word' } }, other.text),
          )),
        ))
      })(),
    ),
  )
}

/** One row of the browse list, with its provenance and review controls. */
function MemoryRow({ row, flagged, busy, onFlag, onError, window: producedBy }) {
  const [open, setOpen] = useState(false)
  const meta = [
    row.user ? `user=${row.user}` : null,
    row.agent ? `agent=${row.agent}` : null,
    row.run ? `run=${row.run}` : null,
    // The reverse index: which window produced this memory (survives the
    // diagnostic rolling out of the last-five window).
    producedBy ? `来自窗口 @${producedBy.seq ?? '?'}${producedBy.replayOf ? '（重抽）' : ''}` : null,
    row.updatedAt ? `更新 ${new Date(row.updatedAt).toLocaleString()}` : null,
  ].filter(Boolean).join('  ·  ')
  return h('div', { style: { ...S.block, borderColor: flagged ? C.warn : undefined } },
    h('div', { style: S.blockHead },
      h('span', { style: S.badge(C.idle) }, TYPE_LABEL[row.type] ?? row.type ?? '?'),
      h('span', { style: S.mono, title: row.id }, `${String(row.id).slice(0, 12)}…`),
      h('span', { style: S.badge(C.idle) }, `${row.chars} 字符`),
      // `metadata.retyped_from` is written by the store's own type refinement; the
      // badge says so on the row, so browsing shows what was reclassified even
      // without turning the filter on.
      row.metadata?.retyped_from && h('span', {
        style: S.badge(C.idle),
        title: `这条被自动改型：${row.metadata.retyped_from} → ${row.type}（启发式判定，判错就标为待复核）`,
      }, '自动改型'),
      flagged && h('span', { style: S.badge(C.warn) }, '待复核'),
      h('span', { style: S.spacer }),
      h('button', { style: S.small(C.muted), onClick: () => setOpen((v) => !v) }, open ? '收起' : '详情'),
      h('button', {
        style: S.small(flagged ? C.ok : C.warn, flagged),
        disabled: busy,
        title: '只写本插件的状态文件；MemVault 完全不动',
        onClick: () => onFlag(row.id, !flagged),
      }, flagged ? '已复核' : '标为待复核'),
      h(CopyId, { id: row.id }),
    ),
    h('div', { style: S.body }, row.memory),
    h('div', { style: { ...S.hint, marginTop: '4px' } }, meta),
    row.metadata && h('div', { style: { ...S.mono, color: C.muted, marginTop: '4px' } },
      JSON.stringify(row.metadata)),
    open && h(MemoryDetails, { id: row.id }),
  )
}

/**
 * The stored-memory browser.
 *
 * Deliberately a substring browse over `memories.memory`, not ranked retrieval:
 * semantic search is the model's `memory_search` (it needs the embedder), and a
 * panel that polled it would cost a retrieval per refresh. The label says so.
 */
function MemoriesView({ onError, initialIds = '' }) {
  const [draft, setDraft] = useState('')
  const [ids, setIds] = useState(initialIds)
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const [onlyRetyped, setOnlyRetyped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reviewToken, setReviewToken] = useState(0)
  const [query, setQuery] = useState({ q: '', type: '', limit: 20, offset: 0 })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    const params = new URLSearchParams()
    if (query.q) params.set('q', query.q)
    if (query.type) params.set('type', query.type)
    if (ids) params.set('ids', ids)
    if (onlyFlagged) params.set('flagged', '1')
    if (onlyRetyped) params.set('retyped', '1')
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
  }, [query, ids, onlyFlagged])

  useEffect(() => { if (error) onError?.(error) }, [error, onError])

  /** Toggle the review mark; the host answers with the whole (bounded) flag map. */
  const flagRow = async (id, flagged) => {
    setBusy(true)
    try {
      const res = await fetch(FLAG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, flagged }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.ok !== true) setError(`HTTP ${res.status}${json?.error ? ` · ${json.error}` : ''}`)
      else {
        setError(null)
        setData((current) => ({ ...current, flags: json.flags, flaggedCount: json.flaggedCount }))
        // The queue lives in its own component and only refetches when this token
        // changes; without the bump, flagging a row left the 待复核 card stale
        // until the view was left and re-entered (reported 2026-09-29).
        setReviewToken((n) => n + 1)
      }
    } catch (err) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const submit = (event) => {
    event?.preventDefault?.()
    setQuery((current) => ({ ...current, q: draft, offset: 0 }))
  }
  const total = data?.total ?? 0
  const from = total === 0 ? 0 : (data?.offset ?? 0) + 1
  const to = Math.min(total, (data?.offset ?? 0) + (data?.rows?.length ?? 0))
  const flags = data?.flags ?? {}

  return h(Fragment, null,
    h(ReviewCard, {
      refreshToken: `${reviewToken}:${query.offset}`,
      onError: setError,
      onChanged: () => { setReviewToken((n) => n + 1); setQuery((c) => ({ ...c })) },
    }),
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
      h('div', { style: { ...S.rowActions, marginBottom: '8px' } },
        h('label', { style: { ...S.hint, display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', checked: onlyFlagged,
            onChange: (e) => { setOnlyFlagged(e.target.checked); setQuery((c) => ({ ...c, offset: 0 })) },
          }),
          `只看待复核（${data?.flaggedCount ?? 0} 条已标记）`),
        // The store refines a row's type when a fact looks like technique know-how
        // rather than a person's trait. That judgement is a heuristic, so it is
        // surfaced instead of trusted: these are the rows it acted on.
        (data?.retypedCount ?? 0) > 0 && h('label', {
          style: { ...S.hint, display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' },
          title: '被自动改型的行（user → procedural）：判定是启发式，认为判错了就在这里标为待复核',
        },
          h('input', {
            type: 'checkbox', checked: onlyRetyped,
            onChange: (e) => { setOnlyRetyped(e.target.checked); setQuery((c) => ({ ...c, offset: 0 })) },
          }),
          `只看自动改型（${data?.retypedCount ?? 0} 条）`),
        h('span', { style: S.spacer }),
        ids && h('span', { style: S.badge(C.brand) },
          `只看某次抽取产出的 ${ids.split(',').filter(Boolean).length} 条`,
          ' ',
          h('button', { style: S.small(C.muted), onClick: () => { setIds(''); setQuery((c) => ({ ...c, offset: 0 })) } }, '清除')),
      ),
      h('div', { style: S.hint },
        `共 ${total} 条${total > 0 ? ` · 显示第 ${from}–${to} 条` : ''} · 子串匹配（非语义检索；语义召回请让模型调 memory_search）`),
    ),
    error && h('div', { style: S.banner(C.err) }, `读取记忆失败：${error}`),
    !error && (data?.rows?.length ?? 0) === 0 && h('div', { style: S.empty }, '没有匹配的记忆。'),
    !error && (data?.rows ?? []).map((row) => h(MemoryRow, {
      key: row.id, row, busy,
      flagged: Object.hasOwn(flags, row.id),
      window: data?.produced?.[row.id] ?? null,
      onFlag: flagRow,
      onError: setError,
    })),
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
  // Set by "查看产出的记忆": the ids a diagnostic reported, handed to the browse
  // view as its filter (the key remounts it, so the filter is applied on mount).
  const [memoryIds, setMemoryIds] = useState('')
  const openMemories = (ids) => { setMemoryIds(ids); setView('memories') }
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
        h('button', {
          style: S.small(view === 'structure' ? C.brand : C.muted, view === 'structure'),
          onClick: () => setView('structure'),
        }, '结构'),
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

      h(Card, { title: '位置与初始化' },
        h('div', null,
          h(KV, { k: '库文件（读）', v: read?.dbPath }),
          h(KV, {
            k: '文件状态',
            v: data?.db
              ? (data.db.exists
                ? `存在 · ${fmtBytes(data.db.bytes)}${data.db.modifiedAt ? ` · 更新于 ${fmtAge(Date.now() - Date.parse(data.db.modifiedAt))}前` : ''}`
                : '不存在（写入第一条记忆时创建；若路径写错会一直是这个状态）')
              : '—',
          }),
          h(KV, { k: '状态文件（插件）', v: extract?.statePath }),
          h(KV, { k: 'Python', v: extract?.pythonPath }),
          h(KV, { k: '项目目录（子进程 cwd）', v: extract?.projectDir }),
          h(KV, { k: '注入作用域', v: read?.scopes?.join('  ') || '—' }),
          h(KV, {
            k: '写入作用域',
            v: extract ? `user=${extract.user || '—'} agent=${extract.agent || '—'}` : '—',
          }),
        ),
        h('div', { style: { ...S.hint, marginTop: '8px' } },
          '改路径只有两个真实的入口，而且都不是表单：① 宿主侧——profile 的 cordis.patch.yml（设置 →「打开配置文件」），写成 - id: memvault-core-context 加 config: 覆盖；DSH 当前**没有**给已安装插件提供配置页，这是核实过的。② 服务端侧——MemVault 的 .env（MEMVAULT_DB_PATH / MEMVAULT_DEFAULT_* / MEMVAULT_SCOPE_*）。面板只显示不改：改写同一份配置源才不会出现"哪个在生效"。记忆条数与结构见「结构」页。'),
        // Path validation: "can be set" and "was set correctly" are two different
        // things, and only the second one is worth anything at setup time.
        (data?.paths?.length > 0) && h('div', { style: { marginTop: '10px' } },
          h('div', { style: { ...S.hint, marginBottom: '4px' } },
            `路径来源：${data?.discovery?.source === 'env'
              ? '环境变量 MEMVAULT_DIR / MEMVAULT_PYTHON'
              : data?.discovery?.source === 'discovered'
                ? '自动发现（在候选目录里找到了 memvault 包 + venv）'
                : '未找到任何可用的 MemVault'}`),
          (data?.discovery?.source === 'none' && (data.discovery.candidates?.length ?? 0) > 0) && h('div', { style: { ...S.hint, marginBottom: '4px' } },
            `试过：${data.discovery.candidates.map((c) => `${c.dir}（${c.hasPackage ? '有包' : '无包'}、${c.python ? '有 venv' : '无 venv'}）`).join('；')}`),
          h('div', { style: { ...S.hint, marginBottom: '4px' } }, '路径自检'),
          data.paths.map((item) => h('div', {
            key: item.key,
            style: { display: 'flex', gap: '8px', alignItems: 'baseline', marginTop: '3px' },
            title: item.target || undefined,
          },
            h('span', { style: S.badge(item.ok ? C.ok : C.err) }, item.ok ? '✓' : '✗'),
            h('span', { style: { ...S.hint, minWidth: '110px' } }, item.label),
            h('span', { style: { ...S.hint, color: item.ok ? undefined : C.err } }, item.detail),
          )),
        ),
        h('div', { style: { ...S.hint, marginTop: '8px' } },
          '插件把同一个库路径传给它启动的每个子进程（MEMVAULT_DB_PATH），所以“面板读的库”与“抽取写的库”不再靠两个默认值巧合相等；如果你在 extract.env 里显式写了 MEMVAULT_DB_PATH，那个会优先生效。'),
        (data?.db && data.db.exists === false) && h('div', { style: { ...S.banner(C.warn), marginTop: '8px' } },
          '库文件还不存在：写入第一条记忆（或按一次「立即抽取」）就会创建。如果这不是你期望的位置，去 DSH 插件配置里改 read.dbPath（服务端那半边看 .env 的 MEMVAULT_DB_PATH）。'),
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
          h(KV, { k: '嵌入器重算', v: h('button', {
        type: 'button',
        onClick: async () => {
          // Dry run first, always: the report is the point, and it costs one call at most.
          const res = await fetch(REINDEX_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          const data = await res.json().catch(() => null)
          const r = data?.report
          window.alert(r
            ? `共 ${r.total} 行 · 需重算 ${r.to_recompute} · 未记录 ${r.unrecorded} · 目标 ${r.target}`
            : `无法取得报告：${data?.error ?? res.status}`)
        },
      }, '检查（dry-run）') }),
      h(KV, { k: '按上面的数字执行', v: h('button', {
        type: 'button',
        onClick: async () => {
          // The cost is stated before it is paid: one embedding call per row that changes.
          if (!window.confirm('重算会为每一行需要更新的记忆调用一次嵌入模型（记忆原文会离开本机）。先点“检查（dry-run）”看数量。继续执行？')) return
          const res = await fetch(REINDEX_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apply: true }) })
          const data = await res.json().catch(() => null)
          const r = data?.report
          window.alert(r
            ? `已重算 ${r.recomputed ?? 0} 行 · 已记录 ${r.recorded ?? 0} 行`
            : `失败：${data?.error ?? res.status}`)
        },
      }, '执行重算') }),
      h(KV, { k: '窗口丢弃', v: (() => {
        const d = extract?.window?.pendingDropped
        if (!d) return '未知'
        const caps = `上限 ${d.maxPendingSessions} 个 / ${Math.round(d.maxPendingAgeMs / 60000)} 分钟`
        // A cap that silently eats sessions is worse than no cap: say what was dropped, and
        // what the limits were when it happened.
        return (d.overCap || d.expired)
          ? `超上限 ${d.overCap} · 过期 ${d.expired}（${caps}）`
          : `无（${caps}）`
      })() }),
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
                  `${d.recovered === true ? '↻ ' : ''}${d.outcome}`,
                  ...(d.produced?.length
                    ? [' ', h('button', {
                        key: 'p',
                        style: S.small(C.brand),
                        onClick: () => openMemories(d.produced.map((p) => p.id).join(',')),
                      }, `看这 ${d.produced.length} 条产出`)]
                    : [])),
              ]),
            ),
      ),
      ) : view === 'structure' ? h(StructureView, { onError: setError })
        : h(MemoriesView, { key: memoryIds, onError: setError, initialIds: memoryIds }),
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
