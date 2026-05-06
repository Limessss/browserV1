# bin

对齐原 Ant-Browser `bin/`：放置 **xray-core**、**sing-box** 等桥接可执行文件（协议 vmess / vless / trojan / ss / Clash 等走本地 SOCKS 桥接时需要）。

应用会在以下位置查找（相对「安装目录」或当前工作目录），优先级从高到低：

1. 配置项 `browser.xray_binary_path` / `browser.singbox_binary_path`（根目录 YAML）
2. 环境变量 `XRAY_BINARY_PATH` / `SINGBOX_BINARY_PATH`
3. `bin/<平台三元组>/` — Windows x64 一般为 **`bin/windows-amd64/`**
4. `bin/win32-x64/`（兼容旧目录名）
5. `bin/` 根目录下的 `xray.exe` / `sing-box.exe`

## Windows（本仓库打包 Win x64）

**推荐**：执行 `npm run dist:win` 或 `npm run dist:win:installer` 时，会先运行 `npm run fetch:xray:win`，从 [Xray-core Releases](https://github.com/XTLS/Xray-core/releases) **自动下载**最新（或指定版本）的 `Xray-windows-64.zip`，解压出 `bin/windows-amd64/xray.exe`，再打安装包。`xray.exe` 已加入 `.gitignore`，不会进 Git。

**下载走代理（默认本机 7890）**：拉取脚本默认经 `http://127.0.0.1:7890`（与 Clash / 常见系统代理端口一致）。请先让本机代理软件在该端口可连外网。若需**直连**（CI 等）：PowerShell 执行  
`$env:FETCH_XRAY_DIRECT='1'` 后再 `npm run fetch:xray:win`。若代理端口不是 7890，可设 `FETCH_XRAY_PROXY_PORT` 或 `FETCH_XRAY_PROXY=http://127.0.0.1:你的端口`。

手动覆盖或固定版本：

- 设置环境变量 `XRAY_RELEASE_TAG=v26.3.27` 后再打包。
- 直连 GitHub 不稳定时，可先设置镜像前缀再打包（示例，按你网络实测替换）：  
  PowerShell：`$env:GITHUB_DOWNLOAD_MIRROR='https://ghfast.top'`  
  或对 zip 使用完整地址：`$env:XRAY_ZIP_URL='https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-windows-64.zip'`
- 强制重新下载：`FORCE_XRAY_FETCH=1 npm run fetch:xray:win`（PowerShell：`$env:FORCE_XRAY_FETCH=1`）。

若不想用脚本，也可自行下载后放入 `bin/windows-amd64/xray.exe`（或 `bin/xray.exe`）再打包。

若不想打进安装包，可在已解压的安装目录旁手动创建 `bin/windows-amd64/xray.exe`，或在配置文件中设置绝对路径，例如：

```yaml
browser:
  xray_binary_path: "D:\\tools\\xray.exe"
```

## 许可说明

上游二进制受其各自许可证约束；分发时请自行遵守项目与下游合规要求。
