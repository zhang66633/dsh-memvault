window.__ModuleLoader__.load({ id: "dsh-memvault", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
// generated from src/client/index.js by scripts/build-client.mjs — do not edit
// source-sha256: 02fed4e9ecd14378
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
const { createElement: h, Fragment, useEffect, useMemo, useState } = require('react')

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
  link: { border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', padding: 0, fontSize: '12px' },
}

const outcomeTone = (outcome) => (String(outcome ?? '').startsWith('ok') ? C.ok
  : String(outcome ?? '').startsWith('skipped') ? C.idle : C.err)

function KV({ k, v, mono = true }) {
  // `v` is usually text, but it may be a node - the reindex entry puts buttons here. Every
  // value used to go through String(), so a node rendered as "[object Object]": the buttons
  // shipped as two lines of literal text and there was nothing to click. Primitives keep the
  // old path (including "—" for empty), anything else is rendered as it is.
  const isEmpty = v === null || v === undefined || v === ''
  const isText = typeof v === 'string' || typeof v === 'number'
  return h('div', { style: S.kv },
    h('span', { style: S.k }, k),
    h('span', { style: mono ? S.v : undefined, title: typeof v === 'string' ? v : undefined },
      isEmpty ? '—' : (isText ? String(v) : v)),
  )
}

function Card({ title, children }) {
  return h('div', { style: S.card }, h('div', { style: S.cardTitle }, title), children)
}

function Details({ summary, children }) {
  const [open, setOpen] = useState(false)
  return h('div', { style: { marginTop: '10px' } },
    h('button', { type: 'button', style: S.link, onClick: () => setOpen((v) => !v) },
      `${open ? '▾' : '▸'} ${summary}`),
    open && h('div', { style: { marginTop: '10px' } }, children),
  )
}

/** Vector backfill: the only write that costs embedding calls, so it is explicit. */
function VectorCard({ url }) {
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState('')
  const call = async (apply) => {
    setBusy(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(apply ? { apply: true } : {}),
      })
      const json = await res.json().catch(() => null)
      const report = json?.report
      if (!res.ok || !report) {
        setLine(`失败：${json?.error ?? `HTTP ${res.status}`}`)
        return
      }
      setLine(apply
        ? `已回填 ${report.embedded ?? 0} 条（模型 ${report.model}）`
        : `缺失 ${report.missing ?? 0} 条（模型 ${report.model}）`)
    } catch (err) {
      setLine(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }
  return h(Card, { title: '向量回填' },
    h('div', { style: S.hint }, '向量按模型存储；缺向量的记忆在检索里只剩关键词通道。回填会为每条缺失行调用一次嵌入模型。'),
    h('div', { style: { ...S.rowActions, marginTop: '8px' } },
      h('button', { type: 'button', style: S.small(C.brand), disabled: busy, onClick: () => call(false) }, '检查缺口'),
      h('button', {
        type: 'button',
        style: S.small(C.warn),
        disabled: busy,
        onClick: () => {
          if (!window.confirm('回填会为每条缺失行调用一次嵌入模型（记忆原文会离开本机）。先点「检查缺口」看数量。继续？')) return
          call(true)
        },
      }, '回填'),
    ),
    line && h('div', { style: { ...S.hint, marginTop: '6px' } }, line),
  )
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
 * Layout constants for the relation graph. Kept together so the preview harness
 * and the component cannot drift apart.
 */
const GRAPH_BOX = { width: 720, height: 400, pad: 30 }
const GRAPH_MAX_EDGES = 48

/** Deterministic [0,1) from a string: the same store must draw the same picture twice. */
function hash01(text) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const escapeXml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Fruchterman–Reingold on one connected component, in local coordinates.
 *
 * Returns positions centred on the origin plus the component's bounding box. The
 * simulation is deterministic: seeds come from `hash01(id)`, there is no
 * randomness, so hovering or re-rendering never reshuffles the picture.
 */
function simulateComponent(ids, edges, { size = 160, iterations = 220 } = {}) {
  const n = ids.length
  const pos = ids.map((id) => {
    const angle = hash01(`${id}:angle`) * Math.PI * 2
    const radius = Math.sqrt(hash01(`${id}:radius`)) * (size * 0.42)
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
  const local = new Map(ids.map((id, i) => [id, i]))
  const links = edges
    .filter((edge) => local.has(edge.source) && local.has(edge.target))
    .map((edge) => ({ s: local.get(edge.source), t: local.get(edge.target), weight: edge.weight }))

  const k = Math.sqrt((size * size) / Math.max(1, n)) * 0.8
  const limit = size * 0.48
  const moveX = new Float64Array(n)
  const moveY = new Float64Array(n)

  for (let step = 0; step < iterations; step += 1) {
    moveX.fill(0)
    moveY.fill(0)
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = pos[i].x - pos[j].x
        let dy = pos[i].y - pos[j].y
        let d2 = dx * dx + dy * dy
        if (d2 < 1e-4) {
          dx = hash01(`${ids[i]}|${ids[j]}`) - 0.5
          dy = hash01(`${ids[j]}|${ids[i]}`) - 0.5
          d2 = dx * dx + dy * dy || 1e-4
        }
        const d = Math.sqrt(d2)
        const force = (k * k) / d
        const fx = (dx / d) * force
        const fy = (dy / d) * force
        moveX[i] += fx
        moveY[i] += fy
        moveX[j] -= fx
        moveY[j] -= fy
      }
    }
    for (const link of links) {
      const a = pos[link.s]
      const b = pos[link.t]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d = Math.hypot(dx, dy) || 0.01
      const force = ((d * d) / k) * (0.75 + link.weight * 0.8)
      const fx = (dx / d) * force
      const fy = (dy / d) * force
      moveX[link.s] -= fx
      moveY[link.s] -= fy
      moveX[link.t] += fx
      moveY[link.t] += fy
    }
    const cooling = 1 - step / iterations
    const stepLimit = k * cooling * 1.3
    for (let i = 0; i < n; i += 1) {
      const dx = Math.max(-stepLimit, Math.min(stepLimit, moveX[i]))
      const dy = Math.max(-stepLimit, Math.min(stepLimit, moveY[i]))
      pos[i].x = Math.max(-limit, Math.min(limit, pos[i].x + dx))
      pos[i].y = Math.max(-limit, Math.min(limit, pos[i].y + dy))
    }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of pos) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  const offsetX = -(minX + maxX) / 2
  const offsetY = -(minY + maxY) / 2
  return {
    positions: pos.map((point) => ({ x: point.x + offsetX, y: point.y + offsetY })),
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

/**
 * Layout the relation graph as packed islands.
 *
 * The store's graph is not one big network: it is many small clusters (a pair of
 * contradicting facts, a three-node chain). A single global spring layout spread
 * those islands across the whole canvas — mostly empty space, every edge a short
 * segment between neighbours — which is why the first version looked like a ring
 * of dots. Laying each connected component out on its own and shelf-packing the
 * results keeps related memories together and makes the islands visible.
 */
function layoutRelationGraph(graph, {
  width = GRAPH_BOX.width,
  height = GRAPH_BOX.height,
  pad = GRAPH_BOX.pad,
  maxEdges = GRAPH_MAX_EDGES,
} = {}) {
  const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]))
  const chosen = (graph?.edges ?? [])
    .filter((edge) => edge && byId.has(edge.source) && byId.has(edge.target) && edge.source !== edge.target)
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .slice(0, maxEdges)

  const nodes = []
  const seen = new Set()
  for (const edge of chosen) {
    for (const id of [edge.source, edge.target]) {
      if (seen.has(id)) continue
      seen.add(id)
      nodes.push(byId.get(id))
    }
  }
  if (nodes.length === 0) return { width, height, nodes: [], edges: [], maxDegree: 0 }

  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const edges = chosen.map((edge) => ({
    source: edge.source,
    target: edge.target,
    weight: Number(edge.weight) || 0,
    s: index.get(edge.source),
    t: index.get(edge.target),
  }))
  const degree = new Array(nodes.length).fill(0)
  const adjacency = nodes.map(() => [])
  for (const edge of edges) {
    degree[edge.s] += 1
    degree[edge.t] += 1
    adjacency[edge.s].push(edge.t)
    adjacency[edge.t].push(edge.s)
  }

  // Connected components (every drawn node has at least one edge).
  const visited = new Set()
  const components = []
  for (let i = 0; i < nodes.length; i += 1) {
    if (visited.has(i)) continue
    const stack = [i]
    const members = []
    visited.add(i)
    while (stack.length > 0) {
      const current = stack.pop()
      members.push(current)
      for (const neighbour of adjacency[current]) {
        if (visited.has(neighbour)) continue
        visited.add(neighbour)
        stack.push(neighbour)
      }
    }
    components.push(members)
  }

  // Lay each component out on its own, then shelf-pack the islands.
  const islands = components
    .map((members) => {
      const ids = members.map((i) => nodes[i].id)
      const size = Math.min(210, 64 + 22 * Math.sqrt(members.length))
      const simulated = simulateComponent(ids, edges, { size })
      const box = {
        members,
        xs: simulated.positions.map((p) => p.x),
        ys: simulated.positions.map((p) => p.y),
        width: simulated.width,
        height: simulated.height,
      }
      return box
    })
    .sort((a, b) => b.height - a.height)

  const gapX = 24
  const gapY = 22
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  let widestRow = 0
  for (const island of islands) {
    const spanX = island.width + 12
    if (cursorX > 0 && cursorX + spanX > width - pad * 2) {
      widestRow = Math.max(widestRow, cursorX - gapX)
      cursorX = 0
      cursorY += rowHeight + gapY
      rowHeight = 0
    }
    island.offsetX = cursorX + spanX / 2
    island.offsetY = cursorY + island.height / 2
    cursorX += spanX + gapX
    rowHeight = Math.max(rowHeight, island.height + 12)
  }
  const usedWidth = Math.max(1, widestRow, cursorX - gapX)
  const usedHeight = Math.max(1, cursorY + rowHeight)
  const scale = Math.min((width - pad * 2) / usedWidth, (height - pad * 2) / usedHeight, 1)
  const shiftX = (width - usedWidth * scale) / 2
  const shiftY = (height - usedHeight * scale) / 2

  const placed = new Array(nodes.length)
  const islandOf = new Array(nodes.length).fill(0)
  islands.forEach((island, islandIndex) => {
    island.members.forEach((nodeIndex, i) => {
      islandOf[nodeIndex] = islandIndex
      placed[nodeIndex] = {
        x: shiftX + (island.offsetX + island.xs[i]) * scale,
        y: shiftY + (island.offsetY + island.ys[i]) * scale,
      }
    })
  })

  const maxDegree = Math.max(1, ...degree)
  const laid = nodes.map((node, i) => ({
    id: node.id,
    type: node.type,
    flagged: node.flagged === true,
    degree: degree[i],
    island: islandOf[i],
    chars: node.chars,
    text: node.text,
    x: placed[i].x,
    y: placed[i].y,
    r: Math.max(3.6, (4.6 + Math.min(6.2, (degree[i] / maxDegree) * 6.2)) * scale),
  }))

  return {
    width,
    height,
    nodes: laid,
    edges: edges.map((edge) => ({
      source: laid[edge.s].id,
      target: laid[edge.t].id,
      weight: edge.weight,
      x1: laid[edge.s].x,
      y1: laid[edge.s].y,
      x2: laid[edge.t].x,
      y2: laid[edge.t].y,
    })),
    maxDegree,
  }
}

/**
 * Render a layout as an SVG string.
 *
 * A string rather than JSX so the same renderer feeds the preview harness; the
 * component attaches one delegated click and one hover handler to the wrapper.
 * Colours use style attributes (not presentation attributes) because they are
 * `var(--dsw-…)` expressions, which only resolve inside CSS.
 */
function renderRelationGraphSvg(layout, { theme, selectedId = null, hoveredId = null } = {}) {
  const { nodes, edges, width, height } = layout
  if (nodes.length === 0) return ''
  const focus = hoveredId ?? selectedId
  const linked = new Set()
  if (focus) {
    for (const edge of edges) {
      if (edge.source === focus) linked.add(edge.target)
      else if (edge.target === focus) linked.add(edge.source)
    }
  }
  // Labels: one representative per island (its busiest node), then hubs, then the
  // selection. One label per cluster names the island without turning the canvas
  // into a wall of text. Placement is greedy: skip a label whose box would hit an
  // earlier label or any node circle.
  const labelled = new Map()
  const taken = nodes.map((node) => ({
    x: node.x - node.r - 2, y: node.y - node.r - 2, w: node.r * 2 + 4, h: node.r * 2 + 4,
  }))
  const byIsland = new Map()
  for (const node of nodes) {
    const list = byIsland.get(node.island) ?? []
    list.push(node)
    byIsland.set(node.island, list)
  }
  const representatives = [...byIsland.values()]
    .map((list) => [...list].sort((a, b) => b.degree - a.degree)[0])
    .sort((a, b) => b.degree - a.degree)
  const order = [...representatives, ...nodes.filter((node) => node.degree >= 2).sort((a, b) => b.degree - a.degree)]
  if (selectedId) {
    const selected = nodes.find((node) => node.id === selectedId)
    if (selected) order.unshift(selected)
  }
  for (const node of order) {
    if (labelled.size >= 10) break
    if (labelled.has(node.id)) continue
    const text = String(node.text ?? node.id)
    const label = text.length > 14 ? `${text.slice(0, 14)}…` : text
    // Measure by script: a CJK glyph is ~9.6px at 9.5px font, Latin ~5.7px.
    // Assuming one width made Chinese labels overlap while looking "measured".
    const boxWidth = [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 9.6 : 5.7), 0) + 8
    const box = { x: node.x + node.r + 4, y: node.y - 6.5, w: boxWidth, h: 13 }
    const overlaps = taken.some((other) => box.x < other.x + other.w && other.x < box.x + box.w
      && box.y < other.y + other.h && other.y < box.y + box.h)
    if (overlaps && node.id !== selectedId) continue
    taken.push(box)
    labelled.set(node.id, { label, x: box.x, y: node.y + 3.4 })
  }

  const parts = []
  for (const edge of edges) {
    const active = focus ? (edge.source === focus || edge.target === focus) : true
    const strokeWidth = 0.7 + edge.weight * 2.1
    const opacity = focus ? (active ? 0.85 : 0.06) : 0.22 + edge.weight * 0.5
    parts.push(`<line x1="${edge.x1.toFixed(1)}" y1="${edge.y1.toFixed(1)}" x2="${edge.x2.toFixed(1)}" y2="${edge.y2.toFixed(1)}" style="stroke:${theme.edge};stroke-width:${strokeWidth.toFixed(2)};opacity:${opacity.toFixed(2)};stroke-linecap:round"/>`)
  }

  for (const node of nodes) {
    const color = theme.typeColor[node.type] ?? theme.idle
    const selected = node.id === selectedId
    const dim = focus !== null && focus !== undefined && !linked.has(node.id) && node.id !== focus
    const style = [
      `fill:${color}`,
      `fill-opacity:${selected ? 0.34 : 0.26}`,
      `stroke:${color}`,
      `stroke-width:${selected ? 2.2 : 1.3}`,
    ]
    if (dim) style.push('opacity:0.18')
    parts.push(`<g data-id="${escapeXml(node.id)}" style="cursor:pointer">`)
    parts.push(`<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${node.r.toFixed(1)}" style="${style.join(';')}"/>`)
    if (selected) {
      parts.push(`<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${(node.r + 4).toFixed(1)}" style="fill:none;stroke:${color};stroke-width:1;opacity:0.45"/>`)
    }
    if (node.flagged) {
      parts.push(`<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${(node.r + 2.6).toFixed(1)}" style="fill:none;stroke:${theme.warn};stroke-width:1.2;stroke-dasharray:2 2"/>`)
    }
    const label = labelled.get(node.id)
    if (label) {
      parts.push(`<text x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" style="font:9.5px ui-monospace,SFMono-Regular,Consolas,monospace;fill:${theme.muted};paint-order:stroke;stroke:${theme.bg};stroke-width:3;stroke-linejoin:round">${escapeXml(label.label)}</text>`)
    }
    parts.push(`<title>${escapeXml(`${node.text ?? node.id}\n${TYPE_LABEL[node.type] ?? node.type} · ${node.chars} 字符 · 度 ${node.degree}`)}</title>`)
    parts.push('</g>')
  }

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" style="display:block;max-width:${width}px;margin:0 auto">${parts.join('')}</svg>`
}

const GRAPH_THEME = {
  bg: C.bg,
  muted: C.muted,
  edge: C.border2,
  idle: C.idle,
  warn: C.warn,
  typeColor: TYPE_COLOR,
}

/**
 * The relation graph: packed islands, labels only where they help, and a hover
 * that isolates one memory's neighbourhood instead of drawing everything at once.
 */
function RelationGraph({ graph, selectedId, onPick }) {
  const [hovered, setHovered] = useState(null)
  const layout = useMemo(() => layoutRelationGraph(graph), [graph])
  const svg = useMemo(() => renderRelationGraphSvg(layout, {
    theme: GRAPH_THEME,
    selectedId,
    hoveredId: hovered,
  }), [layout, selectedId, hovered])

  if (layout.nodes.length === 0) {
    return h('div', { style: S.empty },
      (graph?.isolated ?? 0) > 0
        ? `${graph.isolated} 条记忆之间没有任何关系边——它们不属于任何矛盾簇，所以这里没有东西可画。`
        : '还没有关系边。矛盾关系是在写入时由 MemVault 判定的，所以这块空着通常只说明“还没写入过互相冲突的事实”。')
  }

  const nearestNode = (event) => {
    const group = event.target?.closest?.('g[data-id]')
    if (!group) return null
    const id = group.getAttribute('data-id')
    return layout.nodes.find((node) => node.id === id) ?? null
  }

  return h(Fragment, null,
    h('div', {
      onClick: (event) => {
        const node = nearestNode(event)
        if (node) onPick(node)
      },
      onMouseMove: (event) => {
        const node = nearestNode(event)
        setHovered((current) => (current === (node?.id ?? null) ? current : (node?.id ?? null)))
      },
      onMouseLeave: () => setHovered(null),
      style: { lineHeight: 0, padding: '6px 0 2px' },
      dangerouslySetInnerHTML: { __html: svg },
    }),
    h('div', { style: { ...S.rowActions, marginTop: '10px', gap: '16px' } },
      Object.entries(TYPE_COLOR).map(([type, color]) => h('span', {
        key: type,
        style: { ...S.hint, display: 'flex', gap: '5px', alignItems: 'center' },
      },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: color, opacity: 0.8 } }),
        TYPE_LABEL[type] ?? type)),
      h('span', { style: S.hint }, '线宽 = 关系权重 · 悬停看邻居，点击看详情'),
    ),
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
        h('span', { style: S.hint }, '「维度」不是分区：同一行同时属于 user 与 agent，所以两栏的数字会重复计数——这就是隔离模型的真实形状。'),
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
      h(Details, { summary: '展开关系图' },
        h(RelationGraph, { graph, selectedId: selected?.id, onPick: setSelected }),
        h('div', { style: { ...S.hint, marginTop: '8px' } },
          '节点=记忆，连线=关系，权重决定线宽与不透明度；节点大小随度数。'),
        (graph.totalEdges ?? 0) > 0 && (graph.edges?.length ?? 0) >= 40 && h('div', { style: { ...S.hint, marginTop: '4px' } },
          `图中只画最重的 ${graph.edges.length} 条边（库中共 ${graph.totalEdges} 条），否则 120 个点会连成一个看不出关系的圆环。`),
      ),
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
        h('span', { style: S.hint },
          total === 0 ? '没有匹配' : `${from}–${to} / ${total} 条 · 子串匹配（语义召回请让模型调 memory_search）`),
        ids && h('span', { style: S.badge(C.brand) },
          `只看某次抽取产出的 ${ids.split(',').filter(Boolean).length} 条`,
          ' ',
          h('button', { style: S.small(C.muted), onClick: () => { setIds(''); setQuery((c) => ({ ...c, offset: 0 })) } }, '清除')),
      ),
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
        h('button', { style: S.btn(true), disabled: busy, onClick: () => load(true), title: '跳过缓存，立刻重读核心块' }, busy ? '读取中…' : '刷新'),
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
        }, '概览'),
        h('button', {
          style: S.small(view === 'memories' ? C.brand : C.muted, view === 'memories'),
          onClick: () => setView('memories'),
        }, '记忆'),
        h('button', {
          style: S.small(view === 'structure' ? C.brand : C.muted, view === 'structure'),
          onClick: () => setView('structure'),
        }, '结构'),
      ),

      view === 'blocks' ? h(Fragment, null,
      h(Card, { title: '存储与注入' },
        h('div', { style: S.grid },
          h(KV, { k: '库文件', v: read?.dbPath }),
          h(KV, {
            k: '文件',
            v: data?.db
              ? (data.db.exists
                ? `${fmtBytes(data.db.bytes)} · ${data.db.modifiedAt ? `${fmtAge(Date.now() - Date.parse(data.db.modifiedAt))}前` : '—'}`
                : '不存在（写入第一条时创建）')
              : '—',
          }),
          h(KV, { k: '注入', v: read ? `${read.blockCount} 块 · ${read.renderedChars} / ${read.maxChars} 字符` : '—' }),
          h(KV, { k: '作用域', v: read?.scopes?.join('  ') }),
          h(KV, { k: '抽取', v: extract?.enabled === false ? '已关闭（只读）' : '开启' }),
        ),
        h(Details, { summary: '路径、窗口与自检' },
          h('div', { style: S.grid },
            h(KV, { k: '状态文件', v: extract?.statePath }),
            h(KV, { k: '窗口策略', v: extract?.window ? `≥${extract.window.everyNTurns} 轮起，静默 ${Math.round((extract.window.idleMs ?? 0) / 1000)} s 或满 ${extract.window.windowTurns} 轮` : '—' }),
            h(KV, { k: '待抽取', v: extract?.window?.pending?.length
              ? extract.window.pending.map((p) => `${String(p.sessionId).slice(-8)} · ${p.turns} 轮`).join('   ')
              : '空' }),
            h(KV, { k: '窗口丢弃', v: (() => {
              const d = extract?.window?.pendingDropped
              if (!d) return '未知'
              const caps = `上限 ${d.maxPendingSessions} 个 / ${Math.round(d.maxPendingAgeMs / 60000)} 分钟`
              return (d.overCap || d.expired)
                ? `超上限 ${d.overCap} · 过期 ${d.expired}（${caps}）`
                : `无（${caps}）`
            })() }),
            h(KV, { k: '转写预算', v: extract ? `≤ ${extract.maxInputChars} 字符，< ${extract.minTranscriptChars} 跳过` : '—' }),
            h(KV, { k: '送助手/工具', v: `${extract?.includeAssistant ? '是' : '否'} / ${extract?.includeTools ? '是' : '否'}` }),
            h(KV, { k: '结束原因', v: extract?.endReasons?.join(' / ') }),
            h(KV, { k: '水位会话数', v: extract?.sessions }),
          ),
          (data?.paths?.length > 0) && h('div', { style: { marginTop: '10px' } },
            h('div', { style: { ...S.hint, marginBottom: '4px' } },
              `路径来源：${data?.discovery?.source === 'env'
                ? '环境变量 MEMVAULT_DIR'
                : data?.discovery?.source === 'discovered'
                  ? '自动发现'
                  : '未找到'}`),
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
          (data?.db && data.db.exists === false) && h('div', { style: { ...S.banner(C.warn), marginTop: '8px' } },
            '库文件还不存在：写入第一条记忆（或按一次「立即抽取」）就会创建。'),
        ),
      ),

      h(Card, { title: `核心块（${data?.blocks?.length ?? 0}）` },
        (data?.blocks?.length ?? 0) === 0
          ? h('div', { style: S.empty }, '没有块 —— 空贡献会被组装器丢弃，轨迹里也就不会出现这一条。用下面的表单建一个。')
          : data.blocks.map((b, i) => h(BlockRow, {
              key: `${b.scope}/${b.label}/${i}`,
              block: b,
              writable,
              busy,
              onWrite: write,
            })),
        h(AddBlock, { writable, busy, onWrite: write, defaults }),
      ),

      h(VectorCard, { url: REINDEX_URL }),

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

return module.exports; } });
//# sourceSHA256=02fed4e9ecd14378
