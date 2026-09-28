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

- **抽取是同步的、送单轮**：更符合最佳实践的做法是**异步 + 窗口**（攒够 N 轮或空闲时后台跑，送近期多轮），既省成本也提高信噪比——现在会把助手的技术长文也送去做「用户事实」抽取。
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

## 8. 附：怎么读 DSH 自己的源码（踩坑 12 的解法）

要「优先参考源码」时，DSH 的包都在 `app.asar` 这个打包文件里，asar 只是「JSON 头 + 拼接的文件数据」：

- 头：偏移 `12` 处是 4 字节小端 `headerSize`，其后 `headerSize` 字节是 UTF-8 的 JSON 目录树。
- 数据区起点：`16 + align4(headerSize)`——**必须 4 字节对齐**（本机 headerSize 正好差 2 字节，忘了对齐会读出一段错位前缀）。
- 每个叶子节点带 `offset`（相对数据区）与 `size`。

本轮读到的关键文件：`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（profile/bundle 加载、peer 兼容判定）、`dsh-package-manifest/README.md`（manifest 必填字段）、`dsh-system-prompt/README.md`（`ctx.systemPrompt` 与动态上下文的语义）、`dsh-plugin-manager/README.md`（bundle 选择、版本豁免、安装流程）。脚本是一次性工具，不入库。
