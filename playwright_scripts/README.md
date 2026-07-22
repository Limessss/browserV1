# Playwright：MCP 说明（Markdown）与终端脚本（.mjs）成对维护

## 修改脚本前的硬性要求（人 / AI 同守）

**任何**对 `playwright_scripts/**` 下 `*.mjs` 或 `mcp_*.md` 的修改，**都必须**在改仓库之前，先通过 **已连接本机真实浏览器** 完成页上验证。连接方式**优先级**如下：

1. **NexBrowser Live Bridge**（**探针首选**）——按环境码 `profile` / `browser_connect({ code })` 自动 Launch 或复用实例，用 `snapshot` / `observe` / `evaluate` 在真实页上逐步验证；Cursor 注册 MCP（`.cursor/skills/nexbrowser-live-bridge/scripts/mcp-live-bridge.mjs`）或终端 `live-bridge-cmd.mjs -f batch.json`。详见 [`docs/live-bridge/README.md`](../docs/live-bridge/README.md) 与 [`.cursor/skills/nexbrowser-live-bridge/SKILL.md`](../.cursor/skills/nexbrowser-live-bridge/SKILL.md)。
2. **Playwright MCP**——附着带登录态的 **CDP**（`mcp.json` 中 `--cdp-endpoint=...`），在目标站点用 `browser_navigate` / `browser_snapshot` / `browser_click` 等跑通流程。
3. **终端脚本 + CDP / Launch API**——Live Bridge 与 Playwright MCP 均不可用时，用同一 CDP 执行 `node .../xxx.mjs --useLaunchApi --code <环境码>` 或 `--cdp <url>`（**仍是在真实浏览器里**验证，不是无头猜页面）。

**禁止**：未接通真实浏览器、未在真实页上点通流程，就凭记忆或「对齐其它脚本」去改选择器、URL、点击顺序。**Cursor / 其它自动化助手**在收到「改脚本、修可用性、同步选择器」等任务时，**同样必须先完成上述真实浏览器调试**；若当前环境无法连接用户本机浏览器，应**明确说明无法代你完成页上验证**，并请用户贴出实测现象或快照结论后，**再**据实改代码，而不是先改代码再补理由。

下列「开发/修改流程」与本段同等效力，须一并遵守。

---

## 运行时（Node 22）

- **开发机**：`node >= 22`（与根目录 `package.json` 的 `engines` 一致）。
- **打包后**：Playwright 脚本通过 `ELECTRON_RUN_AS_NODE` 执行，使用 **Electron 35+ 内置 Node 22**（当前项目已对齐）。可直接使用 `node:sqlite` 等 Node 22 API，无需再为脚本单独捆绑 Node。

---

## 约定

在 **`playwright_scripts`** 目录内：

1. **每个独立业务流程** 使用 **同名子文件夹**，内含 **`mcp_<主题>.md`**（Cursor MCP 步骤）与 **`*.mjs`**（可执行脚本），二者同步维护。
2. **Markdown** 写清楚：探针优先 **Live Bridge**（`profile` / `navigate` / `evaluate` / `snapshot`）或 Playwright MCP 步骤、前置登录或 CDP。
3. **脚本** 写清楚：入口 URL、`getByRole` 与文档一致、连接方式（Launch API / CDP / Edge / Chromium）。
4. **运行时页面步骤 Toast**（硬性要求，见下节「页面步骤 Toast 规范」）：关键节点必须在浏览器页面上显示中文步骤说明。
5. **禁止 dry-run 模式**（硬性要求，见下节「禁止 dry-run」）：脚本一律真实执行，不提供 `--dryRun` 等只验证不提交的开关。

---

## 结构化脚本结果 `scriptResult`（硬性要求）

每个业务脚本在任务结束前，必须向 stdout 输出一行统一结构化结果，固定前缀为 `scriptResult:`。Launch API 会解析 stdout 中**最后一条** `scriptResult`，并在 `GET /api/playwright-scripts/run/{runId}` 的响应中返回 `run.scriptResult` 与 `run.scriptResultRaw`，供 Nextask 等编排系统判断真实业务结果。

### 自动化运行完成规则

当脚本通过 `--useLaunchApi` 被 Nextask / 工作流 / Agent 调度时，**业务完成即代表 run 完成**，不能再依赖用户点击页面结果弹窗，也不能因为 `NexBrowser.exe` 仍在保活就让 run 一直保持 `running`。

统一规则如下：

- `--useLaunchApi` 默认视为自动化模式：业务结束后必须输出最终 `scriptResult: {...}`，随后让脚本自然退出。
- 自动化模式默认**不展示、不等待** `showPageResultModalUntilAck(...)`。需要人工调试时，显式传 `--showResultModal`。
- 非自动化模式（例如手工 `--cdp` 调试）可以继续展示结果 Modal，方便人工查看。
- `--keepOpen` 只用于人工观察页面状态，不应写入 `script.json` 的 `defaultArgs`，也不应出现在工作流默认参数里。
- 如果脚本有多区域、多店铺或多阶段结果，可以输出中间 JSON 日志，但最后一条 `scriptResult` 必须是最终汇总结果。
- 如果业务已经完成但页面仍需保留观察，应先输出 `scriptResult`，再根据 `--keepOpen` 决定是否等待；不要把等待弹窗当成业务完成条件。

推荐写法：

```js
const useLaunchApi = hasFlag('--useLaunchApi')
const keepOpen = hasFlag('--keepOpen')
const showResultModal = hasFlag('--showResultModal') || (!useLaunchApi && !hasFlag('--noResultModal'))

const result = {
  ok: allOk,
  status: allOk ? 'success' : 'failed',
  summary,
  errors,
}

console.log('scriptResult: ' + JSON.stringify(result))
if (!allOk) process.exitCode = 1

if (showResultModal) {
  await showPageResultModalUntilAck(page, {
    title: result.ok ? '任务已完成' : '任务结束',
    variant: result.ok ? 'success' : 'warning',
    lines,
  })
}

if (keepOpen) await new Promise(() => {})
```

反例：

```js
console.log(JSON.stringify(summary, null, 2))
await showPageResultModalUntilAck(page, opts)
// 错误：自动化模式下会卡住，browserV1 / Nextask 只能看到 run 仍然 running。
```

### 输出格式

```js
console.log('scriptResult: ' + JSON.stringify({
  ok: true,
  status: 'success',
  summary: {
    success: 12,
    failed: 0,
    skipped: 1,
  },
  artifacts: [
    'C:/Nextask/reports/example.json',
  ],
  data: {
    shopCode: 'AF7H54',
    regions: ['MY', 'PH'],
  },
  errors: [],
}))
```

### 字段约定

| 字段 | 必填 | 说明 |
|------|------|------|
| `ok` | 是 | 布尔值，业务是否成功完成；不是脚本进程是否启动成功。 |
| `status` | 是 | 建议值：`success`、`partial`、`failed`、`canceled`。 |
| `summary` | 否 | 汇总数量，如成功/失败/跳过/处理总数。 |
| `artifacts` | 否 | 产物文件或目录路径数组，供后续节点引用。 |
| `data` | 否 | 业务结构化结果，如店铺、地区、商品 ID、runId、目录等。 |
| `errors` | 否 | 错误数组；即使 `ok: false`，也应尽量给出可读原因。 |

### 失败时也必须输出

业务失败、页面拦截、没有数据、部分成功等情况，也必须输出 `scriptResult`，再决定是否 `process.exit(1)`。示例：

```js
console.log('scriptResult: ' + JSON.stringify({
  ok: false,
  status: 'failed',
  summary: { success: 0, failed: 1 },
  artifacts: [],
  data: { shopCode: 'AF7H54', region: 'PH' },
  errors: [
    { message: '关键词提交页没有找到可绑定商品', step: 'submit_keywords' },
  ],
}))
process.exit(1)
```

### 自检清单（scriptResult）

- [ ] 正常成功路径输出一条 `scriptResult: {...}`
- [ ] 异常/失败路径也输出一条 `scriptResult: {...}`
- [ ] `ok` 表示业务是否成功，不用来表示 HTTP 是否提交成功
- [ ] 产物目录、报告文件、关键业务 ID 放入 `artifacts` 或 `data`
- [ ] `errors` 中包含用户能看懂的失败原因和步骤名
- [ ] stdout 中如有多条 `scriptResult`，最后一条必须代表最终结果
- [ ] `--useLaunchApi` 自动化模式不等待 `showPageResultModalUntilAck(...)`
- [ ] 需要弹结果窗口时，使用 `--showResultModal` 显式开启
- [ ] `--keepOpen` 仅用于人工调试，不写入 `script.json.defaultArgs`

---

## 页面步骤 Toast 规范（硬性要求）

用户在 Launch 实例里**看着浏览器跑脚本**时，需要知道当前进行到哪一步。每个业务脚本必须在**关键操作节点**调用 Toast，在页面底部显示 **3 秒一闪** 的中文提示；终端 `console.log` 同步输出同样文案。

### 统一实现

- **推荐**：从共享模块引入，不要各脚本复制粘贴 UI 代码：

```js
import { logProgress, showPageToast, showPageResultModalUntilAck } from '../_lib/page_runtime_ui.mjs'
```

| 函数 | 用途 |
|------|------|
| `logProgress(page, msg)` | `console.log` + `showPageToast` 二合一（最常用） |
| `showPageToast(page, msg)` | 仅页面 Toast |
| `showPageResultModalUntilAck(page, opts)` | 任务结束汇总弹窗（单区域 1 次 / 多区域最后 1 次） |

- **常量**（由 `_lib/page_runtime_ui.mjs` 导出，勿自行改数值）：
  - `PAGE_TOAST_MS = 3000`：每条 Toast 展示时长
  - `PAGE_TOAST_DOM_ID = 'ant-playwright-top-toast'`：DOM 根节点 id（全脚本共用）
  - `PAGE_MODAL_IDLE_BROWSER_CLOSE_MS = 30000`：汇总 Modal 无操作 **30 秒**后自动关浏览器；`--keepOpen` 时不倒计时

- **所有业务脚本**均从 `_lib/page_runtime_ui.mjs` 引入，**禁止**在脚本内复制 Toast / Modal 实现。

### 文案格式

- **前缀**：一律 `[脚本]`；多区域时加区域标签：`[脚本 [区域 2/5 · PH]]` 或 `[脚本] 开始… [区域 2/5 · PH]：…`
- **语言**：简体中文，说明**正在做什么**，不要只打英文 debug 键名
- **长度**：单条 ≤ 600 字符（模块内已截断）
- **示例**：
  - `[脚本] 开始商品批量优化更新：区域 MY`
  - `[脚本] 第 2/20 轮：正在打开商品优化页（区域 MY）`
  - `[脚本] 第 3 批：已点击「更新 5 件商品」（5 件）`
  - `[脚本] 区域 MY 已完成，继续下一区域：PH`

### 必须覆盖的节点（按脚本类型取舍）

| 类型 | 建议 Toast 节点 |
|------|----------------|
| 通用 | 任务开始、当前区域/店铺、关键步骤开始、单步成功/失败、区域切换、任务结束 |
| 多步骤循环 | 循环序号（`i/n`）、当前处理对象 id/名称 |
| 有副作用提交 | 提交前一句、提交结果一句（成功 / 未完成 / 异常） |

导航、等待 DOM、点按钮、调 API、写报告等**用户能感知耗时的步骤**都应有一句 Toast；纯内部重试、毫秒级轮询不必每条都打。

### 视觉样式（由共享模块固定，勿改）

- **位置**：`position: fixed`，贴页面**底部居中**，`z-index: 2147483646`
- **交互**：`pointer-events: none`，不挡页面点击
- **外观**：深色渐变底 + 左侧青紫竖条 + 圆角顶边；入场/退场用 `ant-pw-toast-in` / `ant-pw-toast-out` 动画
- **汇总 Modal**：全屏半透明遮罩 + 居中面板；标题 + 等宽字体明细；「确定」按钮；非 `--keepOpen` 时按钮显示 `确定（mm:ss）` 倒计时

### 结束汇总 Modal

- **单区域**：跑完后弹 1 次，列出成功/失败数、关键 id、错误摘要
- **多区域**：全部跑完后**只弹 1 次**汇总（不要在每个 region 各弹一次）
- `opts`: `{ title, variant: 'success'|'warning'|'danger', lines: string[] }`；是否保持浏览器由命令行 `--keepOpen` 决定（模块内自动读取，**不要**写入 `defaultArgs`，调用时也无需再传）
- 同步更新 `mcp_*.md` 增加「页面运行步骤说明」表格；`script.json` 的 `argsHint` 注明已支持 Toast / 汇总 Modal

### 自检清单（Toast）

- [ ] 已从 `_lib/page_runtime_ui.mjs` 引入（未内联复制 UI 代码）
- [ ] 任务开始、主要步骤、循环进度、结束/切换区域均有 `[脚本]` Toast
- [ ] 终端日志与页面 Toast 文案一致（用 `logProgress`）
- [ ] 单/多区域结束有汇总 Modal（`--keepOpen` 时不自动关浏览器）
- [ ] `mcp_*.md` 有步骤说明表；`script.json` 的 `argsHint` 已提及

---

## 启动参数面板（硬性要求）

每个**业务脚本**在**浏览器连接成功后、进入业务 URL 之前**，必须调用共享模块打开参数 Tab（不阻塞主流程）：

```js
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openScriptArgsPanel } from '../_lib/script_args_panel.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

// connectOverCDP / Launch 拿到 browser 或 page 之后：
await openScriptArgsPanel(page, { scriptDir: SCRIPT_DIR })
// 或 await openScriptArgsPanel(connection.browser, { scriptDir: SCRIPT_DIR })
```

| 模块 | 说明 |
|------|------|
| `_lib/script_args_panel.mjs` | `openScriptArgsPanel`：新开 Tab，展示本轮参数 + 表单编辑保存 |
| `_lib/script_args_store.mjs` | 读写 `playwright_scripts/_user_defaults/<scriptId>.json` |
| `_lib/script_args_form.mjs` | `argForm` 与 CLI `defaultArgs` 互转、人类可读摘要 |

### 面板内容

1. **本轮正在使用的参数**（只读）：按 `argForm` 字段转成中文摘要（无表单时显示原始 CLI）
2. **我的默认启动设置**（可编辑）：`script.json` 中配置 **`argForm`** 时渲染为输入框 / 勾选 / 下拉 / 多选；保存后写入 `_user_defaults/`

### script.json 的 `argForm`（推荐）

在 `script.json` 增加 `argForm` 数组，参数面板自动切换为**表单模式**（无则退回「每行一个参数」文本模式）。

| 字段属性 | 说明 |
|----------|------|
| `type` | `info`（说明条）、`boolean`、`text`、`number`、`select`、`multiselect` |
| `id` | 表单控件 id（`showWhen` 引用） |
| `flag` | 对应 CLI，如 `--code` |
| `label` | 用户可见标题 |
| `description` | 字段下方灰色说明（必填，写清用途与示例） |
| `default` | 出厂默认值 |
| `asFlag` | `boolean` 专用：为 true 时勾选即追加 flag（无值） |
| `options` | `select` / `multiselect` 选项：`{ value, label }` |
| `showWhen` | 条件显示，如 `{ "use_launch": true }` |
| `required` | 前端标红星（保存时仍由用户自行确认） |

参考实现：各业务目录 `script.json` 的 `argForm`（7 个 TikTok 脚本均已配置）。

### 约定

- **禁止**在业务脚本内复制参数面板 HTML/CSS；一律 `import` 共享模块。
- **不要**把 `--keepOpen` 写入 `defaultArgs`；调试时手动加 CLI 即可。
- CI / 无 UI 跑法可加 `--skip-args-panel` 或 `SKIP_SCRIPT_ARGS_PANEL=1`。
- 多区域脚本：仅在**首次**连上浏览器时打开一次面板（如 `regionIndex === 0`）。
- 无浏览器分支（如 `--from_json` 纯离线）可跳过。

### 自检清单（参数面板）

- [ ] 已 `import openScriptArgsPanel` 且在连上浏览器后调用
- [ ] `scriptDir` 指向本业务目录（含 `script.json`）
- [ ] `mcp_*.md` / `argsHint` 注明支持参数面板与 `_user_defaults` 覆盖

---

## 禁止 dry-run（硬性要求）

**所有业务脚本不提供、不保留 dry-run / 只验证不执行 模式。**

- **禁止**：`--dryRun`、`--dry-run`、`--strict-dryrun` 等 CLI 开关，以及「只定位按钮不点击」「只打日志不真实提交」「跳过 POST/标记」等分支。
- **必须**：脚本默认即**真实副作用**（更新商品、DOM 提报、发送邀约、ERP 采集、发布视频等）。需要观察页面时用 `--keepOpen` 保持浏览器打开，或看 Toast / 汇总 Modal / 终端 JSON，而不是用 dry-run 代替。
- **探针**：`_temp/` 内临时探针可停在提交前一步做定位，但**不得**把 dry-run 开关合进主 `.mjs`；探针验证通过后，主流程迁移为真实执行。
- **文档**：`mcp_*.md`、`script.json`、`defaultArgs` 中不得再写 dryRun 示例或参数说明；历史报告 JSON 里的 `"dryRun": false` 仅为旧输出，可忽略。

---

### 开发/修改流程（必守）

**顺序不能颠倒：** 须**先**完成下列「**连接真实浏览器** + 页上调试」，**再**改仓库里的 `*.mjs` / `mcp_*.md`。这里的「真实浏览器」指通过 MCP/CDP 附着、与本应用 Launch 一致的**已登录会话**，不是凭空改写脚本再在别处猜测验证。

**禁止**先改代码、再补验证；**禁止**不经页上验证仅凭猜测改选择器或点击路径；**禁止**在未确认 CDP/MCP 可用的前提下直接提交脚本改动。

#### 探针优先流程（新建、调试、修改、修复脚本时必守）

对任何业务脚本的新建、调试、修改、修复，默认流程必须是：

1. **先用 Live Bridge 探针，不先改主流程**
   - **首选**：NexBrowser Live Bridge——用户给了环境码时必须 `profile { "code": "BUPM2Z" }`（勿用 `attach` 挂错实例）。
   - **Cursor**：注册 Live Bridge MCP 后使用 `browser_connect` → `browser_snapshot` / `browser_observe` → `browser_evaluate`（或 `click_ref`）单步验证。
   - **终端**：用 `live-bridge-cmd.mjs` 发单条或 batch JSON（Windows 推荐 `-f batch.json`）：

     ```bash
     # 按 code 连接 + 观察当前页
     node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs send profile "{\"code\":\"0ZF9ZK\"}"
     node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs observe

     # 一次连接多条命令（探针 batch 建议放在业务目录 _temp/）
     node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs -f playwright_scripts/<主题>/_temp/live-bridge-<目标>.json
     ```

   - batch 内典型步骤：`profile` → `navigate` → `wait_for`（selector/text/url）→ `evaluate`（读 DOM / 测滚动 / 测 API）→ 可选 `snapshot` / `screenshot`。
   - **禁止**为简单 DOM 探针新建临时 `.mjs`——能用 Live Bridge `evaluate` / `snapshot` 解决的，不要写脚本。
   - Live Bridge 不便表达的长循环、写文件、复杂 ERP 联调时，再在 `_temp/` 写 `probe_*.mjs`（见下条）。

2. **必要时写 `_temp/*.mjs` 探针（Live Bridge 的补充）**
   - 在对应业务目录下的 `_temp/` 子文件夹中新建或更新临时探针，建议命名为 `probe_<目标>.mjs`。
   - 不要把临时探针散放在业务目录根部；例如应使用 `playwright_scripts/<主题>/_temp/probe_scroll.mjs`。
   - 探针只验证一个具体问题；必须连接真实登录浏览器：优先 `--useLaunchApi --code <环境码>`，或通过同一 CDP `connectOverCDP`。
   - 调试过程中创建的 Live Bridge batch JSON、临时日志、截图、JSON 快照、HTML/DOM dump、测试数据，统一放入 `_temp/`。

3. **探针必须得到可用结论**
   - 记录探针验证到的关键事实：URL、按钮/输入框文本、可用选择器、必要等待、DOM 状态、返回值、异常分支。
   - 如果探针未跑通，不能把猜测逻辑迁到主 `.mjs`。
   - 如果页面状态、弹窗、二次确认、异步刷新不稳定，要用探针覆盖“出现”和“不出现”两类分支。

4. **再更新主 `.mjs`**
   - 只迁移探针已验证可用的逻辑。
   - 主流程改动要尽量局部，保留原有参数与返回结构；**不得**新增 dry-run 分支。
   - 对提交、删除、覆盖、批量变更等有副作用的动作：用 Live Bridge 或 `_temp/` 探针验证到提交前一步，主流程迁移后**直接真实执行**；跑完用 Toast / 终端 JSON / 汇总 Modal 确认结果。

5. **最后验证主流程**
   - 先运行 `node --check <主脚本>.mjs`。
   - 再用真实浏览器跑主流程（可用 `--keepOpen` 观察 Toast 与汇总 Modal），确认探针逻辑迁移后仍然有效。
   - 真实执行后回读页面结果或脚本返回值，确认成功、失败或被弹窗拦截的具体原因。

6. **同步文档**
   - 主流程修复后，同步更新业务目录内的 `mcp_*.md`、`script.json` 参数说明或测试命令。
   - 任务完成后清空 `_temp/` 子文件夹内本次任务产生的所有临时文件，避免后续误用过期探针、日志或测试数据。
   - 若确有长期保留价值，应改造成正式诊断工具或正式数据文件并写入文档，而不是继续放在 `_temp/` 中。

**特别禁止**：用户要求“修复问题”时直接改主 `.mjs`；应**先用 Live Bridge 或 `_temp/` 探针**复现/定位/验证，再迁移到主流程。除非用户明确说“只改文案、只改常量、只改文档”，否则默认都按探针优先处理。

1. **启动并接通浏览器探针**  
   - **首选 Live Bridge**：NexBrowser 主程序在跑；Cursor 启用 Live Bridge MCP，或终端 `live-bridge-cmd.mjs` 可连 `ws://127.0.0.1:19876/api/live-bridge`。  
   - **或 Playwright MCP**：在 Cursor 中确认 **Playwright MCP 已启用且处于已连接状态**（`mcp.json` 里 `@playwright/mcp` 带 `--cdp-endpoint=...`）。  
   - 本机 **须有可调试、已登录** 的浏览器实例（通常 `--useLaunchApi --code <环境码>` 或 Live Bridge `profile { code }` 自动拉起）。  
   - **尚未接通探针、或目标页尚无登录会话时，不要开始改脚本。**

2. **在真实页面上用 Live Bridge / MCP 调试**  
   - Live Bridge：`profile` → `navigate` → `wait_for` → `snapshot` / `evaluate` 单步确认 **URL、交互步骤、选择器/文案、关键 DOM**。  
   - Playwright MCP：`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_evaluate` 等等价步骤。

3. **最后再更新仓库**  
   - 将上述实测结论写入 **`mcp_*.md`** 与 **`*.mjs`**；探针 batch JSON 或结论摘要写入业务目录 `_temp/`（任务结束后按需清理）。

**若 Live Bridge 与 Playwright MCP 均无法连上本机浏览器**：不得跳过页上验证；须改用同一 CDP 的等价手段（见下段）：在本机执行 `node .../xxx.mjs --useLaunchApi --code <环境码>` 或 `--cdp http://127.0.0.1:19876`，**仍然是在真实页面上的调试**，再把结论写回 `mcp_*.md` 与脚本。

### CDP 与 Launch 默认端口 `19876`（本应用）

- 该端口是 **Launch HTTP 服务**；仅当**已有活跃浏览器档案**（内部已登记 `debugPort`）时，才会把 DevTools 流量**代理**到真实 Chromium。若**未**先在应用内启动档案、也**未** `POST /api/launch` 成功拉起会话，则 `connectOverCDP('http://127.0.0.1:19876')` 可能报 **503**、或提示「不像 DevTools」——**先启动/Launch 再连**，不是端口写错。
- 终端调试可优先用脚本的 **`--useLaunchApi`**：会调 `/api/launch` 打开 Compass 等 `startUrl` 并得到可用的 `cdpUrl`，避免「只有 Health、没有浏览器」的空连。

MCP 应配置为附着**已登录**的浏览器（例如 `mcp.json` 中 `--cdp-endpoint=...` 指向本机带登录态的 CDP）。

## 如何连接真实浏览器（最直接）

**原则：** 先在本机有一个**带远程调试**的 Chromium（Launch 返回的 `cdpUrl`、或能打开 `/json/version` 的地址），再 **`chromium.connectOverCDP(url)`**。仓库里的脚本等价于在命令行传 **`--cdp <url>`**。

**办法 A（推荐）：`--useLaunchApi`**  
1. 确认 Launch 可用：`GET http://127.0.0.1:19876/api/health` 返回 `{"ok":true}`（端口以你环境为准）。  
2. 运行脚本时加上 **`--useLaunchApi`** 和 **`--code <环境码>`**（及业务需要的 `--shop_region` 等）。脚本会 **`POST /api/launch`** 拉起浏览器、打开脚本的 `startUrl`，再 **`connectOverCDP`** 到返回地址（一般为 `http://127.0.0.1:19876`）。**无需自己查 debug 端口。**

**办法 B：应用里已经开好浏览器**  
1. 在 NexBrowser 里**启动**目标环境档案（已登录 TikTok 卖家中心等）。  
2. 再运行：`node playwright_scripts/.../xxx.mjs --cdp http://127.0.0.1:19876 ...`  
   此时 **19876** 仅在有**活跃**档案（内部已登记 `debugPort`）时把 DevTools **代理**到真 Chrome；未启动实例时会 **503**，须先办法 A 或在应用内点开浏览器。

**办法 C：直连 Chromium 调试端口**  
若你用 `--remote-debugging-port=xxxxx` 等方式单独起了 Chrome，且浏览器根地址 **`http://127.0.0.1:xxxxx`** 下 `/json/version` 正常，则 **`--cdp http://127.0.0.1:xxxxx`**（MCP 的 `--cdp-endpoint` 也用同一 URL）。

**Playwright MCP（Cursor）**  
在 `mcp.json` 里为 Playwright MCP 配置 **`--cdp-endpoint=`**，与上列 **同一** CDP 地址（常用有活跃实例时的 **`http://127.0.0.1:19876`**），这样 MCP 与终端脚本附着**同一台**真实浏览器。

**NexBrowser Live Bridge（探针首选）**  
WebSocket：`ws://127.0.0.1:19876/api/live-bridge`（与 Launch 同端口）。**不依赖**事先手动 Launch——`profile { code }` 会按环境码自动拉起或复用实例。  
- Cursor：`.cursor/mcp.json` 注册 `nexbrowser` → `node .cursor/skills/nexbrowser-live-bridge/scripts/mcp-live-bridge.mjs`  
- 终端：`node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs -f <batch.json>`  
- 文档：[`docs/live-bridge/README.md`](../docs/live-bridge/README.md)

---

本文件为 **`README.md`**，位于 **`playwright_scripts/`** 根目录，作为约定与示例索引（写脚本前可先读本文）。

## `script.json`（应用内「自动化脚本」列表）

每个**业务子目录**可放置固定文件名 **`script.json`**，供桌面端扫描并展示；**必填**字段如下。

| 字段 | 说明 |
|------|------|
| `name` | 展示名称 |
| `description` | 简介 |
| `entry` | 入口脚本相对本目录的文件名，如 `baidu_today_weather.mjs` |

**常用可选字段**：`id`（缺省为文件夹名）、`order`（排序）、`tags`、`version`、`defaultArgs`（字符串数组，与 UI「附加参数」合并传入 Node）、`argsHint`、`requiresLaunchServer`（为 `true` 时若 Launch HTTP 未就绪会提示）、`mcpDoc`（相对路径，如 `mcp_xxx.md`）。  
若缺少 `script.json`、JSON 不合法或 `entry` 文件不存在，该目录会在应用内列表中跳过并出现**扫描提示**。

## 从仓库根运行示例

```bash
node playwright_scripts/baidu_today_weather/baidu_today_weather.mjs --useLaunchApi --code ICHPPH
node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --useLaunchApi --code ICHPPH--shop_region PH
node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --cdp http://127.0.0.1:19876 --shop_region PH --days_ago 2
node playwright_scripts/tiktok_compass_top10_random5_ai_video/tiktok_compass_top10_random5_ai_video.mjs --useLaunchApi --code ICHPPH --shop_region PH
node playwright_scripts/launch_and_connect/launch_and_connect.mjs
```

## 新增一组时的检查清单

- [ ] **已先用 Live Bridge 或 MCP/CDP 连接真实浏览器，并在目标页完成调试**，再编写/修改 `*.mjs` 与 `mcp_*.md`（助手改脚本前同样勾选此项）
- [ ] 已用 **Live Bridge batch / evaluate** 或业务目录 `_temp/` 内探针，在真实浏览器中复现或验证目标问题
- [ ] 探针已得到明确可用结论：可用选择器、点击顺序、等待条件、异常分支、页面返回值或本地存储结果
- [ ] 只把探针验证通过的逻辑迁移到主 `<主题>.mjs`，未验证的猜测逻辑不进主流程
- [ ] 主 `<主题>.mjs` 已通过 `node --check`，并至少完成一次真实浏览器验证（含 Toast / 汇总 Modal）
- [ ] 关键步骤已接 `logProgress` / `showPageToast`，结束有汇总 Modal；**无** `--dryRun` 参数或分支
- [ ] 临时日志、截图、JSON 快照、DOM dump、测试数据等调试产物均放入 `_temp/`
- [ ] 任务完成后已清空 `_temp/` 子文件夹内本次任务产生的临时文件
- [ ] 新建文件夹 `playwright_scripts/<主题>/`
- [ ] `mcp_<主题>.md` + `<主题>.mjs`（或约定主文件名）
- [ ] 同一主题文件夹内 `mcp_*.md` 与 `.mjs` 的说明、路径、示例命令相互引用一致
