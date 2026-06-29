# NexBrowser Desktop

面向 **多账号隔离、代理绑定、本地环境管理** 的桌面指纹浏览器，内置 **Launch HTTP API**、**AI 浏览器接管（Live Bridge）** 与 **Playwright 自动化脚本**，主要用于 TikTok Shop 跨境电商运营场景。

> **技术栈**：Electron 35 + React 18 + Node 22 · 自 [Ant-Browser](https://github.com/black-ant/Ant-Browser)（Wails/Go）迁移至 TypeScript/Electron

---

## 快速开始（人类用户）

### 环境要求

| 项 | 要求 |
|----|------|
| Node.js | **≥ 22**（开发与 Playwright 脚本运行时一致；打包后由 Electron 内置 Node 22 执行脚本） |
| 操作系统 | 当前主要支持 **Windows x64** |
| 可选 | 本机代理（7890 等）用于下载 xray、访问 TikTok |

### 安装与启动

```bash
cd ant-browser-desktop
npm install
npm run dev
```

Windows 快捷方式：`scripts\dev.bat`

### 打包

```bash
npm run build          # 构建 dist-electron/
npm run dist:win       # Windows zip + dir（含 xray 自动下载）
npm run dist:win:installer  # NSIS 安装包
```

---

## 核心能力一览

| 能力 | 说明 | 入口 |
|------|------|------|
| **指纹浏览器** | 多实例 profile、代理池、内核管理、标签/分组 | 应用内「指纹浏览器」菜单 |
| **Launch HTTP API** | 按环境码启动/连接浏览器，CDP 代理 | `http://127.0.0.1:19876`（默认端口） |
| **AI 浏览器接管** | WebSocket 实时控制已 Launch 的 Chromium | `ws://127.0.0.1:19876/api/live-bridge` |
| **自动化脚本** | Playwright `.mjs` 脚本，应用内一键运行 | `playwright_scripts/` |
| **MCP 集成** | Live Bridge 封装为标准 MCP 工具 | `.cursor/skills/nexbrowser-live-bridge/` |

---

## 仓库结构

```
ant-browser-desktop/
├── backend/src/
│   ├── main/              # Electron 主进程入口
│   ├── preload/           # window.go / window.runtime IPC 桥
│   ├── ipc/               # go:call 路由（go-handlers.ts 真实实现 + go-mock 回退）
│   └── internal/          # 业务逻辑（browser、proxy、launch、database、live-bridge…）
├── frontend/src/
│   ├── config/            # 项目名、导航菜单（project.config.ts）
│   └── modules/           # browser / dashboard / profile / settings …
├── playwright_scripts/    # Playwright 自动化脚本（每业务一子目录）
│   ├── _lib/              # 共享模块（Toast、参数面板、表单）
│   └── _user_defaults/    # 用户保存的脚本默认参数
├── bin/                   # xray / sing-box 等代理桥接二进制
├── docs/live-bridge/      # Live Bridge 协议与使用文档
├── .cursor/skills/        # Cursor Agent Skill（nexbrowser-live-bridge）
├── scripts/               # 开发/打包辅助脚本
├── AGENTS.md              # AI Agent 协作硬规则（必读）
└── ARCHITECTURE.md        # 与 Ant-Browser 对照的架构说明
```

### 关键路径速查（Agent 用）

| 任务 | 优先阅读 |
|------|----------|
| 改 UI / 菜单 | `frontend/src/config/project.config.ts` |
| 改 IPC / 后端 API | `backend/src/ipc/go-handlers.ts` |
| Launch / CDP / 脚本运行 | `backend/src/internal/launch-http-server.ts` |
| Live Bridge 协议 | `backend/src/internal/live-bridge-server.ts` |
| 脚本扫描与执行 | `backend/src/internal/playwright-scripts-service.ts` |
| 改 Playwright 脚本 | `playwright_scripts/README.md`（硬性规约） |
| 接管浏览器 | `.cursor/skills/nexbrowser-live-bridge/SKILL.md` |
| 多店批跑并发 | `AGENTS.md` §1（3 槽滚动池） |

---

## 应用内导航

| 分组 | 页面 | 路径 |
|------|------|------|
| 主菜单 | 控制台 | `/` |
| 指纹浏览器 | 实例列表 / 内核 / 代理池 / 书签 / 标签 | `/browser/*` |
| 自动化 | 自动化脚本 / 自动化接口 / **AI浏览器接管** | `/browser/automation/*`、`/browser/live-bridge` |
| 系统维护 | 设置 / 教程 / 日志 / Launch API 文档 | `/settings`、`/browser/launch-api` |

---

## Launch HTTP API

主进程启动后自动监听 **`127.0.0.1:19876`**（可在系统设置修改）。

常用端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 服务健康检查 |
| POST | `/api/launch` | 按 selector / code 启动浏览器实例 |
| GET | `/api/playwright-scripts` | 列出可运行脚本 |
| POST | `/api/playwright-scripts/run` | 运行指定脚本 |
| WS | `/api/live-bridge` | AI 浏览器接管 WebSocket |

> 端口 **19876** 在有活跃浏览器实例时同时作为 **CDP 代理**；未 Launch 时直连可能 503。脚本调试优先用 `--useLaunchApi --code <环境码>`。

完整接口说明见应用内 **接口文档** 页（`/browser/launch-api`）。

---

## Playwright 自动化脚本

`playwright_scripts/` 下每个业务子目录包含：

- **`*.mjs`** — 可执行入口
- **`mcp_*.md`** — MCP / 探针步骤文档（与脚本同步维护）
- **`script.json`** — 应用内列表元数据（`name`、`entry`、`defaultArgs`、`argForm`）

### 当前业务脚本

| 目录 | 名称 |
|------|------|
| `tiktok_auto_keyword_submit` | TikTok 自动关键词提报 |
| `tiktok_affiliate_bulk_invite_creators` | TikTok 联盟批量邀约达人 |
| `tiktok_product_optimizer_batch_update` | TikTok Shop 商品批量优化更新 |
| `tiktok_publish_pending_videos` | TikTok 发布待发布带货视频 |
| `tiktok_compass_top10_random5_ai_video` | TikTok Compass Top10 随机5 → AI 视频 |
| `tiktok_ads_gmv_max_dashboard` | TikTok Ads GMV Max 概览汇总 |
| `tiktok_ranking_1688_image_collect` | 榜单图搜 1688 采集 |

### 终端运行示例

```bash
# 推荐：通过 Launch API 按环境码自动拉起浏览器
node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \
  --useLaunchApi --code BUPM2Z --shop_region MY

# 应用内已 Launch 时，附着 CDP 代理
node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \
  --cdp http://127.0.0.1:19876 --shop_region MY
```

**修改脚本前必读** [`playwright_scripts/README.md`](./playwright_scripts/README.md)：须先在真实浏览器上探针验证，禁止 dry-run，必须接 Toast 与参数面板。

---

## AI 浏览器接管（Live Bridge）

通过 WebSocket 以对话式方式操作本机 Chromium：**导航、snapshot 语义定位、click/type、多标签页、截图、observe 页面状态**。

### 推荐 Agent 流程

```
用户给了环境码？
  ├─ 是 → profile { code } 或 browser_connect({ code })
  └─ 否 → attach

observe / snapshot → 单步操作 → wait_for → 再 observe
```

### 快速验证

```bash
node scripts/test-live-bridge.mjs BUPM2Z
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs observe
```

### MCP 注册（Cursor / Claude Desktop）

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

详细协议、命令表、反模式见 [`docs/live-bridge/README.md`](./docs/live-bridge/README.md)。

---

## 给 AI Agent 的说明

若你正在 Cursor / 其它 Agent 环境中处理本仓库任务，请按以下顺序建立上下文：

1. **读 [`AGENTS.md`](./AGENTS.md)** — 含多店批跑 **3 槽滚动池** 硬规则、已知坑、派活约定
2. **读任务相关专项文档** — 改脚本 → `playwright_scripts/README.md`；接管浏览器 → `.cursor/skills/nexbrowser-live-bridge/SKILL.md`
3. **先探针、后改代码** — 脚本/UI 选择器变更必须在真实浏览器（Live Bridge 或 CDP）上验证后再提交
4. **前后端联动** — 功能涉及 IPC 时，同时检查 `backend/src/ipc/` 与 `frontend/src/modules/`

### Agent 常用命令

```bash
npm run dev                    # 启动桌面应用（Live Bridge / Launch API 依赖主进程）
npm run lint                   # TypeScript 类型检查
npm run smoke:runtime          # 运行时冒烟

# Live Bridge CLI
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs \
  send profile "{\"code\":\"BUPM2Z\"}"

# 脚本语法检查
node --check playwright_scripts/<主题>/<主题>.mjs
```

### 硬性约束摘要

| 规则 | 说明 |
|------|------|
| 3 槽并发 | 实例维度 3 店并行；单店内 region 串行（MY→PH→SG→TH→VN）；done 后按 profile UUID 杀 chrome，**禁止** `Get-Process chrome \| Stop-Process` 杀全部 |
| 无 dry-run | 业务脚本不提供 `--dryRun`；探针在 `_temp/`，验证通过后迁移主流程 |
| 真实浏览器验证 | 改选择器/流程前必须 Live Bridge `profile` + `snapshot`/`evaluate` 或 CDP 探针 |
| 参数面板 | 业务脚本连上浏览器后须调 `openScriptArgsPanel`；用户默认存 `_user_defaults/` |
| Toast | 关键步骤用 `logProgress` 显示中文 Toast；结束用汇总 Modal |

---

## 架构与数据流

```
React 渲染进程
  └─ window.go.main.App.*()  ──IPC──►  go-handlers.ts
  └─ window.runtime.*()     ──IPC──►  preload 桥接
                                          │
                                          ▼
                              internal/* 服务层
                              ├─ browser-data / browser-writes（SQLite sql.js）
                              ├─ browser-instance-service（Launch）
                              ├─ launch-http-server（HTTP + CDP 代理）
                              ├─ live-bridge-server（WebSocket）
                              └─ playwright-scripts-service
```

- 前端沿用原 **Wails 调用风格**（`wailsjs/go/main/App.js`），preload 用 Proxy 转为 `go:call` IPC
- 后端 **`go-handlers.ts`** 在 SQLite 就绪时走真实实现，否则回退 `go-mock.ts`
- 详细模块对照见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## npm scripts

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（electron-vite） |
| `npm run build` | 生产构建 → `dist-electron/` |
| `npm run preview` | 预览构建产物 |
| `npm run lint` | 前后端 TypeScript 检查 |
| `npm run dist:win` | Windows 打包（zip + dir） |
| `npm run dist:win:installer` | Windows NSIS 安装包 |
| `npm run fetch:xray:win` | 下载 xray-core 到 `bin/` |
| `npm run smoke:runtime` | 运行时环境冒烟 |

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 与 Ant-Browser 对照、IPC 数据流 |
| [AGENTS.md](./AGENTS.md) | Agent 协作硬规则、并发模式、已知坑 |
| [docs/live-bridge/README.md](./docs/live-bridge/README.md) | Live Bridge 协议、命令、MCP |
| [docs/live-bridge/ROADMAP.md](./docs/live-bridge/ROADMAP.md) | Live Bridge 演进规划 |
| [playwright_scripts/README.md](./playwright_scripts/README.md) | 脚本规约、Toast、参数面板、探针流程 |
| [bin/README.md](./bin/README.md) | xray / sing-box 二进制放置与打包 |
| [.cursor/skills/nexbrowser-live-bridge/SKILL.md](./.cursor/skills/nexbrowser-live-bridge/SKILL.md) | Cursor Agent 接管浏览器主指令 |

---

## 许可证与上游

- 本项目自 [Ant-Browser](https://github.com/black-ant/Ant-Browser) 迁移，目录结构 intentionally 对齐上游便于对照
- `bin/` 中 xray、sing-box 等第三方二进制受其各自许可证约束
