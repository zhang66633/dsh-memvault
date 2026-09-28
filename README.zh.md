# dsh-memvault

<p align="center">
  <strong>把 MemVault 的核心记忆块推进 DeepSeek Harness 的 system prompt，再把每个完成的回合送回去。</strong><br>
  带一个 GUI 里的记忆面板 · 零运行时依赖 · 不需要打包器 · 不需要第二个常驻服务
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>中文</strong>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.3.0-4a6cf7">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-30a46c">
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness-f76b15">
  <img alt="runtime deps" src="https://img.shields.io/badge/runtime%20deps-zero-888">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.13-339933">
  <img alt="panel" src="https://img.shields.io/badge/panel-conversation%20tab%20%2B%20settings-8957e5">
  <img alt="stars" src="https://img.shields.io/github/stars/zhang66633/dsh-memvault?style=flat&color=e3b341">
</p>

---

**dsh-memvault** 补齐的是一个**已经存在**的记忆系统缺掉的那一半。**MemVault**（本机长期记忆服务：SQLite 库 + FastAPI/CLI 管线 + stdio MCP server）负责存事实、做向量化、做检索——但它是 **stdio MCP server**，而 MCP 是 *pull* 协议：服务端只能被**调用**，它没有任何渠道往模型上下文里放东西。所以「记忆已经在上下文里了」这件事，**在 MCP 这一层永远做不到**，只能由客户端插件来做。

本插件做三件事：

| 半边 | 做什么 | 机制 |
|---|---|---|
| **注入（读）** | 核心记忆块进入 system prompt，**每一步**都看得到，模型不必调用任何工具 | `ctx.systemPrompt.context()` —— 动态 runtime 上下文贡献（与 `skill-catalog` 同一条通道） |
| **抽取（写）** | 每 *N* 个完成的回合，把这轮对话交给 MemVault 的抽取/向量化管线 | `ctx.on('session/event')` → `turn/end` → `python -m memvault.cli add --stdin` |
| **可视化（面板）** | 此刻注入了什么、抽取最近干了什么，直接看在 GUI 里 | 两条 exact host 路由（`/memvault/api/*`）+ 一个浏览器半边，落在会话页签环与 Plugins 设置页 |

## ✨ 特性

| | |
|---|---|
| 🧠 **不靠工具调用的注入** | 核心块落在一个动态 runtime 上下文里，每次 `assemble()` 都会求值——模型是「本来就有」，不是「去拿」 |
| 🗄️ **直读 SQLite（只读）** | 用 Node 内置的 `node:sqlite` 只读打开 `memvault.db`：不过 HTTP、不起子进程、无第三方依赖，也不需要任何服务在跑 |
| 💾 **渲染结果按 TTL 缓存** | system prompt 就是 **KV cache 的前缀**：每步重读重渲染是白费，而任何一个字节变化都会让缓存从该点起失效。所以渲染被缓存（`refreshMs`，默认 30 秒） |
| 🧩 **按回合边界切片** | 写半边从自己那份有界事件日志里按 `turn/end` 边界切回合：幂等、跨重启稳定、没有会过期失准的水位算术 |
| ⏱️ **把成本做成旋钮** | `everyNTurns` 控 Python 进程频率，`minTranscriptChars` 跳过琐碎回合，`endReasons` 决定哪些结束方式算数，`timeoutMs` 杀掉卡住的子进程 |
| 🎭 **角色过滤** | 默认不送助手台词与工具流量——送它们曾把模型自己的话存成「关于用户的事实」 |
| 🪶 **零运行时依赖** | 就是 harness 插件协议上的裸 ESM：`node:sqlite`、`node:child_process`、`node:fs`。没有要装的东西；浏览器半边是照着 ModuleLoader 封装手写的，不引入打包器 |
| 🎛️ **一个真面板** | 会话页签环里的 **记忆** 页签 + Settings → Plugins 里的一页：当前注入的块（label、作用域、字符数、原文）、读预算与缓存年龄、抽取旋钮、有水位线的会话数、最近 5 次抽取结果，外加一个跳过 30 秒 TTL 的 **立即重读** 按钮 |
| 🖥️ **host 半边不需要浏览器** | 面板是可选的：`webServer` 用 `ctx.inject` 取，所以无头组合照样注入记忆，只是永远不会注册那两条路由 |
| 🛟 **设计上软失败** | 库读不了就继续供上一次的好文本并只告警一次；抽取失败绝不让一轮对话失败，也不会污染下一轮 |
| 🔍 **可在进程外观测** | 水位与最近 5 次抽取诊断原子写入一个 JSON 文件，于是「钩子没触发」「回合太短」「跑了但没抽到」三者可区分 |

## 🧭 兼容性

| 问题 | 结论 |
|---|---|
| **DSH 桌面端** | ✅ 已在保留的 `desktop` profile 上**实测**：bundle（`dsh.bundle.patch`）加载成功，插件行状态 `active`，注入的块出现在 runtime 上下文快照里。 |
| **需要客户端半边吗？** | 只有面板需要。`dsh.client.platform: 'web'` 负责把浏览器半边提供出去；记忆桥本身完全跑在 host 侧，所以关掉客户端半边损失的是可见性，绝不是注入。 |
| **Web / 无头 / SDK profile** | ✅ 只要 host 在跑，同一个 bundle 就能用。无头组合没有 `webServer`，面板那条子 fiber 会等着它而不是失败。唯一**必需**的服务是 `systemPrompt`。 |
| **面板可见吗？** | ✅ 两个位置：会话页签环里 聊天 / 轨迹 旁边的 **记忆** 页签，以及 Settings → Plugins 里的 **MemVault 记忆桥** 页。两者都是只读视图，数据来自注入的块与抽取状态。 |
| **Windows / macOS / Linux** | ✅ Windows 用作者本机布局即可开箱；其它平台把 `MEMVAULT_DIR` / `MEMVAULT_PYTHON` 指向你的 checkout（POSIX 的 venv 是 `.venv/bin/python`），或在 `cordis.patch.yml` 里写死那三个路径。 |
| **Node** | `>= 22.13`（`node:sqlite` 无需标志）。DSH 自带 Node，所以这条只是本插件的 API 下限声明。 |
| **其它 harness（Claude Code、Codex…）** | ❌ 不是这个插件的事。它是照着 cordis/DSH 的接口写的（`ctx.systemPrompt.context`、`session/event`）。那些 harness 访问同一个库，走 MemVault 自己的 MCP 工具、CLI 或 API。 |

## 🚀 快速开始

**前置条件**：一份能跑的 MemVault checkout——它的 virtualenv 与 `memvault.db`（该库与 MemVault 服务、MCP 客户端共享；本插件只对它 `SELECT`）。

本机自持式安装（也就是本仓库在作者机器上的装法）：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-memvault": "link:D:/_Projects/skill_mcp/dsh-memvault" },
  "dsh": { "profile": { "bundles": ["…", "dsh-memvault", "…"] } }
}
```

```powershell
# 让 profile 能按包名解析到模块
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-memvault" `
  -Target "D:\_Projects\skill_mcp\dsh-memvault"
```

**新增 bundle 后要重启 DSH** —— 改已加载的 patch 文件是热重载，新加的 bundle 不是。

> ⚠️ 两个已知坑。`dsh plugin add` 会重写 profile 的 `package.json`，而 `dsh.profile.bundles` 数组可能**静默丢掉其他插件的条目**——改完务必核对整份清单。另外 pnpm 可能替换掉 `link:` 的 junction，bundle 突然不加载时先重建它。

从 npm 或 git 地址安装是同一个操作，走 `dsh plugin` 或 Web 侧边栏的 **Plugins** 页（见 `@deepseek-ai/dsh-plugin-manager`）。

浏览器半边以 `lib/client.js` 的形式**入库**，所以新克隆的仓库不需要构建。改完 `src/client/index.js` 之后：

```bash
npm run build     # 把客户端源码包进 ModuleLoader 封装
npm test          # lib/client.js 过期会直接失败
```

**新加的客户端半边需要重启 + 刷新页面**才会出现：启动图（boot graph）是渲染进 index 响应里的。

## ⚙️ 配置

所有值都有代码默认；在 `cordis.patch.yml` 里给 `config` 即可覆盖。

### 读半边

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则恒注入空串 |
| `dbPath` | `$MEMVAULT_DB_PATH`，否则 `D:/Claude_code/memory/data/memvault.db` | `memvault.db` 的路径 |
| `scopes` | `[{user,lenovo},{agent,claude-code-memory}]` | 核心块按 `(scope_type, scope_id)` 键控，**两边都必须显式给**——外部进程没有「当前作用域」 |
| `labels` | `[]` | 只注入这些 label；空 = 该作用域下全部块 |
| `maxChars` | `4000` | **整串**预算（含 header） |
| `refreshMs` | `30000` | 渲染缓存的 TTL |
| `order` | `210` | 在 runtime 上下文里的排序（相对 `skill-catalog` 等的先后） |
| `name` | `memvault:core` | 出现在轨迹「上下文注入」里的名字 |

### 写半边（`config.extract`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则完全只读 |
| `everyNTurns` | `3` | 每 N 个**已完成**的回合抽取一次；`1` = 每轮 |
| `endReasons` | `['completed','max-tokens']` | 哪些 `turn/end` 原因算数。`aborted` / `error` / `interrupted` / `blocked` 默认跳过——但 `max-tokens` **不跳**，被截断的回合里同样有真实的用户内容 |
| `includeAssistant` / `includeTools` | `false` / `false` | 抽取器不区分角色，助手台词曾被存成「事实」，所以默认关 |
| `maxInputChars` | `6000` | 转写文本预算；取最新的行，旧行先丢 |
| `minTranscriptChars` | `40` | 低于此值不值得起进程 + 调 LLM，直接跳过（水位仍推进，不会重复挖） |
| `timeoutMs` | `120000` | 超时即杀，只记一条告警 |
| `pythonPath` | `$MEMVAULT_PYTHON`，否则 `<MEMVAULT_DIR>/.venv/{Scripts/python.exe, bin/python}` | 能 `import memvault` 的解释器 |
| `projectDir` | `$MEMVAULT_DIR`，否则 `D:/Claude_code/memory` | 子进程工作目录 |
| `user` / `agent` / `run` | `lenovo` / `claude-code-memory` / 空 | 三元组是**正交的，可以同时给** |
| `env` | `{PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8'}` | 子进程环境变量；去掉它们会重现下面那条 cp936/emoji 坑 |
| `statePath` | `~/.dsh/storages/dsh-memvault-state.json` | 水位 + 最近 5 次诊断；原子写 |

### 面板路由

浏览器半边自己没有旋钮，它只读 host 注册的两条路由。这两条路由只在组合提供了 `webServer` 时存在。

| 路由 | 方法 | 返回 |
|---|---|---|
| `/memvault/api/status` | `GET` | 注入中的块（label、作用域、字符数、原文裁剪到 2000）、读配置、缓存年龄、抽取配置、水位会话数、最近 5 次诊断 |
| `/memvault/api/refresh` | `POST` | 丢掉渲染 TTL 之后的同样载荷 —— 也就是「立即重读」按钮 |

两个 handler 都会拒绝非 loopback `Host`、`Origin` 不匹配（浏览器发了才有）、以及 `Sec-Fetch-Site: cross-site` 的请求（回 403）。它们是 `exact` 路由，所以先于 shell 的 index/`/api` handler 命中。

## 🏗️ 工作原理

```mermaid
flowchart LR
  subgraph HOST["DSH host 进程"]
    LOOP["Agent loop"]
    ASM["systemPrompt.assemble()"]
    CTX["ctx.systemPrompt.context('memvault:core')"]
    HOOK["ctx.on('session/event')"]
    BUFF["有界事件日志<br/>单会话 400 条 · 32 会话"]
  end

  DB[("memvault.db<br/>blocks · memories")]
  PY["python -m memvault.cli add --stdin"]
  STATE["dsh-memvault-state.json"]

  subgraph BROWSER["Web / 桌面客户端"]
    TAB["记忆 页签<br/>Settings → Plugins 页"]
  end

  DB -->|"只读 SELECT ~1 ms"| CTX
  CTX -->|"动态 runtime 上下文，TTL 30 s"| ASM
  ASM --> LOOP

  LOOP --> HOOK
  HOOK --> BUFF
  BUFF -->|"按 turn/end 边界切片"| PY
  PY -->|"抽取 · 向量化 · 写入"| DB
  HOOK --> STATE

  STATE -->|"loadState（水位 + 最近 5 次）"| API["exact 路由<br/>/memvault/api/status · /refresh"]
  DB -->|"与提示词同一次读法"| API
  API --> TAB
```

读路径，每一步：

1. `assemble()` 向每个动态上下文要文本。
2. `memvault:core` 返回缓存渲染，除非 TTL 到期；到期则只读打开库重新渲染。
3. 块渲染成 `- [scope_type/scope_id/label] value`，前面一行归属说明，整体受 `maxChars` 约束。
4. 渲染为空时返回 `''`，组装器会丢弃空贡献，轨迹里也就不会出现这一条——这是空库的预期行为，不是故障。

写路径，每个完成的回合：

1. 每个追加的会话事件都按会话缓冲（两个维度都有上限）。
2. 收到原因可接受的 `turn/end` 时，回合计数推进。
3. 每到第 `everyNTurns` 个回合，从缓冲区里**按回合边界**切片，渲染成只含用户的转写文本（旧行先丢），够长才入队。
4. 抽取串行化：同一时刻只有一个子进程，且一轮失败不会污染下一轮。
5. 剩下交给 MemVault——LLM 抽取、ADD/UPDATE/DELETE 决策、向量化、关系——所以写进去的行**检索得到**。

面板路径，打开时与之后每 15 秒：

1. 浏览器半边向同源 `/memvault/api/status` 取数据。
2. handler 只在 TTL 说了才重新读库，所以一个轮询的面板不会变成每秒一次 SQLite 读；「立即重读」则是强制读。
3. 载荷报告的是**提示词真正拿到的那些块**，不是对库的第二种解释——同一个读取器、同一套作用域/label 过滤、同一个预算。

## 🧪 验证

不需要 DSH，也不需要浏览器：

```bash
npm test              # 四个套件全跑
npm run smoke:package # 包/bundle 契约：manifest、patch 行、导出、peer 声明、bundle id
npm run smoke         # 读取器 / 格式化器 / 预算契约（对真实库只读）
npm run smoke:extract # 转写渲染 / 边界切片 / 事件缓冲 / 水位 + 真实端到端写入（临时库）
npm run smoke:panel   # 在 stub 上下文上挂载插件、用临时库驱动两条路由，并在 stub ModuleLoader 下真跑一遍客户端产物
```

面板的行为是 `smoke:panel` 钉住的：TTL 未到期时必须返回旧渲染（即使期间库里多了一行），`POST /refresh` 必须把那行捞进来，不可信的 `Host`/`Origin` 必须 403，handler 抛错必须变成 500 而不是 reject，库读不了必须仍然 200 并带上上次知道的块，而入库的 `lib/client.js` 必须等于 `src/client/index.js` 构建出来的结果。

端到端那一步在临时库里强制使用离线 embedder 与规则抽取器：不碰真实库，也不调用 .env 里配置的网关。

**装机后的实测**：重启后执行轨迹的「上下文注入」列表里会多出一条 `memvault:core`，内容就是你的核心块；Plugins 页上能看到 bundle 的行（`memvault-core-context`）为 active；**记忆** 页签会把同一批块连同字符数与最近抽取结果画出来。

## 🧠 关键取舍

**为什么直读 SQLite，而不是走 HTTP 或 CLI。** `GET /api/v1/blocks` 需要 FastAPI 服务活在 8780 上——它挂了，提示词就**静默**丢掉记忆。起 CLI 每次刷新约 200–300 ms。`node:sqlite` 约 1 ms，且不依赖任何东西在跑。库与 MemVault 服务共享，但这里只 `SELECT`；`timeout: 2000` 是 busy timeout，避免并发写者把 `SQLITE_BUSY` 抛给提示词组装器。`node:sqlite` 在 Node 24 仍标注 *experimental*——这是被记录下来的风险，也是写半边刻意不依赖它的原因。

**为什么渲染要缓存。** system prompt 是 KV cache 的前缀。每步重读重渲染是白费，而且任何字节变化都会让该点之后的缓存复用失效。核心块是**人以小时为尺度**修改的东西，30 秒 TTL 既便宜又对缓存友好。

**为什么写半边走 CLI 而不是直写库。** 直接写行会**跳过抽取与向量化**——行是存在了，但检索不到。用 `--stdin` 而不是 argv，因为整轮对话远超命令行长度上限。代价是每抽取一轮一个 Python 进程，这正是 `everyNTurns` 与 `minTranscriptChars` 存在的理由。

**为什么只注入核心块，不做每轮语义召回。** 召回结果每轮都变，放进 system prompt 前缀会**每步**让缓存失效。那部分内容应该走带来源的 user 消息，而不是提示词前缀。

**为什么 `turn/end` 原因可配置。** Agent loop 会发 `completed`、`max-tokens`、`blocked`、`aborted`、`error`，修复路径另有 `interrupted`。只收 `completed` 会**静默丢掉**以 `max-tokens` 结束的回合——那里面同样有真实的用户内容。

**为什么浏览器半边是手写的，而不是打包出来的。** 客户端产物只用一种封装加载：`window.__ModuleLoader__.load({ id, factory })`，而面板需要的 `require('react')` 由外壳的平台模块表直接满足——这就是它需要的全部「打包」。所以 `scripts/build-client.mjs` 只做两件事：把那两行包上去。包因此保持零依赖：没有 esbuild、没有 `node_modules`、没有需要维护的构建工具链。`src/client/index.js` 是可读源码，`lib/client.js` 是入库产物（host 只提供已构建的产物，缺了会明确报失败），两者不一致时测试直接失败。

**为什么面板用 `ctx.inject` 注册。** `webServer` 是**想要**的服务，不是必需的服务：无头组合根本没有浏览器可画，而一个「因为没人能画面板就不注入记忆」的记忆桥是 bug，不是安全特性。`ctx.inject(['webServer'], …)` 在那种情况下只是让子 fiber 等着。

**为什么面板路由自己校验调用方。** 通过 `webServer` 注册的路由**不**经过 `dsh-client-connection` 的准入——那道门只守 index 交换与 `/api` 桥。面板因此自己套用桥文档里的同一条请求信任规则（loopback host、有 `Origin` 时必须一致、不允许 cross-site 的 `Sec-Fetch-Site`），让 DNS rebinding 页面读不到库。这是**边界，不是身份**；服务器本身仍然只绑 loopback。

## ⚠️ 已知边界

- **没有抽取窗口。** 抽取是同步的、只送单轮。攒够多轮再异步跑会更省成本、信噪比也更好；现在的缓解手段是 `includeAssistant: false`。
- **源码改动需要真正重启 host。** 改插件自己的 `lib/*.js`（或它的配置）只有进程真重启才会加载——「刷新界面」不算，症状就是*什么都没变*。**新加的客户端半边还要额外刷新一次页面**，因为启动图是渲染进 index 响应的。
- **面板是只读视图，不是编辑器。** 它能看、能重读，但不能写核心块、也不能手动触发抽取。两条都是刻意的：能在面板里改记忆是另一个（也更危险的）界面。
- **`node:sqlite` 仍是 experimental**（DSH 当前自带的 Node 版本就是如此）。
- **默认值带本机信息。** `scopes` 默认是作者的 `(user, lenovo)` / `(agent, claude-code-memory)`，随包附带的 patch 指向作者的 checkout。两处都是给你改的。

## 🗺️ 路线图

- **异步 + 窗口化抽取** —— 攒够 N 轮或空闲时后台跑。
- **配置 schema** —— 让 Plugins 页能直接编辑这些旋钮，而不是手写 patch（面板那一页就是它天然的位置）。
- **面板内编辑核心块** —— 不用离开 GUI 就能建/改一个核心块。

## 📄 许可

[MIT](./LICENSE) © 2026 zhang66633

每一次走进死路、每一个实测出来的坑，都记在 [docs/DEVLOG.md](docs/DEVLOG.md) 里。
