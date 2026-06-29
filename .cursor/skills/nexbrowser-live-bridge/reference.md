# Live Bridge 协议速查

端点：`ws://127.0.0.1:19876/api/live-bridge`（仅 localhost）

## 消息格式

**命令：** `{ "id": "唯一", "cmd": "observe", "args": {} }`

**响应：** `{ "id": "唯一", "ok": true, "result": {} }` 或 `{ "ok": false, "error": "..." }`

**事件：** `{ "type": "event", "event": "hello|page_changed|console|detached|tab_closed", "data": {} }`

支持**多客户端并发**（最多 8 个 ws 连接），每个连接是独立 Session（各自的当前 tab 与命令队列）。

## 命令列表

### 会话与感知（优先使用）

| cmd | args | 说明 |
|-----|------|------|
| `ping` | — | 心跳 + session 快照（含 sessionId） |
| `attach` | — | 附着**最近 Launch** 的浏览器，不重启；**未指定 code 时用** |
| `observe` | — | 当前页结构化状态 |
| `snapshot` | `{ "maxChars"? }` | **A11y tree 快照**，元素带 `[ref=eN]` 稳定标记 |
| `profile` | `{ "code", "force"? }` | **按环境码自动 Launch 或复用**；用户指定 BUPM2Z 等时必须用此命令 |

### 语义化操作（优先于 CSS 选择器）

| cmd | args | 说明 |
|-----|------|------|
| `click_ref` | `{ "ref", "timeout"? }` | 按 snapshot 的 ref 点击（如 `e12`） |
| `type_ref` | `{ "ref", "text" }` | 按 ref 填充输入框 |

ref 失效会返回 `stale_snapshot: ...`，此时重新 `snapshot` 拿新 ref。

### 智能等待

| cmd | args | 说明 |
|-----|------|------|
| `wait_for` | `{ "url"? \| "text"? \| "selector"? \| "selector_gone"? \| "network_idle"?, "timeout"? }` | 等到条件满足即返回，代替盲目 sleep |

- `url`：URL 包含此子串
- `text`：页面出现此文本
- `selector` / `selector_gone`：选择器可见 / 消失
- `network_idle`：网络空闲

### 多标签页

| cmd | args | 说明 |
|-----|------|------|
| `tabs_list` | — | 所有 tab（index/url/title/active） |
| `tab_select` | `{ "index" }` | 切换当前 tab |
| `tab_new` | `{ "url"? }` | 新建 tab（可直接打开 URL） |
| `tab_close` | `{ "index"? }` | 关 tab（缺省关当前） |

### 页面操作（需先 attach/profile）

| cmd | args | 说明 |
|-----|------|------|
| `url` | — | 当前 URL、title |
| `navigate` | `{ "url", "timeout"? }` | 跳转 |
| `wait` | `{ "ms" }` | 固定等待（最大 60000，优先用 wait_for） |
| `screenshot` | `{ "fullPage" }` | PNG base64 |
| `read_dom` | `{ "maxChars" }` | 页面 text/html（原始，含噪音） |
| `extract_content` | `{ "maxChars"?, "includeHtml"?, "contentSelector"?, "useAsync"? }` | **Defuddle 正文 Markdown** + 元数据 |
| `find` | `{ "selector" }` | 元素数量、文本、可见性 |
| `click` | `{ "selector", "timeout"? }` | 点击（CSS/text 选择器） |
| `type` | `{ "selector", "text" }` | 填充输入框 |
| `evaluate` | `{ "expression" }` | 页面内执行 JS |
| `back` / `forward` / `reload` | — | 历史/刷新 |
| `console_log` | — | 当前 tab 控制台缓冲 |

选择器语法与 **Playwright** 一致：`text=登录`、`#id`、`.class`、`button:has-text("确定")`。

## snapshot 返回示例

```json
{
  "snapshotId": 3,
  "url": "https://example.com/login",
  "title": "登录",
  "snapshot": "- textbox \"用户名\" [ref=e3]\n- textbox \"密码\" [ref=e5]\n- button \"登录\" [ref=e7]",
  "length": 1234
}
```

定位流程：`snapshot` → 找到目标元素的 `ref` → `click_ref` / `type_ref` → 再 `snapshot` 或 `observe` 验证。

## observe 返回示例

```json
{
  "activeCode": "BUPM2Z",
  "url": "https://example.com/dashboard",
  "title": "控制台",
  "scene": "other",
  "hints": ["页面有弹层: 不再显示"],
  "chat": {}
}
```

### scene 取值

| 值 | 含义 |
|----|------|
| `homepage` | 商家/应用首页类 URL |
| `chat_inbox` | 聊天收件箱列表 |
| `chat_session` | 已打开具体会话 |
| `other` | 登录页、表单页等 |
| `unknown` | 未识别 |

`chat` 字段仅在聊天 UI 上出现；**通用浏览器控制任务不必依赖它**。

## Agent 通用工作流

```
1. 用户给了 code？ → profile { code } 或 MCP browser_connect({ code })
   否则 → attach 或 browser_connect()
2. observe / snapshot — 是否在登录页？
3. 登录页 → 提示用户手动登录 → wait_for → 回到 2
4. 从 snapshot 找 ref → click_ref / type_ref → wait_for → snapshot 验证
5. 重复 4 直到任务完成；不够时用 read_dom / screenshot / evaluate
```

## 限制

- 最多 8 个并发 WebSocket 客户端；每 Session 内命令串行
- 对同一 tab 的副作用命令跨 Session 也会串行
- ref 在下一次 `snapshot` 后失效，操作前确保 ref 来自最新快照
- `observe` 为启发式推断，不确定时用 `snapshot` + `screenshot`
