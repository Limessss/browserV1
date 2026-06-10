# NexBrowser 实时浏览器接管（Live Bridge）

## Context

用户希望 Claude 能**实时**操作本机已登录的 Chrome 浏览器实例（"打开数据分析 → 看今天的数据" 这种），**不通过写一次性 .mjs 脚本**。

当前问题：所有浏览器操作都通过 `node xxx.mjs`一次性跑完，无法在中途停下来读截图/读 DOM、等用户指令、调整。

**项目内已有的基础设施**（无需新装扩展）：

- Electron + `playwright` + `ws` 依赖已就位
- Launch HTTP 服务（19876）已暴露 `/api/launch` 拉起 profile，profile 通过 `chromium.connectOverCDP` 接进 Playwright
- 启动时 `http.createServer()` 已注册 `'upgrade'` 事件代理 CDP WebSocket 到 profile 的 `debugPort`
- 已有 `frontend/src/modules/browser/pages/AutomationPage.tsx` (402 行) 和 `PlaywrightScriptsPage.tsx` (545 行)

**目标**：在 NexBrowser 内部新增**一个 WebSocket 桥端点** `/api/live-bridge`，让远端（Claude）能**通过 WS 协议**以"流式"方式操作任何已 Launch 的 profile：发指令（navigate / click / type / screenshot / read DOM）→ 收反馈（截图 PNG / DOM 树 / 控制台消息）。**主进程 + Web 后端**有 Playwright 能力，**前端可加一个 "Live Bridge" 页面**显示 session 状态、截图、命令历史。

## 关键设计决策

### 1. 通信协议（JSON over WebSocket）

**C2S（Claude → Server）命令**：

```json
{ "id": "req-1", "cmd": "navigate",  "args": { "url": "https://..." } }
{ "id": "req-2", "cmd": "screenshot", "args": { "fullPage": false } }
{ "id": "req-3", "cmd": "read_dom",   "args": { "selector": "div.foo", "maxChars": 20000 } }
{ "id": "req-4", "cmd": "click",      "args": { "selector": "button:has-text(\"下一步\")" } }
{ "id": "req-5", "cmd": "type",       "args": { "selector": "input", "text": "hello" } }
{ "id": "req-6", "cmd": "evaluate",   "args": { "expression": "location.href" } }
{ "id": "req-7", "cmd": "wait",       "args": { "ms": 1500 } }
{ "id": "req-8", "cmd": "console_log", "args": { "since": 0 } }
{ "id": "req-9", "cmd": "profile",    "args": { "code": "BUPM2Z" } }  // 切换/连接 profile
{ "id": "req-10", "cmd": "ping" }
```

**S2C（Server → Claude）响应**：

```json
{ "id": "req-1", "ok": true, "result": { "url": "https://..." } }
{ "id": "req-2", "ok": true, "result": { "imageBase64": "...", "width": 1440, "height": 900 } }
{ "id": "req-3", "ok": true, "result": { "html": "...", "text": "..." } }
{ "id": "req-4", "ok": false, "error": "selector not found" }
```

每个请求/响应配对通过 `id` 关联。**服务器主动推送**（如 `console_log` 增量）通过 `type: "event"` 消息：

```json
{ "type": "event", "event": "console", "data": { "level": "error", "text": "..." } }
```

### 2. 后端架构

新加一个文件 `backend/src/internal/live-bridge-server.ts`：

```
live-bridge-server.ts
├── LiveBridgeServer（主类，封装 ws.Server + Playwright connection）
│   ├── attachToHttpServer(httpServer) // 挂 'upgrade'，路径 /api/live-bridge
│   ├── handleCommand(cmd) // 路由 cmd 到 Playwright
│   ├── ensureProfile(code) // 调 browser-instance-service 拉起
│   └── eventEmitter // console / network / pageerror 推到所有 ws client
├── startLiveBridge(httpServer)
└── stopLiveBridge()
```

**关键**：`attachLaunchUpgradeHandler` 当前对所有非 `/api/` 路径的 WS 都代理到 CDP。要插入新端点：

```ts
server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '/'
  if (url.startsWith('/api/live-bridge')) {
    wss.handleUpgrade(req, socket, head)   // 走 ws.Server
    return
  }
  if (url.startsWith('/api/')) {
    socket.destroy(); return
  }
  // 原有 CDP 代理
  ...
})
```

### 3. 主进程集成

`backend/src/main/index.ts`（或现有的 `startLaunchHttpServer()` 调用点）：

```ts
import { startLaunchHttpServer, stopLaunchHttpServer } from '../internal/launchcode'
import { startLiveBridge, stopLiveBridge } from '../internal/live-bridge-server'

// 启动 Launch HTTP 后挂 Live Bridge
const port = await startLaunchHttpServer()
if (port) {
  const httpServer = getLaunchHttpServerInstance()  // 需新增 getter
  startLiveBridge(httpServer)
}

// 停止时
await stopLiveBridge()
await stopLaunchHttpServer()
```

需要 `launch-http-server.ts` 新增一个 `getLaunchHttpServerInstance()` 导出（目前 `httpServer` 是模块私有 `let`）。

### 4. 前端 UI

新增 `frontend/src/modules/browser/pages/LiveBridgePage.tsx`（**最小可用版本**，~200 行）：

- 显示当前连接的 profile（code 字段）
- 一个 textarea + 输入按钮（手工发 JSON 命令 / 或选预置命令）
- 一个大画布显示最新截图
- 一个 JSON 树显示最近 DOM read 结果
- 一个 console 滚动列表

注册路由 `frontend/src/App.tsx`：

```tsx
<Route path="/browser/live-bridge" element={<LiveBridgePage />} />
```

并加入 `frontend/src/config/project.config.ts` 导航。

### 5. 鉴权

复用现有 `loadLaunchServerConfig().auth`：与 Launch API 同样的 `X-Ant-Api-Key` 头。WS 握手时检查 `req.headers['x-ant-api-key']`：

```ts
const auth = loadLaunchServerConfig().auth
if (auth.enabled && req.headers[auth.header] !== auth.apiKey) {
  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
  socket.destroy()
  return
}
```

**localhost only**（与现有 upgrade handler 一致）：拒绝非 127.0.0.1 来源。

### 6. session 模型

**单 ws 连接 = 单 profile session**。client 第一次发 `profile` cmd 选 profile（默认用最近 active 的）。后续 navigate/click 等只作用在那个 profile。**同一时刻只允许一个 ws 连接**（避免多 Claude 互踩）；新连接来时**踢掉**旧连接并广播 `event: "replaced"`。

## 关键文件变更

| 文件 | 操作 | 估行数 |
|------|------|-------|
| `backend/src/internal/live-bridge-server.ts` | **新建** | ~250 |
| `backend/src/internal/launch-http-server.ts` | 改：1) 导出 `getLaunchHttpServerInstance()`；2) `attachLaunchUpgradeHandler` 加 live-bridge 拦截分支 | +20 |
| `backend/src/main/index.ts` | 改：启停 live bridge | +10 |
| `frontend/src/modules/browser/pages/LiveBridgePage.tsx` | **新建** | ~200 |
| `frontend/src/App.tsx` | 改：注册路由 | +3 |
| `frontend/src/config/project.config.ts` | 改：加导航项 | +1 |

**总改动**：5 个文件、约 +484 行新代码、0 行删除。

## 关键复用点

| 已有功能 | 在哪 |怎么用 |
|----------|-----|--------|
| `http.createServer()` upgrade 事件 | [launch-http-server.ts:436](backend/src/internal/launch-http-server.ts) |挂自己的 ws handler，**不重写** |
| `browserInstanceStartByCode()` | [browser-instance-service.ts](backend/src/internal/browser-instance-service.ts) |live-bridge 接到 `profile` cmd 时调它拉起 profile |
| `cdpProxy.ws()` 的代理目标 | [launch-http-server.ts:452-454](backend/src/internal/launch-http-server.ts) |live-bridge 拉起后用 `chromium.connectOverCDP(activeTarget.cdpUrl)` 接入 |
| `loadLaunchServerConfig().auth` | [app-config-store.ts](backend/src/internal/app-config-store.ts) | WS 鉴权与 Launch API 一致 |
| AutomationPage / PlaywrightScriptsPage 的 UI 模式 | [frontend/src/modules/browser/pages/](frontend/src/modules/browser/pages/) | LiveBridgePage 参照这两个的结构（顶部状态栏 + 中部内容 + 右侧日志）|
| 现有 `localhostOnly` + `apiAuthWrap` | [launch-http-server.ts](backend/src/internal/launch-http-server.ts) |live-bridge 复用相同鉴权链（WS 握手层） |

## 验证

### 单元 / 集成测试（main 内自动跑）

1. **WS 握手**：`curl -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: ..." -H "Sec-WebSocket-Version: 13" http://127.0.0.1:19876/api/live-bridge` → 应返回 101 Switching Protocols
2. **未授权拒绝**：`ws://127.0.0.1:19876/api/live-bridge`（无 X-Ant-Api-Key）→ 401
3. **localhost 拒绝**：从 0.0.0.0/::1 之外的源连接 → socket.destroy

### 端到端

1. 启动应用 → 看 Launch 服务启动日志新增 `[LiveBridge] WS endpoint: ws://127.0.0.1:19876/api/live-bridge`
2. 打开新加的"实时接管"页 → 显示"未连接"→ 输 BUPM2Z → 点连接 → 看到当前 profile 页面截图
3. 输入"打开 /analytics" → 后端收到 `navigate` 命令 → 截图更新
4. 跑 2 个并发 client（手动用 2 个 ws 客户端）→ 第二个连接会触发第一个被踢

### 我（Claude）这边怎么用

- 装完实时桥后，我不再写 `_takeover_demo_*.mjs` 一次性脚本
- 我直接用 `ws://127.0.0.1:19876/api/live-bridge` 连上 → 发 `navigate` / `screenshot` / `read_dom` 命令
- 你和我"对话式"推进：每发一命令你看截图、回话，我接着发下一命令

## 备选方案（如不想改主项目）

- 在 `_temp/` 放 100 行 `cdp_live_bridge.mjs` 单独跑：ws server + Playwright.connectOverCDP(19876)。不写主项目代码，但**功能等同**。`script.json` 暴露一个启动入口，应用内可一键跑。

我倾向主方案（嵌进主项目），因为能复用 Launch 服务、UI 集成更顺。
