# NexBrowser Desktop（Electron）

位于 `browserV1` 仓库根目录，技术栈为 **Electron + React + Node**。目录对齐上游 Ant-Browser：`backend/`、`frontend/`、`scripts/`、`publish/`、`tools/`、`bin/`。

## 当前进度（迁移）

| 模块 | 状态 |
|------|------|
| 前端 UI | 已从 `Ant-Browser/frontend/src` **整棵复制**（路由、模块、样式、主题与原版一致） |
| Wails 绑定 | **preload** 注入 `window.go.main.App`，与原 `App.js` 调用方式兼容；**runtime** 注入 `window.runtime`，与原 `runtime.js` 兼容 |
| 后端业务 | **`go:call` → `ipc/go-mock.ts`**：返回空列表/默认对象，保证页面可打开；后续按方法名替换为真实 SQLite / 进程逻辑 |
| Tailwind | 已在 `electron.vite.config.ts` 中接入 PostCSS，`tailwind.config.js` 使用绝对 `content` 路径，避免构建告警 |

## 环境

- Node.js ≥ 20

## 安装与启动

```bash
cd browserV1
npm install
npm run dev
```

Windows：`scripts\dev.bat`

## 目录说明

- `backend/src/main` — Electron 主进程  
- `backend/src/preload` — `window.go` / `window.runtime`  
- `backend/src/ipc` — `go:call` 路由与 Mock  
- `backend/src/internal/*` — 对应原 Go `internal`（逐步填实现）  
- `frontend/src` — React（含 `wailsjs` 类型与 `App.js`，主进程调用走 IPC）

详细对照见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 构建

```bash
npm run build
```

产物：`dist-electron/`（main / preload / renderer）。

## 下一步开发建议

1. 将 `invokeGoMock` 中的方法逐个改为访问 `better-sqlite3` 与文件系统（对齐原 DAO）。  
2. 主进程通过 `BrowserWindow.webContents.send('wails:event', { name, args })` 推送事件，与原有 `EventsOn` 订阅对齐。  
3. Playwright 自动化可新增 `backend/src/automation/` 或 worker 子进程。
