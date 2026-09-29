# dsh-memvault 开发文档

> DeepSeek Harness 插件：把 MemVault 的核心记忆块注入 system prompt，并把每个回合的对话交给 MemVault 的抽取管线。
> 本文件记录**计划、迭代过程与踩坑**（工程规则 ②）。所有结论都有实测或官方来源支撑，不靠推断。

## 1. 目标与设计

| 半边 | 做什么 | 机制 |
|---|---|---|
| **注入（读）** | 核心记忆块每步可见，模型不必调工具 | `ctx.systemPrompt.context()`（动态 runtime 上下文，与 `skill-catalog` 同一条通道） |
| **抽取（写）** | 每 N 个完成回合，把该回合对话交给 MemVault 的抽取 + 向量化管线 | `ctx.on('session/event')` → `turn/end` → CLI `add --stdin` |

**为什么必须是插件**：MemVault 是 stdio MCP server，而 MCP 是 **pull** 协议——服务端没有任何渠道往模型上下文里放东西，只能被调用。注入只能由客户端做。

## 2. 关键取舍（都实测过）

- **读走 `node:sqlite` 直读**库文件（只读、约 1ms）。不走 HTTP：REST 需要 FastAPI 常驻 8780，服务挂掉记忆就**静默消失**；也不起子进程（每次 200–300ms）。
- **写走 CLI `add --stdin`**。不直写 SQLite：那会**跳过抽取与向量化**，写进去的行检索不到。不用 argv：整轮对话远超命令行长度上限。
- **注入文本按 TTL 缓存（30s）**：`assemble()` 每步都跑，而 system prompt 是 KV cache 前缀——每步重渲染是白费，任何字节变化还会让缓存从该点起失效。核心块是人以小时为尺度改的东西。
- **只注入核心块，不做每轮语义召回**：召回结果每次都变，放 system prompt 前缀会每步毁缓存；那部分应走带来源的 user 消息。

## 3. 迭代与踩坑（按发现顺序）

1. **CLI 的 `--user/--agent` 是互斥组**，而引擎里它们是正交维度（API 与 MCP 都同时用）。插件同时传 user+agent → `error: argument --agent: not allowed with argument --user` → **每次抽取都失败，用户只能看到一条 warn**。已修 MemVault CLI（三个独立可选参数）+ 补测试。
   *教训*：集成测试比单测更早暴露这类「接口语义与调用方假设不一致」。
2. **预算契约有漏洞**：`formatCoreBlocks` 的 header 恒输出，而省略提示会把总长顶超 `maxChars`。已改成「提示放不下就不放」，并把契约写成精确不变式：**`maxChars` 约束整串**（含 header），仅当 `maxChars < header 长度` 时退化为只出 header。
3. **`turn/end` 的 reason 不止 `completed`**（读 `@deepseek-ai/dsh-agent-loop` 源码）：还有 `max-tokens` / `blocked` / `aborted` / `error`（repair 路径另有 `interrupted`）。沿用「只收 completed」会**静默丢掉因 max-tokens 结束的回合**——那同样有真实用户内容。现已可配置，默认 `['completed','max-tokens']`。
4. **`node:sqlite` 在 Node 24 仍是 experimental**（context7 拉到的 Node 官方 API 文档：v23.4/v22.13 起不再需要 `--experimental-sqlite` 标志但仍 experimental；**升为 release candidate 是 v25.7.0**）。缓解：写半边完全不依赖它；真出问题就把读半边也换成 CLI。
5. **同一份官方文档还纠正了一个遗漏**：`new DatabaseSync(path, { timeout })` 是 **busy timeout**（v24.0.0 起）。库与 MemVault 服务共享，只读查询撞上写者会抛 SQLITE_BUSY 给提示词组装器。已加 `timeout: 2000`。
6. **`session.events` 在观察者拿到的对象上不是数组**（`Array.isArray` 为假）。这让**两种**切片策略都产出 `events: 0`——两轮修复都打在了错的地方。改为插件自建受限的事件日志（`createEventBuffer`，单会话 400 条 / 32 会话上限）。
7. **`seq` 是会话日志下标**（`dsh-session`：`seq: SessionSeq(this.log.length)`），不是全局计数。用它做窗口比较会塌成空集（实测 `after === endSeq`）。改为**按 turn 边界切片**（当前事件下标往前找上一个 `turn/end`），幂等、跨重启稳定、不再需要水位状态。
8. **CLI 把 stdin 按本机码页解码**（中文 Windows = cp936）：转写文本里的 `✅` 变成**孤立代理字符**，httpx 发往网关时崩 `surrogates not allowed`。两侧都修：插件给子进程强制 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`；MemVault CLI 改为按字节读取、显式 UTF-8 解码（管道=机器输入；非 UTF-8 才回退本机码页）。**这与 MemVault Sprint 13 的 MCP stdio 编码坑同类**。
9. **诊断本身踩了坑**：stderr 只取**头部** 400 字符，而 Python traceback 的异常在**尾部**——导致一次失败定位需要一个额外来回。现取尾部 900 字符，并把 `buffered`/`sessionKeys` 记入诊断。
10. **热加载行为**：插件**源码**改动需要 host 进程**真正重启**才加载（改配置同理）；「刷新界面」不算。表现为诊断字段缺失/行为不变。

## 4. 验证方式

```powershell
cd D:\_Projects\skill_mcp\dsh-memvault
node scripts\smoke.mjs           # 读取器 / 格式化器 / 预算契约（对真实库只读）
node scripts\smoke-extract.mjs   # transcript 渲染 / 边界切片 / 事件缓冲 / 水位 / 真实端到端写入（临时库）
```

端到端写入那条会用**临时库**并强制离线 embedder，不会碰真实库、不联网。

**观测外部状态**（插件在 host 进程里，日志不落地）：
- `~/.dsh/storages/dsh-memvault-state.json` → 水位 + 最近 5 次抽取诊断（`outcome` 会区分「钩子没触发 / 回合太短 / 跑成功抽到 N 条 / 失败」）

## 5. 未完成与已知边界

- **抽取已改成异步 + 窗口**（0.5.0，见 §8）：攒够 N 轮后等安静或满窗，一次调用覆盖整窗；等待中的窗口落盘，跨重启不丢。
- **`everyNTurns` 验证期临时为 1**，稳定后应改回 3（`cordis.patch.yml` 现已是 3）。
- **插件源码改动需重启 host**（见踩坑 10），没有热加载。
- **面板已补齐**（0.3.0，见 §7）：GUI 里有 记忆 页签与 Plugins 设置页两处入口；它只读，不写块、不触发抽取。

---

## 6. 0.2.0：包身份、兼容声明与公开发布（2026-09-28）

发布到 `github.com/zhang66633/dsh-memvault` 这一轮做的**非功能**改动，以及每一条的判据。

### 6.1 包名：`@local/dsh-memvault` → `dsh-memvault`

`@local/` 是本地开发的临时作用域，不能发布、也不适合作为公开身份。改为不带作用域的名字（与 `dsh-pixel-ui` 同一模式）：

1. `package.json.name`、`cordis.patch.yml` 行的 `name`、`lib/index.js` 的 `export const name` **三处必须一致**——不一致时行解析不到模块，症状是「记忆静默不再注入」，和故障长得一模一样。
2. 本机装机同步迁移：新建 junction `profiles/desktop/node_modules/dsh-memvault`，profile 的 `dependencies` 与 `dsh.profile.bundles` 两处 `@local/dsh-memvault` 一起改名（**保持数组原位置**，bundle 顺序即配置优先级），最后删掉旧 junction（用 `cmd /c rmdir`，避免 `Remove-Item -Recurse` 递归删到目标目录）。

**判据不是推断，是实测**：desktop profile 的 `patchReload: live`，改完 manifesto 后 host 会重组；随后 `plugin_manager list_plugins` 里 `include:memvault-core-context` 的 `moduleName` 已变成 `dsh-memvault` 且 `fiberPhase: active`——改名后插件仍活着。

### 6.2 兼容声明：只声明真正会被检查的 peer

读 `@deepseek-ai/dsh-app-boot` 源码（`evaluatePluginCompatibility`，见 §7 的读法）得到三条**确切**语义：

- 只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 家族；`@deepseek-ai/cordis` 之类的 peer **不检查**（作者其它插件里那条 `cordis` peer 实际是装饰）。
- 比较用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`——预发布版参与匹配。**这点很关键**：不带 `includePrerelease` 时 `0.1.7-rc.2` 不满足 `>=0.1.0-rc.1 <0.2.0-0`（semver 只允许同一 `major.minor.patch` 上的预发布），实测已确认。
- `peerDependencies` 整体缺失 = **没有任何约束**（直接 return undefined）。

于是本插件声明 `"@deepseek-ai/dsh-system-prompt": ">=0.1.0-rc.1 <0.2.0-0"`（它注入的唯一服务），并用运行时同版本的 `semver@7.8.5` + 同样的 `includePrerelease` 验过区间；随后 host 重组时该 bundle 未被 skip，判据复现。另加 `dsh.manifestVersion: 1` 与 `engines.node >= 22.13`（后者是 `node:sqlite` 免标志的版本下限）。

### 6.3 路径可移植：三个环境变量

代码默认值原本写死作者本机路径。现在读环境变量，回落到同一条本机路径（因此本机行为不变）：

| 配置项 | 环境变量 | 回落 |
|---|---|---|
| `dbPath` | `MEMVAULT_DB_PATH` | `D:/Claude_code/memory/data/memvault.db` |
| `projectDir` | `MEMVAULT_DIR` | `D:/Claude_code/memory` |
| `pythonPath` | `MEMVAULT_PYTHON` | `$MEMVAULT_DIR/.venv/{Scripts/python.exe, bin/python}`（Windows / POSIX 两种 venv 布局） |

即：**Windows 开箱可用，其它平台只需给变量**。`scopes`（`lenovo` / `claude-code-memory`）仍是本机值与显式配置项。

### 6.4 新增第三套自检：`scripts/smoke-package.mjs`

前两套只测「跑起来对不对」，缺的是**跑之前** DSH 读的那些东西。新套件断言：manifest 必填字段、`dsh.bundle.patch` 存在、patch 行名 = 包名 = 导出名、`inject[]` 里的每个服务都有对应的 `dsh-*` peer 声明、`files[]` 每项真实存在、没有运行时依赖、没有 `dsh.client`。`npm test` 现在三套连跑。

### 6.5 新踩的坑

11. **`Set-Content -Encoding utf8` 写出 BOM**：用它改 `~/.dsh/profiles/desktop/package.json` 后文件带 `EF BB BF`，host 直接报 `Unexpected token '', "﻿{..." is not valid JSON`——**profile 清单读不了**。改用 `[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`，并校验首字节是 `{`。
    *教训*：改 host 的 JSON 清单要用能指定「无 BOM」的写法，且改完立刻用 `ConvertFrom-Json` 复核。
12. **DSH 的源码在 `app.asar` 里**（`D:\_Downloads\Installers\dsh\resources\app.asar`），PowerShell 看不见；系统提示里那个 `app.asar\dsh\` 路径不能直接列。读法见 §7。

### 6.6 验证清单（本轮）

```powershell
npm test   # smoke:package + smoke + smoke:extract 三套全绿
```

外加两次 host 侧观测：`plugin_manager list_plugins` 看到 `include:memvault-core-context` / `dsh-memvault` / `active`；本会话运行时上下文里直接出现 `MemVault core memory (...)` 那段注入文本。

---

## 7. 0.3.0：面板（客户端半边）+ 两条 host 路由

目标：把「此刻注入了什么」「抽取最近干了什么」从 JSON 文件搬进 GUI，**同时不牺牲无头可用性**。

### 7.1 先把协议从源码确认清楚（规则 ①）

| 结论 | 出处 |
|---|---|
| 客户端产物只认一种封装：`window.__ModuleLoader__.load({ id, factory: (require) => exports })` | `dsh-client-modules` README + 兄弟插件的 `lib/client.js` 实际产物 |
| host 只提供**已构建**的产物，`lib/client.js` 缺失会明确报错并要求先构建 | `dsh-client-modules` README：host serves built client bundles |
| `dsh.client` 里真正被解析的字段只有 `platform`（必须 `'web'`）与可选 `external` | `dsh-client-modules/lib/index.js`：`decl.platform`、`optionalStringArray(pkgName, "dsh.client.external", decl.external)` |
| 路由：`ctx.webServer.register({ kind: 'exact', path, handler(req,res) })`；匹配顺序 exact → 最长 prefix → fallback | `dsh-host-webserver` README |
| 浏览器认证只覆盖 index 交换与 `/api` 桥（`?token=` → 签名 cookie，`SameSite=Strict`、`Path=/`），**不覆盖**自己注册的 exact 路由 | `dsh-client-connection` README（admit/authorizeIndex） |
| 插槽注册参数是 `{ id, order, label }`，`label` 可为 thunk（每次投影重读，随语言切换） | live `client Slots` inspect（`conversation.view`、`settings.plugins.tab` 的 catalog） |
| 主题色用 `--dsw-alias-*` 真实 token | live `client Theme` inspect |

实测到的两个卡位事实：`conversation.view` 已占用 `cf#chat(0)`、`cf#trajectory(10)`；`settings.plugins.tab` 已占用 `cf#all(10)`、`dsh-market(60)`。所以 `id: memvault`、`order: 30` 落在两者之间，不与任何现有条目抢格子。

### 7.2 取舍

- **手写客户端产物，不引 esbuild。** 面板只要 `require('react')`，而它由外壳的平台模块表满足；「打包」的全部内容就是那两行封装。于是 `scripts/build-client.mjs` 只做包裹 + 写入源码 sha256，包仍然零依赖。代价是多了一个「产物必须与源码同步」的约束，用测试堵住（见 7.3）。
- **`webServer` 用 `ctx.inject(['webServer'], …)` 取，而不是写进 `inject`。** 写进 `inject` 会让无头组合里整个插件一直等依赖——**记忆注入会跟着面板一起失效**，这是不能接受的耦合。
- **状态文件在启动时 `loadState()` 读进来**（水位 + 最近 5 条诊断），而不是只从空数组开始追加：否则每次重启后面板都像「从来没抽过」。
- **面板路由自己校验调用方。** 既然不在认证门内，就按 `api-request-trust` 的同一条规则自检（loopback host、`Origin` 一致、非 cross-site）。这是边界不是身份，服务器仍只绑 loopback。
- **面板只读。** 能看、能强制重读（把 `cache.at` 置 0），不能写块、不能手动触发抽取。

### 7.3 验证（规则 ③）

新增 `scripts/smoke-panel.mjs`（38 条断言，不需要 DSH 也不需要浏览器）：

- 信任规则 7 条：loopback/localhost/Origin 一致放行，外域 host、外域 origin、cross-site、缺 host 全部拒绝；
- 载荷：作用域拍平、超长块「真长度 + 裁剪值」分离、空快照两半边都在；
- handler：200/403/405/500 四条路径，`cache-control: no-store`，抛错不会变成未处理 rejection；
- **真行为**：在临时库上挂载插件 → 断言 `systemPrompt.context` 注册名与注入文本 → 子插件只有 `webServer` 一个依赖 → 两条 exact 路由注册成功 → `GET status` 拿到 2 块与磁盘上的诊断 → **TTL 未到期时新写入的行不出现** → `POST refresh` 把它捞进来（3 块）→ 注入文本随之包含新块 → 库缺失时仍 200 且带错误与上次已知的块 → `extract.enabled: false` 时面板照常工作；
- 客户端产物：`lib/client.js` 必须等于 `src/client/index.js` 的构建结果 → 在 `vm` 里用 stub `window.__ModuleLoader__` + stub `require('react')` 真跑一遍 → 断言 bundle id = 包名、导出 `name/inject/apply`、`apply()` 在两个插槽各注册一次且组件是函数。

### 7.4 新踩的坑

13. **参考插件带着无效字段。** `dsh-project-hub`、`dsh-pixel-ui`、`dsh-memory` 的 `package.json` 里都写了 `dsh.client.inject: [...]`，但 `dsh-client-modules` 只解析 `platform` 与 `external`——那个字段**什么也没声明**；真正生效的是客户端模块自己导出的 `export const inject`。照抄它会让人误以为依赖已经被声明。（本包因此不写它，只在 `peerDependencies` 里声明真正会被兼容性检查的 `@deepseek-ai/dsh-client-ui-slots`。）
14. **新加的客户端半边不会热加载。** 启动图（`window.__DSH_BOOT__`）是渲染进 index 响应的，所以「重启 host + 刷新页面」缺一不可；只改产物内容时，host 侧重启仍是必需的（跨进程边界）。
15. **别用 `Get-Content` 判断 UTF-8 生成物坏没坏。** 控制台按本机码页（cp936）解码，`lib/client.js` 里的破折号会显示成乱码（`鈥?`）。用 Node 读字节或用 `git diff` 复核，不要据此改文件编码。

---

### 7.5 面板变成可写（0.4.0）

需求：光看不够，得能在面板里改核心块。写入路径的选择沿用同样的推理，先读源码确认语义：

| 结论 | 出处 |
|---|---|
| `blocks-set --type {user\|agent} --id <scope> <label> [value] [--limit N]` → `core_append`；`blocks-delete ...` → `core_delete` | `memvault/cli.py`（argparse 定义 + dispatch） |
| `core_append` 是**按 `(scope_type, scope_id, label)` 的 upsert**，label 必填，会 emit `block.updated`，`value_limit` 缺省取 `config.default_block_limit` | `memvault/memory.py` |
| `upsert_block` 是 UPDATE/INSERT，**不按 value_limit 截断**（它是建议值），块写入不触发向量化 | `memvault/storage.py` |

取舍：

- **仍然走 CLI，不直写库、也不走 REST。** 块写入没有 LLM 与向量化，但仍然必须经过 `core_append`（upsert 语义 + `block.updated` 事件 + value_limit）。直写等于把这三样都跳过；REST 又要求 FastAPI 常驻。
- **多两条比 MemVault 更严的校验**，都是「否则会静默无事发生」的失败：空值（读取器跳过空块）与超 8000 字符（argv 长度是真限制，值是 argv 位置参数）。
- **`--` 分隔符**：`blocks-set` 的 label/value 是位置参数，值以 `-` 开头时会被 argparse 当选项；位置参数前插 `--` 就不会。
- **写完立刻把渲染缓存的 `at` 置 0**，否则用户会看到「刚保存的块没进提示词」（30 秒 TTL）。
- **`panel.writes: false`** 让整条写路由回 403，面板自己切换成只读样式。

验证（新增/扩展，均在 `smoke-panel.mjs`）：校验 12 条、argv 3 条（含 `--not-a-flag`）、受长度限制的 body 读取 6 条、路由 403/405/400/413/200 五条，以及**对临时库的真实 CLI 写入闭环**：建块 → 热 TTL 仍是旧的 → `POST /refresh` 看到新块 → 注入文本包含它 → 同 label 再写仍是 upsert（块数不变、值变了）→ 删除后消失。

新踩的坑（本轮）：

16. **同名常量在不同模块里含义不同，会让测试「假过」。** `panel.js` 的 `BLOCK_VALUE_MAX`（发给浏览器的裁剪长度 2000）与 `blocks-write.js` 的 `BLOCK_VALUE_MAX`（写入上限 8000）同名；测试里导错了那个，断言用 2001 字符去撞 8000 的上限，于是「超长值被拒」这条**应该失败却通过了**（实际是没触发）。改名为 `BLOCK_VALUE_CLAMP` / `BLOCK_VALUE_MAX` 后才真正咬住。*教训*：跨模块常量的名字要带意图（clamp vs max），测试里宁可显式写数字并加注释。
17. **`readJsonBody` 要显式拒绝数组。** `typeof [] === 'object'`，最初的非空对象判断放过了 JSON 数组；路由契约是「body 必须是一个对象」，所以判断落在 `Array.isArray` 上。

---

## 8. 0.5.0：异步 + 窗口化抽取

需求（0.2–0.4 的遗留账）：抽取是**同步的、送单轮**。一轮一次调用既贵（一个 Python 进程 + 一次 LLM 调用）又吵——「好，就这么办」这种单轮几乎没有信息量，而围绕一个决定的三四轮里全是信息。

### 8.1 策略（`lib/window.js`，纯函数）

| 触发 | 条件 |
|---|---|
| 继续等 | 窗口轮数 < `everyNTurns` |
| 武装空闲计时器 | 窗口轮数 ≥ `everyNTurns` → `idleMs` 后未再完成新回合就交出整窗；**新回合会重新计时** |
| 立即交出 | 窗口轮数 ≥ `windowTurns`（硬上限，保证从不安静的会话也会被抽到） |

关键取舍：

- **把策略抽成不带 harness 的模块**：它只接受普通对象、一个 `flush` 回调和**可注入的计时器**，所以整套「什么时候抽」用假时钟测，不靠 sleep。这是本轮最大的可测性收益。
- **空闲计时器 `unref()`**：不能让一个「等安静」的定时器把进程退出拖住。
- **窗口落盘**：窗口化把「在途」时间从一轮拉长到最多 8 轮 + 一个计时器，只在内存里放着的东西正好是重启会丢的。落盘的是**渲染后的文本**（受 `maxInputChars` 约束，最多 4 个会话），不是原始事件——状态文件保持小。
- **挂载时恢复**：状态文件里还在等待的窗口在挂载时被抽取，诊断带 `recovered: true`；超过 5 个的部分记一条 skipped 诊断，而不是静默消失。
- **`everyNTurns` 语义变化**（0.4 → 0.5）：从「每 N 轮抽一次单轮」变成「至少 N 轮才考虑抽取」，一次调用覆盖 3–8 轮。这是本轮唯一的行为破坏性变化，所以版本进到 0.5.0。
- **面板给一个「立即抽取」**：空闲触发意味着「刚说的话」要等，必须给一个当场触发的出口（`POST /memvault/api/flush`，确认框里写明会花掉一次 LLM 调用）。

### 8.2 验证（规则 ③）

- `smoke-extract.mjs`：窗口策略 **假时钟** 全套——不足 N 轮不动、到 N 轮武装、新回合重新计时、满窗立即交、空闲触发交、每会话独立、`flushAll`、`dispose` 清计时器、参数校验、默认值；外加「一个窗口渲染成一份有序转写文本、超预算时丢旧行」。
- `smoke-panel.mjs`：**真端到端**——把两个完成的回合喂进真实的 `session/event` handler → 状态路由报告窗口里等着 2 轮 → 状态文件里落了这份窗口（含渲染文本）→ `POST /flush` 交出去 → 诊断出现 `turns: 2`、`ok added=2` → 窗口清空、水位推进到第 4 个事件 → 两条事实（吃辣 / 住南京）真的进了临时库。**两个回合，一次调用**，这就是本轮要证明的东西。

### 8.3 新踩的坑

18. **这台机器的「pwsh」其实是 Windows PowerShell 5.1，`Get-Content -Raw` 按 ANSI(cp936) 解码。** 我用 `Get-Content -Raw` + `[IO.File]::WriteAllText` 做一次批量改名替换，把 `lib/index.js` 里**所有非 ASCII 字符**（10 个 em dash 等）转成了 `鈥?` 这类乱码——文件当时还没提交，`git restore` 回滚后改用它路重做。判据：改名前 em dash 10 个，改名后 0 个、非 ASCII 数从 116 涨到 215。
    *教训*：**不要用 shell 的文本管道做仓库内的文本替换**（PS 5.1 的读入编码不是 UTF-8）；要用编辑器工具或 Node。顺带修正踩坑 11 的说法：`-Encoding utf8` 写出 BOM 也是 5.1 的行为（7 是无 BOM）。
19. **TDZ 近失**：面板的 `snapshot()` 里读了 `turnWindow.pendingWindows()`，而 `turnWindow` 是**后面**才 `const` 声明的；一旦 `extract.enabled: false`，提前 return 会跳过那条声明，之后每次 `GET status` 都会抛 `Cannot access 'turnWindow' before initialization`。（`typeof` 也救不了 TDZ。）改为先声明一个占位访问器 `let pendingWindows = () => []`，创建窗口后再指向真实窗口——面板在抽取关闭时仍然可用，这也正是它的设计目标。

---

## 9. 0.6.0：配置 schema（一份描述，三处产出）

需求：旋钮已经 16 个以上，手写 patch 调参开始变成负担；同时默认值散在常量、patch、README 三处，天然会漂。

### 9.1 先从源码确认机制（规则 ①）

| 结论 | 出处 |
|---|---|
| DSH 从插件模块上读的字段就叫 `Config`：`Reflect.get(plugin, "Config")` | `dsh-app-boot` 源码 `configOf` / `collectConfigSchemas` |
| 「原生 schema」的判据是三条：`Reflect.get(value, Symbol.for('schemastery')) === true`、`typeof value.type === 'string'`、`meta` 是非 null 对象 | 同上 `isNativeConfigSchema` |
| 不是原生 schema 时：`entry.status` 不置为 `schema`，并记一条 "Config is not a native Schemastery schema" | 同上 |
| `generateConfigSchema(profile, layers, installAnchor)` 把 schema 投影成 JSON Schema（`x-cordis` 下带 refs） | 同文件导出表 + 定义 |
| 本机有一份**文件系统上的** `@deepseek-ai/schemastery@3.18.4`（含 `src/index.ts` 与 ESM/CJS 双构建） | `~/.dsh/profiles/node_modules/@deepseek-ai/schemastery` |

用那份真 Schemastery 实测到的语义（不是猜的）：

- `Schema.object({...})` 嵌套：`S({})` 会**填入嵌套默认值**，所以代码侧不必再深合并一遍；
- `Schema.natural().min(200)` 会以清晰信息拒绝过小值；
- **`step` 是相对 `min` 计量的**：`isMultipleOf(data, meta.min ?? 0, step)`；
- `Schema.string().default(null)` 等于「没有默认值」，该键在输出里消失；`dict` 的默认值是 `{}`，必须显式 `.default(...)` 才能带上自己的默认字典。

### 9.2 设计

- **`lib/config.js`：一份 spec（零外部依赖）**——每字段 `{ kind, default, description, min?, max?, step?, role?, integer? }`。从它派生：`configDefaults()`（代码默认值）、`resolveConfig()`（宽容解析：合并、强制转换数字字符串、报告未知键与类型错误，永不抛）。
- **`lib/schema.js`：把同一份 spec 变成原生 schema**，导出为 `Config`。`buildConfigSchema(Schema, spec)` 是纯函数，所以测试可以拿真 Schemastery 喂它。
- **import 是可选的**（`try { await import('@deepseek-ai/schemastery') } catch {}`）：这个包由 DSH 运行时提供。静态 import 会让**每一个** smoke 测试在裸 Node 上加载不了插件模块——那是本轮最不能接受的代价。DSH 里永远解析得到；解析不到时 `Config` 为 `undefined`（DSH 视作「没声明 schema」，插件照常加载）并且 `apply()` 明确警告一次。
- **`window.js` 的默认值**保持独立（它不依赖任何东西），由测试断言与 spec 一致——这是唯一保留的重复常量。
- **面板**新增两条警告横幅（未知键 / 类型错误），因为这些错误以前只会进 host 日志。

### 9.3 验证（规则 ③，新增 `scripts/smoke-config.mjs`）

- spec 本身：默认值、描述齐全、每个节点的 kind 都被构建器实现、数字字段声明 integer、**`step` 必须整除 `min` 与默认值之差**；
- 单一事实来源：`DEFAULT_EXTRACT === configDefaults().extract`、`window.js` 与 spec 一致、`DEFAULT_DB_PATH`/`DEFAULT_SCOPES`/`DEFAULT_STATE_PATH` 都来自各自模块；
- 解析器：空配置＝默认值、嵌套合并、数字字符串强制转换并报告、未知键报告并忽略、类型错误回落并报告、dict 过滤非字符串、`null` 视为「未设置」；
- **真 Schemastery**（本机有则跑，没有则 `[SKIP]` 并打印搜索路径）：schema 通过 app-boot 的三条原生判据、**空配置校验结果与代码默认值逐字段相等**、部分配置填默认、越界与类型错误被拒、描述进入 metadata、`toJSON()` 图里能找到窗口旋钮；
- **随包 patch**：用 DSH 那份 `js-yaml` 解析 `cordis.patch.yml`，断言没有任何未声明键、没有任何类型问题。

### 9.4 这条测试立刻赚回了成本

第一次跑就红了，而且是**真 bug**：`maxInputChars` 我写了 `step: 500`、`min: 200`、默认 `6000`，而 Schemastery 的 `step` 是相对 `min` 判定的——`6000 - 200 = 5800` 不是 500 的倍数，**校验会直接失败**。如果没这条测试，这次改动会在用户重启后让 `Config` 校验不通过、插件行无法激活，症状是「记忆突然不再注入」。修法是 `step: 100`（`5800 % 100 === 0`），并把这条规则写成断言，让以后任何新旋钮都逃不过。

另外两处也由测试暴露：`dict` 需要显式 `.default()`（否则 `env` 的默认字典消失），`run` 的默认 `null` 在 schema 里会被当作「无默认」而整个键消失——改成 `''`（空值即省略该 CLI 标志），两边语义就一致了。

---

## 10. 0.7.0：面板里浏览记忆（只读）

需求（路线的最后一块空白）：面板能看「注入了什么」「抽取干了什么」，但看不到**库里到底存了哪些记忆**——只能让模型去调 `memory_search`。

### 10.1 先看库的真实形状（规则 ①）

| 结论 | 出处 |
|---|---|
| `memories(id TEXT PK, user_id, agent_id, run_id, memory TEXT NOT NULL, memory_type TEXT DEFAULT 'user', hash, embedding BLOB, metadata TEXT DEFAULT '{}', created_at, updated_at)` | `memvault/storage.py` 的建表脚本 |
| 索引只有 user_id / agent_id / run_id / hash / created_at——**`memory` 文本列没有索引** | 同上 |
| MemVault 自己的维护路径用显式列名而不是 `SELECT *`，理由就是 embedding blob | `storage.iter_memory_meta` 的 docstring |
| 元数据是自由格式的 JSON 文本 | 建表默认值 `'{}'` |

### 10.2 取舍

- **子串浏览，不是语义召回。** 语义排序要 embedder，`memory_search` 的混合模式还要关键词索引；那是模型的工具，面板轮询它等于每次刷新做一次召回。所以：`LIKE` + 有界页（默认 20、上限 200）+ 报告总数 + 载荷里写 `mode: 'substring'`，面板上也把「非语义检索」写在提示里。
- **绝不 `SELECT *`。** 只取要显示的九列（沿用 MemVault 自己的理由）。实测在作者的真实库（289 条）上浏览完全不碰 embedding。
- **每个值都是占位符，`%`/`_` 转义。** 搜索「50%」必须只匹配真的含 `50%` 的行；`'; DROP TABLE memories; --` 只是一段查不到东西的文本。测试里两条都断言了（真实库上 `q=%` 返回 10 条而不是全部 289 条）。
- **宽容而不报错。** 未知 `order` 回落到 `created`、`limit` 夹到 200、负 `offset` 当 0；生效的过滤在 `applied` 里回显——一个静默丢掉过滤条件的浏览比一个说清楚自己干了什么的浏览更糟。
- **只读。** 删除/修改仍由模型的 `memory_delete`/`memory_update` 或 CLI 负责；面板给「复制 id」把它交出去，而不是自己动手。

### 10.3 验证（规则 ③）

- `lib/memories.js` 纯函数部分：SQL 里不出现任何值（只有占位符）、LIKE 转义、limit/offset 解析与位置、`applied` 回显、上限夹取、未知 order 回落、count 查询与主查询共享过滤但不带分页、超长文本裁剪但报告真实长度、坏 metadata 不炸。
- 面板端到端（复用抽取测试刚写出的临时库，里面有两条真实记忆）：
  - 默认浏览返回 2 条、字段集合恰好是那九列、载荷里**没有 embedding**、`mode` 是 substring；
  - 子串搜「南京」命中 1 条；
  - `q=%` 返回 0（转义生效）；
  - `type=user` → 2 条、`type=bogus` → 0 条且 `applied.type` 如实回显；
  - `limit=1` 与 `limit=1&offset=1` 两条 id 不同、总数都报 2；
  - 注入形状的查询返回 200、0 条，且**表没被破坏**（再查一次仍是 2 条）；
  - POST → 405、不可信 Host → 403。
- 真实库抽查（不进测试）：289 条、子串命中 206 条、`q=%` 10 条、页 2 id 不同、limit 夹到 200。

### 10.4 一处工程教训（写下来避免重犯）

重构客户端时我用「替换 `function MemoryPanel() {` 这一行」的方式插入了新组件，结果把旧组件体**劈成了两半**——它在语法上仍是一个合法的函数调用序列，所以只看 diff 不容易发现。修法是回到原结构再插：先把旧组件体接回去，再把四张卡片包进 `view === 'blocks' ? h(Fragment, null, …) : h(MemoriesView, …)`。
*教训*：对「函数头」这类结构性锚点做整体替换，比锚在行内文本上更容易把文件切成两段；改完必须**跑一次解析**（本轮用了 `node --check` 与 `new Function(...)` 预检客户端工厂体），而别指望 bundling 会替你报错——它只是把源文件原样包一层。

---

## 11. 0.8.0：抽取质量闭环（产出可追溯 + 人工复核标记）

需求（0.7.0 之后自己看出来的缺口）：面板能看「窗口抽了什么」（诊断）也能看「库里存了什么」（浏览），但**两端之间没有连线**——诊断里只有计数，没有 id；也没有任何地方能记下「这条抽错了」。

### 11.1 先确认抽取侧到底能拿到什么（规则 ①）

| 结论 | 出处 |
|---|---|
| `add()` 返回 `{results: [_public(row)…], relations: [...]}`，每行含 `id`/`memory`/`memory_type`/`created_at`，已去掉 embedding | `memory.py` 的 `add` 与 `_public` |
| 每次决策都落在 `history(memory_id, action, old_memory, new_memory, changed_at)`，矛盾落成 `relations(source_id, target_id, weight)` | `memory.py` 文件头注释 + `storage.py` 建表 |

所以「窗口 → 产出的记忆 → 这条记忆的历史与关系」这条链**数据一直都在**，只是没人读它。

### 11.2 取舍

- **诊断记录产出 id（+ 裁剪后的文本）**：`produced: [{id, type, chars, text}]`，上限 20 条 × 200 字符。这让「ok added=2」变成可审计的东西，面板上就是一个「看这 2 条产出」的按钮，点了就把浏览视图过滤成那两条。
- **复核标记写在本插件状态文件，不写库。** 这是本轮最关键的取舍：只有人能提供「这条是错的」，把它记下来有用，**对它动手**危险。所以标记 = 状态文件里 `{id: {at, note}}`（有界 200 条、保留最新、note 裁剪 300 字符），可筛选、将来可导出；删除/改写仍然只属于 `memory_delete`/`memory_update`/CLI。面板「绝不修改你的记忆」因此仍然字面成立。
- **标记与块编辑共用 `panel.writes` 开关**：只读就意味着只读，不搞「只读但能改一点」这种模糊承诺。
- **来源视图 = history + relations 一起给**：一次请求 `GET /memory?id=` 返回三样（行、审计、关系）。关系里对方可能已被删除（删行不保证删边），所以显式给 `alive: false` 而不是画一张空卡片。
- **`?ids=` 过滤**：诊断里的 id 列表要能变回行；ids 是值，一样走占位符，并且有上限（200）。

### 11.3 验证（规则 ③）

纯函数：flag 表归一化（坏输入丢弃）、标记/清除、note 裁剪、空 id 忽略、**按时间保留最新 200 条**；`ids` 过滤生成占位符并有上限、空列表不加子句；`shapeProduced` 裁剪、丢无 id 行、封顶。

面板端到端（临时库 + 真实 CLI）：抽取诊断里 `produced` 恰好两条且文本被裁剪 → 用这两个 id 去浏览正好返回这两条 → `GET /memory` 返回 `history: ["ADD"]` 且不带 embedding → 未知 id 404 → 标记后状态文件里有它、**库里没有**（note 文本不出现在浏览结果里）→ `?flagged=1` 只返回那一条 → 取消后为空 → 坏 body 400 / GET 405 / 不可信 Host 403。

### 11.4 自己踩的坑（写下来）

20. **`live-check` 类临时脚本调了写路由，写到了真实状态文件。** 我用默认配置（即真实 `~/.dsh/storages/dsh-memvault-state.json`）跑了一次 `POST /memvault/api/flag`，于是标记被写进了生产状态文件——虽然紧跟着取消、文件复查完好（watermarks 17 / diagnostics 5 / flags {}），但这是侥幸：写路由必须在**临时 statePath** 上验，或者只验读路由。教训与 0.4.0 那次「改 profile 清单带 BOM」同类：**验证脚本也是要在生产目录里动手的程序**。

---

## 12. 0.9.0：复核闭环可操作化（①A + ②C）

用户拍板的方向：**①A 重抽走 MemVault 自己的判定**（继承它的 ADD/UPDATE/DELETE、审计与关系），**②C 模型提议、人批准**（不把改库权交给面板）。

### 12.1 先把写策略读清楚（规则 ①）

| 结论 | 出处 |
|---|---|
| `_decide(fact, vec, index)` 与作用域内**最相似的一条**比较：无候选（<0.55）→ ADD；否定关系 → DELETE；同一属性槽位或 ≥0.82 → UPDATE；否则 ADD | `memory.py` |
| `SIM_UPDATE=0.82`、`SIM_CANDIDATE=0.55`、`SIM_CONSOLIDATE=0.92`；**0.55–0.82 的近义改写是刻意并存的**，由 consolidate 收敛 | `memory.py` 顶部常量与其注释 |
| `upsert_memory` 按 **id** 冲突更新（`ON CONFLICT(id) DO UPDATE`），而 `add()` 默认新生成 `mem_<uuid12>`（除非传入已有 id） | `storage.py` / `memory.py` |
| `content_hash(text, user, agent, run)` 存在并有索引 | `memory.py` / `storage.py` |
| `MEMVAULT_EXTRACTOR` = `rule`（默认，离线）\| `llm`；`MEMVAULT_EMBEDDER` = `local` \| `openai` | `config.py` |

### 12.2 设计

- **留存输入（最多 5 份，裁剪）**：重抽需要文本，而抽完就丢的旧行为让重抽不可能；顺带让**失败的抽取**也能重抽，并允许人先改对输入再送。
- **反向索引 `produced: memoryId → {seq, sessionId, inputKey, at, replayOf}`（最多 200）**：诊断只留最近 5 条，没有反向索引的话「这条记忆来自哪个窗口」会随诊断滚出而失效。
- **重抽走 CLI `add()`**：`extractor` 选项 = `inherit`（默认，什么都不加）\| `rule` \| `llm`（后者落成 `MEMVAULT_EXTRACTOR` 环境覆盖）。路由回 **202**——它排队，不阻塞。
- **`/review` 队列**：标记项 + 来源 + 窗口 + 原文是否还在（`replayable`）+ 可编辑的 `inputText` + **`request`**（一份可粘给模型的说明）。队列上限 50，因为每项要三次 provenance 查询。
- **改库的门在哪里**：面板不提议、不删、不改；它把证据交出去，模型用自己的 MemVault 工具提议，DSH 的批准提示是那道门（②C）。重抽是**唯一**会写库的面板动作，并且与块编辑共用 `panel.writes` 开关。

### 12.3 验证（规则 ③）

纯函数：留存输入的边界/裁剪/元数据/不可变、坏输入丢弃、反向索引的上限与"重抽标记"、`validateReplay` 的五种拒绝（未知 key 404、坏 extractor 400、超长 400、低于 minTranscriptChars 400、默认取回原文）与环境覆盖的映射、`shapeReviewItem` / `buildReviewRequest` 的形状与措辞。

端到端（临时库 + 真实 CLI，全是离线 rule 抽取器）：窗口抽取后状态文件里正好 1 份输入（37 字符）→ 反向索引两条都指向它 → 浏览载荷带上反向索引 → 空队列无 request → 标记一条后队列解析出窗口/来源/`replayable: true`/`inputText`/`request` → 重抽被接受（202、key、extractor）→ 新诊断带 `replayOf` 且 `ok added=2` → **同一段文本重抽后 id 完全一致、库仍是 2 行**（证明 ①A 落在 UPDATE 而不是复制）→ 留存输入没被覆盖 → `panel.writes:false` 时重抽 403。

### 12.4 两点小教训（写下来）

21. **测试助手把"主体"写死了。** 上一轮我加的 `browse()` 助手内部固定走 `MEMORIES_PATH`，这一轮复用它去读 `/review` 与 `/replay` 时**悄悄读错了路由**（只会得到 404/405 之类看似正常的失败）。改成 `hit(path, opts)` 后各种路由都能测。教训：测试助手不要隐含路由/资源，参数化它。
22. **测试文件里的重复标识符。** 我把新助手命名为 `hit`，与文件里已有的 `const hit = await browse(...)`（搜索命中）冲突，Node 直接 `SyntaxError: Identifier 'hit' has already been declared`——好在 ESM 立即报错，比运行期才发现好。教训：给测试里的"结果变量"起有含义的名字（`substringHit`），别用 `hit`/`res`/`data` 这类通用名。

---

## 13. 0.9.1：部分写入抹掉兄弟键（真数据丢失，读线上文件才发现）

**症状**：线的状态文件 `~/.dsh/storages/dsh-memvault-state.json` 只有
`watermarks,diagnostics,pending` 三个键——`flags`、`inputs`、`produced` 全都不见了，
而 0.8.0/0.9.0 明明写过它们。

**根因**：`saveState` 用「只把我拿到的键拼成文档」的写法，而 `saveWatermarks`（窗口每次
flush / persistPending / clearPending 都走它）只传 `{watermarks, diagnostics?, pending?}`。
于是**每一次窗口记账都会重写整个文档，顺手抹掉它不认识的三个键**：

```js
const payload = {}                      // 从空开始
if (watermarks) payload.watermarks = …
if (flags) payload.flags = flags        // saveWatermarks 不传 → 键消失
```

后果分三级：复核标记（0.8.0）被静默清空；留存输入与反向索引（0.9.0）被清空，于是
**「重抽」对早于本次修复的窗口永远不可用**；而面板上看起来一切正常——这正是最坏的一类
bug：不报错、不抛异常，只是数据慢慢变少。

**为什么测试没抓到**：面板套件验的是「标记后状态文件里有它」，没验「随后一次窗口 flush
之后它还在」。**跨功能的顺序才是缺陷所在，而单功能的断言看不到顺序。**

**修复**：`saveState` 改为**读盘再合并**（新增 `readStateDocument`），任何调用者都只能覆盖
自己带的键，无法抹掉兄弟键。合并语义下「删除」必须用整份集合作表达——`flags`/`pending`/
`inputs`/`produced` 本来就总是整份传入，所以语义没变。新增 4 条断言：整份写入六键齐全、
部分写入后三键仍在、清空的标记不会被合并「复活」。

**教训**（与 12.4 的 21/22 同类，但更贵）：**多个写入者共享一个文档时，「缺省即删除」是最
危险的默认值**。要么由一个写入者持全量状态，要么写入即合并——不能两者都不做。

---

## 14. 附：怎么读 DSH 自己的源码（踩坑 12 的解法）

要「优先参考源码」时，DSH 的包都在 `app.asar` 这个打包文件里，asar 只是「JSON 头 + 拼接的文件数据」：

- 头：偏移 `12` 处是 4 字节小端 `headerSize`，其后 `headerSize` 字节是 UTF-8 的 JSON 目录树。
- 数据区起点：`16 + align4(headerSize)`——**必须 4 字节对齐**（本机 headerSize 正好差 2 字节，忘了对齐会读出一段错位前缀）。
- 每个叶子节点带 `offset`（相对数据区）与 `size`。

本轮读到的关键文件：`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（profile/bundle 加载、peer 兼容判定）、`dsh-package-manifest/README.md`（manifest 必填字段）、`dsh-system-prompt/README.md`（`ctx.systemPrompt` 与动态上下文的语义）、`dsh-plugin-manager/README.md`（bundle 选择、版本豁免、安装流程）。脚本是一次性工具，不入库。
