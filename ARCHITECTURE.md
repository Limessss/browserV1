# 架构说明（与 Ant-Browser 对照）

本目录为 **Electron + React + Node** 迁移版，命名尽量贴近上游仓库 [Ant-Browser](https://github.com/black-ant/Ant-Browser) 的模块边界，便于对照迁移。

| 原 Ant-Browser | 本仓库 ant-browser-desktop |
|----------------|---------------------------|
| `main.go` + Wails 生命周期 | `backend/src/main/index.ts`（Electron `app` / `BrowserWindow`） |
| `backend/*.go` App 胶水层 | `backend/src/ipc/` + `backend/src/services/`（逐步补充） |
| `backend/internal/browser` | `backend/src/internal/browser` |
| `backend/internal/proxy` | `backend/src/internal/proxy` |
| `backend/internal/launchcode` | `backend/src/internal/launchcode` |
| `backend/internal/config` | `backend/src/internal/config` |
| `backend/internal/database` | `backend/src/internal/database` |
| `backend/internal/backup` | `backend/src/internal/backup` |
| `backend/internal/logger` | `backend/src/internal/logger` |
| `backend/internal/tray` | `backend/src/internal/tray` |
| `backend/internal/fsutil` | `backend/src/internal/fsutil` |
| `backend/internal/apppath` | `backend/src/internal/apppath` |
| `frontend/`（React） | `frontend/`（渲染进程） |
| `bat/dev.bat` | `scripts/dev.bat`（调用 `npm run dev` → `electron-vite dev`） |
| `publish/` | `publish/` |
| `tools/` | `tools/` |
| `wailsjs` 自动生成绑定 | `backend/src/preload`（`go:call` 多路复用 + `wails:event` 事件名） |

## 数据流

1. **渲染进程**沿用原 **`wailsjs/go/main/App.js`**：内部仍为 `window['go']['main']['App'][方法名]()`；preload 用 **Proxy** 将其转为 `ipcRenderer.invoke('go:call', methodName, args)`。
2. **`runtime.js`** 不变：依赖 **`window.runtime`**；preload 注入同名 API（`EventsOn`、`BrowserOpenURL`、`Environment`、`Quit`、`WindowHide` 等）。
3. **主进程** `ipc/register-handlers.ts` 处理 `go:call`，当前委托 **`ipc/go-mock.ts`**；后续替换为真实 `internal/*` 服务。
4. **事件**：主进程可向渲染进程发送 `webContents.send('wails:event', { name, args })`，与 preload 内 `EventsOn` 订阅格式一致。
5. **Playwright**（后续）：建议在 `backend/src/automation/` 或 worker 子进程中运行。

## 与原仓库并行开发

- 上游仍在 `../Ant-Browser`，本目录独立 `npm install`。
- UI 可从上游 **复制** `frontend/src` 逐步迁入；后端逻辑按 `internal` 分包从 Go 翻译为 TypeScript。
