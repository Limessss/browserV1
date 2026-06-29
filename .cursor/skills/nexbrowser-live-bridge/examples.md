# 使用示例（AI Agent 浏览器控制）

以下均为 **通用接管** 场景，非客服专用。

## 1. 按 code 自动打开并查看（推荐）

`example-batch.json`：

```json
[
  { "cmd": "profile", "args": { "code": "BUPM2Z" } },
  { "cmd": "observe" }
]
```

用户指定环境码时用 `profile`，不要用 `attach`（attach 会挂到别的实例）。

## 1b. 附着当前已 Launch 的实例（未指定 code）

```json
[
  { "cmd": "attach" },
  { "cmd": "observe" },
  { "cmd": "screenshot", "args": { "fullPage": false } }
]
```

```bash
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs -f .cursor/skills/nexbrowser-live-bridge/scripts/example-batch.json
```

## 2. 语义化定位（推荐）：snapshot → ref 操作

第一步（指定 code 时）：

```json
[
  { "cmd": "profile", "args": { "code": "BUPM2Z" } },
  { "cmd": "snapshot", "args": { "maxChars": 30000 } }
]
```

快照返回类似 `- textbox "搜索" [ref=e5]`、`- button "登录" [ref=e8]`。第二步，按 ref 操作并等待结果：

```json
[
  { "cmd": "type_ref", "args": { "ref": "e5", "text": "关键词" } },
  { "cmd": "click_ref", "args": { "ref": "e8" } },
  { "cmd": "wait_for", "args": { "text": "搜索结果", "timeout": 10000 } },
  { "cmd": "snapshot", "args": { "maxChars": 20000 } }
]
```

> ref 在新快照生成后失效（报 `stale_snapshot`），每轮操作前用最新快照的 ref。

## 3. 打开指定网址（wait_for 代替盲等）

```json
[
  { "cmd": "profile", "args": { "code": "BUPM2Z" } },
  { "cmd": "navigate", "args": { "url": "https://www.example.com" } },
  { "cmd": "wait_for", "args": { "network_idle": true, "timeout": 10000 } },
  { "cmd": "observe" }
]
```

## 3b. CSS/text 选择器回退

```json
[
  { "cmd": "profile", "args": { "code": "BUPM2Z" } },
  { "cmd": "type", "args": { "selector": "input[type=search]", "text": "关键词" } },
  { "cmd": "click", "args": { "selector": "button[type=submit]" } },
  { "cmd": "wait_for", "args": { "selector": ".result-list", "timeout": 10000 } },
  { "cmd": "read_dom", "args": { "maxChars": 3000 } }
]
```

## 3c. 多标签页

```json
[
  { "cmd": "profile", "args": { "code": "BUPM2Z" } },
  { "cmd": "tabs_list" },
  { "cmd": "tab_new", "args": { "url": "https://www.example.com" } },
  { "cmd": "snapshot", "args": { "maxChars": 10000 } },
  { "cmd": "tab_select", "args": { "index": 0 } }
]
```

## 4. 提取页面数据

```json
[
  { "cmd": "profile", "args": { "code": "BUPM2Z" } },
  { "cmd": "evaluate", "args": { "expression": "Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim())" } }
]
```

## 5. 首次无运行实例

```json
[
  { "cmd": "profile", "args": { "code": "BUPM2Z" } },
  { "cmd": "observe" }
]
```

## 6. 提取页面正文 Markdown（Defuddle）

适合 AI 阅读长文、商品详情、文档页；比 `read_dom` 更干净（自动去导航/广告/侧栏）。

```json
[
  { "cmd": "profile", "args": { "code": "BUPM2Z" } },
  { "cmd": "extract_content", "args": { "maxChars": 80000 } }
]
```

MCP：`browser_extract_content { "maxChars": 80000 }`

## 7. MCP 方式（支持 MCP 的 Agent 推荐）

在 Agent 的 MCP 配置中注册后，直接调用工具，无需 CLI：

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

典型调用序列：`browser_connect({ code: "BUPM2Z" })` → `browser_snapshot` → `browser_click {ref}` → `browser_wait_for` → `browser_snapshot`。

阅读长文时：`browser_extract_content` 直接拿 Markdown 正文。

## batch 文件临时写入

Agent 可将当次任务的命令数组写入临时 JSON，再 `-f` 执行，避免 PowerShell 引号问题：

```bash
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs -f /path/to/task-batch.json
```
