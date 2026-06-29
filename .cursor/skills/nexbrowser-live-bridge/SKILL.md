---
name: nexbrowser-live-bridge
description: >-
  通过 NexBrowser Live Bridge WebSocket 实时接管并控制 Chromium 指纹浏览器（browser_connect 按 code 自动
  Launch、snapshot 语义定位、navigate、click、type、wait_for、多标签页、screenshot）。在用户要求 AI 接管浏览器、
  打开指定 profile/环境码、Live Bridge、AI浏览器接管、实时浏览器控制时使用。
---

# NexBrowser AI 浏览器接管

让 Agent **像人一样**操作用户本机指纹浏览器：连接指定 profile → 看页面状态 → 单步操作 → 再确认。

## 两种接入方式

| 方式 | 适用场景 |
|------|----------|
| **MCP Server**（推荐） | Codex / Claude Code / Openclaw / Cursor 等支持 MCP 的 Agent，注册后直接调用 `browser_*` 工具 |
| **CLI** | 任意能跑 shell 的 Agent，用 `live-bridge-cmd.mjs` 发命令 |

### MCP 注册（通用；下方为 Cursor `.cursor/mcp.json` 示例）

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

工具（按优先级）：`browser_connect` / `browser_profile` / `browser_attach` / `browser_observe` / `browser_snapshot` / `browser_extract_content` / `browser_click` / …

## 前置条件

- **NexBrowser 主程序已运行**（Launch 服务 `127.0.0.1:19876`）
- 目标 profile 已在实例列表中创建（有环境码，如 `BUPM2Z`）
- **不需要**用户手动 Launch——Agent 用 `profile` / `browser_connect({ code })` 自动打开

## 核心原则

1. **用户指定环境码 → 必须 `profile` / `browser_connect({ code })`** — 不要用 `attach`（attach 只挂「最近 active」的实例，会挂错）
2. **用户未指定 code → 用 `attach` 或 `browser_connect()`** — 附着当前已 Launch 的浏览器
3. **连接后先 observe/snapshot** — 若在登录页，告知用户手动登录，`wait_for` 等待跳转后再继续（**不代填密码**）
4. **snapshot 定位优先** — `click_ref` / `type_ref`；CSS 选择器是回退
5. **wait_for 代替盲等** — 不要固定 `wait` 毫秒
6. **单步变更** — 一次一个动作，然后 snapshot/observe 确认
7. **禁止**写临时 `.mjs` 脚本；统一用 MCP 或 CLI

## 快速开始（MCP）

用户说：「用 BUPM2Z 打开浏览器，去订单管理」

```
browser_connect { "code": "BUPM2Z" }
browser_observe 或 browser_snapshot
  ├─ 登录页 → 提示用户登录 → browser_wait_for { "url": "homepage" 或业务域 }
  └─ 已登录 → browser_navigate / browser_click … → browser_wait_for → browser_snapshot
```

## 快速开始（CLI）

```bash
# 按 code 自动 Launch + 观察（Windows 推荐 -f）
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs -f .cursor/skills/nexbrowser-live-bridge/scripts/example-batch.json

# 单条：打开指定 profile
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs send profile "{\"code\":\"BUPM2Z\"}"

# 未指定 code 时附着当前实例
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs attach
```

## 决策循环

```
用户是否给了 profile code（如 BUPM2Z）？
  ├─ 是 → profile / browser_connect({ code }) → observe/snapshot
  └─ 否 → attach / browser_connect() → observe/snapshot

snapshot 后：
  ├─ 登录页 → 提示用户 → wait_for 登录完成 → 重新 snapshot
  ├─ 找 ref → click_ref / type_ref → wait_for → snapshot
  ├─ 需跳转 → navigate 一次 → wait_for → snapshot
  └─ 定位失败 → screenshot / read_dom / evaluate 兜底
```

## CLI 速查

| 调用 | 用途 |
|------|------|
| `send profile '{"code":"BUPM2Z"}'` | **指定 code 时首选**：自动 Launch/复用 |
| `live-bridge-cmd.mjs attach` | 未指定 code，附着最近 active 实例 |
| `live-bridge-cmd.mjs snapshot` | A11y tree + ref |
| `live-bridge-cmd.mjs -f batch.json` | 一次连接多条命令 |

## 反模式

- ❌ 用户说了 BUPM2Z 却只 `attach`（可能挂到别的 profile）
- ❌ 每步都 `profile` + `navigate` 回首页（除非用户要求换实例）
- ❌ 登录页上盲目 click/type 猜密码
- ❌ 拿旧 snapshot 的 ref 操作（会 `stale_snapshot`）

## 故障排查

| 现象 | 处理 |
|------|------|
| `profile xxx 拉起后未拿到 debugPort` | 确认环境码存在、NexBrowser 在跑 |
| `当前没有已 Launch 的浏览器`（attach） | 改用 `profile { code }` 或让用户指定 code |
| 打开后是登录页 | 正常；提示用户登录，wait_for 后继续 |
| `stale_snapshot` | 重新 snapshot |

## 延伸阅读

- [reference.md](reference.md) · [examples.md](examples.md)
- [docs/live-bridge/README.md](../../../docs/live-bridge/README.md)
