# AI 浏览器接管（Live Bridge）使用文档

Live Bridge 是 NexBrowser 内置的 **实时浏览器桥**：通过 WebSocket 以「对话式」方式操作本机已 Launch 的 Chromium 实例——发指令、收截图/DOM/页面事件，适合 AI Agent、自动化调试与人工接管。

---

## 功能概览

| 能力 | 说明 |
|------|------|
| 实时操作 | 导航、点击、输入、执行 JS、截图、读取 DOM、**提取正文 Markdown** |
| 语义化定位 | `snapshot` 返回 A11y tree（元素带 `[ref=eN]`），`click_ref` / `type_ref` 按 ref 精确操作 |
| 页面感知 | `observe` 返回当前场景、弹层、输入框、发送按钮等结构化状态 |
| 智能等待 | `wait_for` 等待 URL / 文本 / 选择器 / 网络空闲条件满足 |
| 多标签页 | `tabs_list` / `tab_select` / `tab_new` / `tab_close` |
| 按 code 启动 | `profile` / `browser_connect({ code })` **自动 Launch 或复用**指定 profile，无需用户手动 Launch |
| 轻量附着 | `attach` 附着到**最近 Launch** 的浏览器（**未指定 code 时**），不重启、不跳首页 |
| 事件推送 | 页面跳转、控制台日志等主动推送到客户端 |
| 多会话 | 最多 **8 个** WebSocket 客户端并发，每个连接是独立 Session（各自的当前 tab 与命令队列） |
| MCP Server | `mcp-live-bridge.mjs` 把全部能力封装成标准 MCP 工具，可注册到 Codex / Claude Code / Openclaw / Cursor 等 |

---

## 入口与端点

### 应用内 UI

侧边栏：**自动化 → AI浏览器接管**（路径 `/browser/live-bridge`）

### WebSocket 端点

```
ws://127.0.0.1:<launchPort>/api/live-bridge
```

默认 `launchPort` 为 **19876**（可在系统设置 / Launch 服务配置中修改）。

> Launch HTTP 服务随 NexBrowser 主进程启动；仅监听 **127.0.0.1**，外网无法直连。

### 鉴权（可选）

若在设置中启用了 Launch API 鉴权，WebSocket 握手需携带与 HTTP 相同的 API Key 头（默认 `X-Ant-Api-Key`）。应用内 UI 可在连接栏填写 Token。

---

## 推荐操作流程（Agent）

**核心原则：有 code 用 profile → 观察 → 单步动作 → 再观察。**

```
用户给了 profile code（如 BUPM2Z）？
  ├─ 是 → profile { code } 或 MCP browser_connect({ code })  【自动 Launch/复用】
  └─ 否 → attach 或 browser_connect()

observe / snapshot
  ├─ 登录页 → 提示用户手动登录 → wait_for → 重新 observe
  └─ 已登录 → click_ref / navigate / … → wait_for → snapshot 验证
```

**前置条件：** NexBrowser 主程序在跑即可；**无需**用户手动去实例列表 Launch。

### 配置页（AI浏览器接管）

用于查看 Launch 服务状态、复制 MCP 配置、打开 Skill 目录。日常任务在 Codex、Claude Code、Openclaw、Cursor 等 Agent 中下指令即可。

---

## 协议格式

### 客户端 → 服务端（命令）

每条命令必须带唯一 `id`，便于匹配响应：

```json
{
  "id": "r1",
  "cmd": "observe",
  "args": {}
}
```

### 服务端 → 客户端（响应）

```json
{
  "id": "r1",
  "ok": true,
  "result": { }
}
```

失败时：

```json
{
  "id": "r1",
  "ok": false,
  "error": "错误说明"
}
```

### 服务端 → 客户端（事件推送）

无需 `id`，由服务端主动发送：

```json
{
  "type": "event",
  "event": "hello",
  "data": { }
}
```

| 事件 | 说明 |
|------|------|
| `hello` | 连接成功；`data.session` 含 `sessionId` 与是否已有附着会话 |
| `page_changed` | 当前 tab 的 URL 发生变化 |
| `console` | 当前 tab 的浏览器控制台输出 |
| `detached` | 浏览器 CDP 断开（如实例被关闭） |
| `tab_closed` | 当前 tab 被关闭 |
| `rejected` | 超过最大并发会话数（8），连接被拒绝 |

`hello` 示例：

```json
{
  "type": "event",
  "event": "hello",
  "data": {
    "ts": 1781177109959,
    "session": {
      "sessionId": "318fb5f1-...",
      "attached": false,
      "activeCode": null,
      "debugPort": null,
      "url": null,
      "sessions": 1
    }
  }
}
```

---

## 命令参考

### 会话与感知（优先使用）

| 命令 | args | 说明 |
|------|------|------|
| `ping` | — | 心跳；返回 `session` 快照 |
| `attach` | — | 附着到当前已 Launch 的浏览器，**不重启**；返回 `observe` 结构 |
| `observe` | — | 读取当前页结构化状态（场景、弹层、聊天输入框等） |
| `profile` | `{ "code": "BUPM2Z", "force": false }` | 按环境码拉起/连接 profile；同 code 且页面仍存活时会 **复用**；`force: true` 强制重连 |
| `snapshot` | `{ "maxChars": 50000 }` | A11y tree 快照，元素带 `[ref=eN]` 稳定标记；返回 `snapshotId` |

### 语义化操作（优先于 CSS 选择器）

| 命令 | args | 说明 |
|------|------|------|
| `click_ref` | `{ "ref": "e12", "timeout": 10000 }` | 按 snapshot 的 ref 点击；ref 失效返回 `stale_snapshot` |
| `type_ref` | `{ "ref": "e5", "text": "..." }` | 按 ref 填充输入框 |

### 智能等待

| 命令 | args | 说明 |
|------|------|------|
| `wait_for` | `{ "url"? / "text"? / "selector"? / "selector_gone"? / "network_idle"?, "timeout": 15000 }` | 等到条件满足即返回 `{ satisfied, waitedMs, url }`，代替盲目 `wait` |

### 多标签页

| 命令 | args | 说明 |
|------|------|------|
| `tabs_list` | — | 列出所有 tab：`{ index, url, title, active }` |
| `tab_select` | `{ "index": 1 }` | 切换当前 Session 操作的 tab |
| `tab_new` | `{ "url"? }` | 新建 tab，可选直接打开 URL |
| `tab_close` | `{ "index"? }` | 关闭 tab（缺省关当前），自动回落到剩余 tab |

### 页面操作

| 命令 | args | 说明 |
|------|------|------|
| `url` | — | 当前 URL 与 title |
| `navigate` | `{ "url": "https://...", "timeout": 30000 }` | 跳转（仅在 observe 判断需要时使用） |
| `back` / `forward` / `reload` | — | 浏览器历史/刷新 |
| `wait` | `{ "ms": 1000 }` | 等待（最大 60000 ms） |
| `screenshot` | `{ "fullPage": false }` | PNG 截图，返回 `imageBase64` |
| `read_dom` | `{ "maxChars": 20000 }` | 返回页面原始 `text` / `html`（含导航噪音） |
| `extract_content` | `{ "maxChars"?, "includeHtml"?, "contentSelector"?, "useAsync"? }` | **Defuddle 提取正文 Markdown** + 元数据（title/author/…），适合 AI 阅读 |
| `find` | `{ "selector": "..." }` | 查询元素数量、文本、可见性 |
| `click` | `{ "selector": "...", "timeout": 10000 }` | 点击（支持 Playwright 选择器，如 `text=发送`） |
| `type` | `{ "selector": "...", "text": "..." }` | 填充输入框 |
| `evaluate` | `{ "expression": "..." }` | 在页面上下文执行 JS |
| `console_log` | — | 返回已缓冲的控制台日志 |

> 除 `ping` / `attach` / `profile` 外，其余命令需先完成 **`profile`（有 code）或 `attach`（无 code）**。

---

## `observe` 返回结构

```json
{
  "activeCode": "BUPM2Z",
  "url": "https://seller.example.com/chat/inbox/current?...",
  "title": "客服会话管理",
  "scene": "chat_inbox",
  "chat": {
    "searchPlaceholder": "搜索所有聊天记录",
    "activeCustomer": "customer_name",
    "messageInput": {
      "placeholder": "在此输入你的消息",
      "value": "",
      "visible": true
    },
    "sendButton": {
      "text": "发送",
      "enabled": true
    },
    "filters": ["全部", "紧急 (7)", "未回复 (0)"],
    "overlays": ["不再显示", "关闭页面"]
  },
  "hints": [
    "页面有弹层: 不再显示, 关闭页面",
    "发送按钮可用"
  ]
}
```

### `scene` 取值

| 值 | 含义 |
|----|------|
| `homepage` | 商家首页类 URL |
| `chat_inbox` | 客服会话列表/收件箱 |
| `chat_session` | 已打开具体会话（有可见消息输入框） |
| `other` | 其他页面（登录页等） |
| `unknown` | 无法识别 |

### `hints` 常见提示

- `页面有弹层: …` — 需先关闭引导/确认框
- `输入框已有草稿` — 输入框内已有未发送内容
- `发送按钮可用` — 可以发送消息
- `当前无未分配会话` — 客服 inbox 无未分配聊天

---

## 使用示例

### 1. 应用内 / Agent 自定义 JSON

**按 code 打开（推荐，用户指定 BUPM2Z 等时）：**

```json
{ "cmd": "profile", "args": { "code": "BUPM2Z" } }
```

**观察当前页：**

```json
{ "cmd": "observe" }
```

**未指定 code 时，附着最近 Launch 的实例：**

```json
{ "cmd": "attach" }
```

**点击发送按钮：**

```json
{ "cmd": "click", "args": { "selector": "button:has-text(\"发送\")" } }
```

**在页面执行 JS：**

```json
{
  "cmd": "evaluate",
  "args": { "expression": "document.title" }
}
```

### 2. Node.js 最小客户端

依赖：项目已安装 `ws`（`package.json` 中已有）。

```javascript
import WS from 'ws'

const ws = new WS('ws://127.0.0.1:19876/api/live-bridge')
const pending = new Map()
let seq = 0

function send(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = `r${++seq}`
    const timer = setTimeout(() => reject(new Error(`timeout: ${cmd}`)), 30000)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    ws.send(JSON.stringify({ id, cmd, args }))
  })
}

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.type === 'event') {
    console.log('[event]', msg.event, msg.data)
    return
  }
  const resolve = pending.get(msg.id)
  if (resolve) { pending.delete(msg.id); resolve(msg) }
})

ws.on('open', async () => {
  const CODE = 'BUPM2Z' // 用户指定的 profile 环境码

  // 1. 有 code → profile（自动 Launch/复用）；无 code → attach
  let r = CODE
    ? await send('profile', { code: CODE })
    : await send('attach')
  if (!r.ok && CODE) {
    r = await send('attach')
  }
  console.log('connect:', r.result?.scene, r.result?.url)

  // 3. 观察 → 单步操作 → 再观察
  r = await send('observe')
  console.log('hints:', r.result?.hints)

  r = await send('screenshot', { fullPage: false })
  if (r.ok) {
    const fs = await import('node:fs/promises')
    await fs.writeFile('shot.png', Buffer.from(r.result.imageBase64, 'base64'))
  }

  ws.close()
})
```

### 3. 客服场景示例流程（已 profile 连接后）

```
profile { code: "xxx" }   或 browser_connect({ code })
observe          → scene=chat_inbox, hints 含弹层
click 关闭页面    → text=关闭页面
observe          → overlays 为空
click 打开会话    → text=jusayaun.com
observe          → messageInput.visible=true, sendButton.enabled=true
evaluate 填入消息 → 对 textarea 设置 value 并 dispatch input 事件
click 发送        → button:has-text("发送")
observe          → 确认 input 已清空
```

---

## 注意事项与限制

| 项 | 说明 |
|----|------|
| **多会话** | 最多 8 个并发连接；AI 外部工具与 UI 页可同时使用，互不顶替 |
| **localhost** | 仅 127.0.0.1 / ::1 可连，设计上不暴露到局域网 |
| **命令串行** | 每个 Session 内命令串行；对同一 tab 的副作用命令（click/type/navigate 等）跨 Session 也会串行 |
| **ref 时效** | snapshot 的 ref 在页面变化/新快照后失效，收到 `stale_snapshot` 时重新 `snapshot` |
| **React 输入框** | 部分站点 `type` 不足以触发框架更新，需用 `evaluate` 设置 value 并 `dispatchEvent(new InputEvent('input', …))` |
| **选择器** | `click` / `type` 使用 Playwright 选择器语法（`text=…`、`css=…` 等） |
| **observe 为启发式** | `scene` / `hints` 基于 DOM 推断，复杂页面可能需要结合 `screenshot` / `read_dom` / **`extract_content`**（长文 Markdown） |

---

## 反模式（避免）

❌ **每步都新建 WebSocket 并重跑 `profile` + `navigate` 回首页**  
→ 丢失当前页面上下文，看起来像「脚本重播」。

❌ **不 observe/snapshot 就盲目 navigate**  
→ 可能已在目标页却被强制跳走。

❌ **用 `wait` 固定毫秒数等待页面**  
→ 用 `wait_for` 等条件，更快也更稳。

❌ **拿旧快照的 ref 操作新页面**  
→ 会收到 `stale_snapshot`，需重新 `snapshot`。

❌ **忽略 `hints` 中的弹层**  
→ 后续 click 被遮罩拦截，操作无效。

✅ **保持一条长连接**  
✅ **有 code → `profile` / `browser_connect({ code })`；无 code → `attach`**  
✅ **`snapshot` → `click_ref`/`type_ref` → `wait_for` → 再 `snapshot`**

---

## 故障排查

| 现象 | 处理 |
|------|------|
| 用户指定了 code 但挂错实例 | 不要用 `attach`；改用 `profile { code }` 或 `browser_connect({ code })` |
| `当前没有已 Launch 的浏览器`（attach） | 改用 `profile { code }`，或让用户提供环境码 |
| `no page — send attach or profile first` | 先 `profile`（有 code）或 `attach`（无 code） |
| 打开后是登录页 | 正常；提示用户手动登录，`wait_for` 后继续 |
| `401 Unauthorized` | 在设置中查看 Launch API 鉴权，连接时填写 API Key |
| 点击/输入无效 | 先 `observe` 检查 `overlays`；用 `screenshot` 确认元素是否被遮挡 |
| `stale_snapshot` | 重新 `snapshot`，用最新 ref |

---

## Playwright 脚本开发规约（全局，必守）

凡在 `playwright_scripts/**` 下**新建或修改业务脚本**（含 Live Bridge / MCP 驱动的自动化），除 `playwright_scripts/README.md` 中的 Toast、禁止 dry-run 等约定外，还必须遵守 **启动参数面板** 规约：

### 必须做什么

1. **连接浏览器后立刻**（进入业务页面前）调用：

   ```js
   import { openScriptArgsPanel } from '../_lib/script_args_panel.mjs'
   await openScriptArgsPanel(page, { scriptDir: SCRIPT_DIR })
   ```

2. 保证同目录存在有效 **`script.json`**（含 `defaultArgs`、`argsHint`）。**7 个业务脚本均已配置 `argForm`**，面板以表单（输入框 / 勾选 / 下拉 / 多选 + 字段说明）展示；无 `argForm` 时回退「每行一个 CLI」文本模式。字段 schema 见 [`playwright_scripts/README.md`](../../playwright_scripts/README.md)。

3. 用户于面板保存的配置写入 **`playwright_scripts/_user_defaults/<scriptId>.json`**；桌面端 `POST /api/playwright-scripts/run` 启动时会**优先使用该文件**中的 `defaultArgs`，再回退 `script.json`。

### 面板行为（用户可见）

| 区域 | 说明 |
|------|------|
| 本轮正在使用的参数 | 只读；有 `argForm` 时显示**中文摘要**（环境码、站点等），无表单时显示原始 CLI |
| 我的默认启动设置 | 可编辑表单；保存后影响**下次**从应用内「自动化脚本」启动时的默认参数 |
| 恢复出厂默认 | 将表单重置为 `script.json` 的 `defaultArgs`，需再点「保存」才写入磁盘 |

面板在**新 Tab** 打开（`setContent` 使用 `commit`，失败时 `data:` URL 兜底），调用后 `bringToFront()`；不阻塞脚本，业务步骤在其它标签继续执行。

### 调试与 API

| 方式 | 说明 |
|------|------|
| `--skip-args-panel` | 跳过参数 Tab（CI / 批跑） |
| `GET /api/playwright-scripts/:folderId/user-default-args` | 读取用户保存与有效默认 |
| `PUT /api/playwright-scripts/:folderId/user-default-args` | 写入 `{ "defaultArgs": string[] }` |

Agent 用 Live Bridge 调试脚本时，应知晓用户可能已改默认参数；**以浏览器参数 Tab「本轮运行参数」与终端 argv 为准**，不要假设仍等于 `script.json` 原文。

---

## 相关文件

| 路径 | 说明 |
|------|------|
| `backend/src/internal/live-bridge-server.ts` | WS 服务、命令路由、`observe` 实现 |
| `backend/src/internal/live-bridge-extract.ts` | Defuddle 正文提取（HTML → Markdown） |
| `backend/src/internal/launch-http-server.ts` | HTTP 升级与 `/api/live-bridge` 挂载 |
| `frontend/src/modules/browser/pages/LiveBridgePage.tsx` | Agent 配置页（服务状态、MCP、Skill 目录） |
| `frontend/src/config/project.config.ts` | 菜单入口配置 |
| `scripts/test-live-bridge.mjs` | 本地冒烟：`profile` → 截图 → `read_dom`（输出到 `scripts/_live_bridge_test/`，已 gitignore） |
| `playwright_scripts/_lib/script_args_panel.mjs` | 脚本启动参数 Tab（全局，业务脚本必调） |
| `playwright_scripts/_lib/script_args_form.mjs` | `argForm` ↔ CLI 互转、本轮参数中文摘要 |
| `playwright_scripts/_lib/script_args_store.mjs` | 用户默认参数持久化（`_user_defaults/*.json`） |

**本地快速验证：**

```bash
node scripts/test-live-bridge.mjs IKXSD8
```

临时 batch JSON、截图等调试产物请放在 `scripts/_live_bridge_test/`，勿提交仓库。

---

## 版本说明

- **v0.2.1**：`extract_content` / `browser_extract_content` — Defuddle 引擎提取页面正文 Markdown + 元数据。
- **v0.2**：多会话（最多 8 并发）、`snapshot` + `click_ref`/`type_ref` 语义定位、`wait_for` 智能等待、多标签页 API、MCP Server；新增 `detached` / `tab_closed` 事件，移除单连接顶替（`replaced`）。协议对 v0.1 客户端**向后兼容**。
- **v0.1**：`attach`、`observe`、连接时 `hello.session`、`page_changed` 事件；`profile` 支持同 code 复用已有页面。

演进规划见 [ROADMAP.md](ROADMAP.md)。

---

## AI Agent Skill

本项目内置 **AI 浏览器接管** Skill，供 Codex、Claude Code、Openclaw、Cursor 等 Agent 按「**connect/profile → 观察 → 单步控制 → 再观察**」流程操作浏览器（**通用网页控制**，非客服专用）：

| 路径 | 说明 |
|------|------|
| `.cursor/skills/nexbrowser-live-bridge/SKILL.md` | Agent 主指令（中文） |
| `.cursor/skills/nexbrowser-live-bridge/reference.md` | 协议速查 |
| `.cursor/skills/nexbrowser-live-bridge/examples.md` | 通用操作示例 |
| `.cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs` | CLI：单次 WS 连接执行多条命令 |
| `.cursor/skills/nexbrowser-live-bridge/scripts/mcp-live-bridge.mjs` | **MCP Server**：把 Live Bridge 封装成标准 MCP 工具 |

**CLI 示例：**

```bash
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs -f .cursor/skills/nexbrowser-live-bridge/scripts/example-batch.json
```

对话中说「接管浏览器」「AI 控制浏览器」「Live Bridge」等，Agent 会自动加载该 Skill。

### MCP Server 注册

支持 MCP 的 Agent（Codex、Claude Code、Openclaw、Cursor 等）可注册后直接调用 `browser_*` 工具：

```json
{
  "mcpServers": {
    "nexbrowser": {
      "command": "node",
      "args": [".cursor/skills/nexbrowser-live-bridge/scripts/mcp-live-bridge.mjs"]
    }
  }
}
```

提供 **17** 个工具：首选 **`browser_connect`**（带 `code` 自动 Launch），以及 `browser_profile`、`browser_attach`、`browser_observe`、`browser_snapshot`、**`browser_extract_content`**、…

环境变量：`LIVE_BRIDGE_URL`（默认 `ws://127.0.0.1:19876/api/live-bridge`）、`LIVE_BRIDGE_TIMEOUT_MS`。
