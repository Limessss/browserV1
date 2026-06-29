# 用户保存的脚本默认参数

本目录存放各 Playwright 业务脚本在**浏览器参数面板**中保存的 `defaultArgs` 覆盖项（JSON），**不提交到 Git**。

- 文件名：`<script.json 的 id>.json`（无 id 时用文件夹名）
- 结构：`{ "defaultArgs": string[], "updatedAt": ISO8601 }`
- 优先级：应用「自动化脚本」启动时，`extraArgs` → **本目录** → `script.json` 的 `defaultArgs`

在脚本运行时的参数 Tab 中编辑并保存即可写入此处。
