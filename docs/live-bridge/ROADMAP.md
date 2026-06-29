# Live Bridge 智能化 Roadmap

让 AI Agent 接管浏览器从「低级远程控制」升级为「语义化 + 多会话 + 可对接外部 Agent」的能力层。对标 Claude for Chrome / Codex for Chrome 的 **Agent 层**，但建立在 NexBrowser 的差异化优势上：**多 profile 指纹隔离浏览器编排**。

## 设计取舍（已决策）

| 决策 | 选择 | 理由 |
|------|------|------|
| Agent 大脑形态 | **MCP Server 优先** | 复用现有 WS，零模型成本，一次实现对接 Cursor/Claude/Codex |
| 不做 Chrome 扩展 | 排除 | NexBrowser 核心是指纹隔离多实例，用户不会用日常 Chrome |
| 页面表示 | **A11y tree + ref** | Token 省、定位稳；canvas 回退截图 |
| MCP 进程模型 | **独立进程，WS 客户端** | 解耦，崩溃不影响浏览器 |
| 安全层 | 后置 | 先打地基，预留 hook 点 |

## 里程碑

```
P0 多会话改造        ← 地基：解锁 MCP 与多 Agent 并发
 │
P1 snapshot + ref    ← 独立可交付：定位从"猜"变"指"
 │
P2 wait_for + 多 tab ← 闭环验证 + 跨标签编排
 │
P3 MCP Server 封装    ← 对接所有外部 Agent
 │
(安全层)             ← 域名 allowlist + 高风险确认（后置）
```

### P0 多会话改造

- `state.current: WebSocket`（单连接）→ `sessions: Map<sessionId, Session>`
- 全局 `commandQueue` → 每会话独立队列（消除跨会话阻塞）+ 每页面锁（防同 tab 并发）
- 浏览器连接按 `debugPort` 共享池 + refCount；CDP 断开不杀真实 Chrome
- console / page_changed 事件按会话转发
- `hello` 事件返回 `sessionId`

### P1 snapshot + ref

新增命令：

| 命令 | 说明 |
|------|------|
| `snapshot` | 返回 A11y tree（role/name/ref）+ snapshotId |
| `click_ref` | `{ ref, snapshotId }` 按句柄点击，过期返回 `stale_snapshot` |
| `type_ref` | `{ ref, text, snapshotId }` |

### P2 wait_for + 多 tab

| 命令 | 说明 |
|------|------|
| `wait_for` | `{ url? \| text? \| ref_gone? \| network_idle?, timeout }` |
| `tabs_list` | 列出所有 tab |
| `tab_select` / `tab_new` / `tab_close` | 跨标签编排 |

### P3 MCP Server

```
Cursor/Claude ──stdio MCP──▶ mcp-live-bridge ──WS──▶ Live Bridge:19876 ──CDP──▶ Chromium
```

- 独立包 `mcp-live-bridge/`，复用 `live-bridge-cmd.mjs` 的客户端逻辑
- tools：`browser_attach/snapshot/click/type/navigate/wait_for/tabs_list/screenshot`

### 安全层（后置，预留 hook）

- snapshot/read_dom 返回标注 `_source: "page_untrusted"`
- 命令执行处预留 `beforeAction` 拦截点
- 域名 allowlist、高风险动作（发布/支付/改价/发券）二次确认、审计日志

## 兼容性

协议向后兼容：现有 `attach/observe/profile/click/type/...` 命令与字段不变，旧 Skill CLI 无感升级。
