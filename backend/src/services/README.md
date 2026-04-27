# services

聚合跨模块的业务编排（对齐原 `backend/app*.go` 中 App 层对 internal 的调用）。

建议：每个领域仍放在 `internal/<domain>`，`services/` 只做组合与生命周期（启动 LaunchServer、托盘、迁移等）。
