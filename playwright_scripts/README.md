# Playwright：MCP 说明（Markdown）与终端脚本（.mjs）成对维护

## 修改脚本前的硬性要求（人 / AI 同守）

**任何**对 `playwright_scripts/**` 下 `*.mjs` 或 `mcp_*.md` 的修改，**都必须**在改仓库之前，先通过 **已连接本机真实浏览器** 完成页上验证：

- 使用 **Playwright MCP** 附着带登录态的 **CDP**（`mcp.json` 中 `--cdp-endpoint=...` 指向本机可调试实例），在目标站点**真实页面**上把流程跑通；**或**
- MCP 不可用时，用**同一 CDP** 在本机执行 `node .../xxx.mjs --cdp <你的 CDP URL>`（或项目约定的 Launch 方式），**仍是在真实浏览器里**验证，不是无头猜页面。

**禁止**：未接通 CDP、未在真实页上点通流程，就凭记忆或「对齐其它脚本」去改选择器、URL、点击顺序。**Cursor / 其它自动化助手**在收到「改脚本、修可用性、同步选择器」等任务时，**同样必须先完成上述真实浏览器调试**；若当前环境无法连接用户本机 CDP，应**明确说明无法代你完成页上验证**，并请用户贴出实测现象或快照结论后，**再**据实改代码，而不是先改代码再补理由。

下列「开发/修改流程」与本段同等效力，须一并遵守。

---

## 运行时（Node 22）

- **开发机**：`node >= 22`（与根目录 `package.json` 的 `engines` 一致）。
- **打包后**：Playwright 脚本通过 `ELECTRON_RUN_AS_NODE` 执行，使用 **Electron 35+ 内置 Node 22**（当前项目已对齐）。可直接使用 `node:sqlite` 等 Node 22 API，无需再为脚本单独捆绑 Node。

---

## 约定

在 **`playwright_scripts`** 目录内：

1. **每个独立业务流程** 使用 **同名子文件夹**，内含 **`mcp_<主题>.md`**（Cursor MCP 步骤）与 **`*.mjs`**（可执行脚本），二者同步维护。
2. **Markdown** 写清楚：`browser_navigate` / `browser_click` / 快照要点、前置登录或 CDP。
3. **脚本** 写清楚：入口 URL、`getByRole` 与文档一致、连接方式（Launch API / CDP / Edge / Chromium）。

### 开发/修改流程（必守）

**顺序不能颠倒：** 须**先**完成下列「**连接真实浏览器** + 页上调试」，**再**改仓库里的 `*.mjs` / `mcp_*.md`。这里的「真实浏览器」指通过 MCP/CDP 附着、与本应用 Launch 一致的**已登录会话**，不是凭空改写脚本再在别处猜测验证。

**禁止**先改代码、再补验证；**禁止**不经页上验证仅凭猜测改选择器或点击路径；**禁止**在未确认 CDP/MCP 可用的前提下直接提交脚本改动。

#### 探针优先流程（新建、调试、修改、修复脚本时必守）

对任何业务脚本的新建、调试、修改、修复，默认流程必须是：

1. **先写探针，不先改主流程**
   - 在对应业务目录下的 `_temp/` 子文件夹中新建或更新临时探针脚本，建议命名为 `<目标>.mjs` 或 `_probe_<目标>.mjs`。
   - 不要把临时探针散放在业务目录根部；例如应使用 `playwright_scripts/<主题>/_temp/product_search.mjs`。
   - 探针只验证一个具体问题，例如：打开弹窗、定位输入框、选择类目、搜索商品、处理确认框、读取本地存储、验证接口返回。
   - 探针必须连接真实登录浏览器：优先 `--useLaunchApi --code <环境码>`，或通过同一 CDP `connectOverCDP`。
   - 调试过程中创建的临时日志、截图、JSON 快照、HTML/DOM dump、测试数据文件，也必须统一放入 `_temp/`。

2. **探针必须得到可用结论**
   - 记录探针验证到的关键事实：URL、按钮/输入框文本、可用选择器、必要等待、DOM 状态、返回值、异常分支。
   - 如果探针未跑通，不能把猜测逻辑迁到主 `.mjs`。
   - 如果页面状态、弹窗、二次确认、异步刷新不稳定，要用探针覆盖“出现”和“不出现”两类分支。

3. **再更新主 `.mjs`**
   - 只迁移探针已验证可用的逻辑。
   - 主流程改动要尽量局部，保留原有参数、返回结构和 dry-run 语义。
   - 对真实提交、删除、覆盖、移动、批量变更等有副作用的动作，必须先用 dry-run 或探针验证到提交前一步；只有用户明确要求真实执行时才继续。

4. **最后验证主流程**
   - 先运行 `node --check <主脚本>.mjs`。
   - 再用真实浏览器跑主流程 dry-run，确认探针逻辑迁移后仍然有效。
   - 若用户要求真实提交，真实提交后要回读页面结果或脚本返回值，确认成功、失败或被弹窗拦截的具体原因。

5. **同步文档**
   - 主流程修复后，同步更新业务目录内的 `mcp_*.md`、`script.json` 参数说明或测试命令。
   - 任务完成后清空 `_temp/` 子文件夹内本次任务产生的所有临时文件，避免后续误用过期探针、日志或测试数据。
   - 若确有长期保留价值，应改造成正式诊断工具或正式数据文件并写入文档，而不是继续放在 `_temp/` 中。

**特别禁止**：用户要求“修复问题”时直接改主 `.mjs`；应先用探针复现/定位/验证，再迁移到主流程。除非用户明确说“只改文案、只改常量、只改文档”，否则默认都按探针优先处理。

1. **启动并接通 Playwright MCP**  
   - 在 Cursor 中确认 **Playwright MCP 已启用且处于已连接状态**（对应你在 `mcp.json` 里配置的 `@playwright/mcp`，例如带 `--cdp-endpoint=...` 附着本机 CDP）。 
   - 本机 **CDP 地址上须有可调试的浏览器实例**（通常先启动本应用 / Launch 服务，再唤起已登录卖家中心等目标的实例）。 
   - **尚未接通 MCP、或 CDP 上还没有目标会话时，不要开始改脚本。**

2. **在真实页面上用 MCP 调试**  
   - 使用 `browser_navigate`、必要时 `browser_snapshot` / `browser_click` / `browser_evaluate` 等，在**真实登录后的页面**上把流程跑通，并确认 **URL、交互步骤、选择器/文案、关键 DOM** 与线上一致。

3. **最后再更新仓库**  
   - 将上述实测结论写入 **`mcp_*.md`** 与 **`*.mjs`**。

**若 MCP 始终无法连上本机 CDP**：不得跳过页上验证；须改用同一 CDP 的等价手段（见下段）：在本机执行 `node .../xxx.mjs --cdp http://127.0.0.1:19876`（地址以你环境为准）或临时 `connectOverCDP` 探测，**仍然是在真实页面上的调试**，再把结论写回 `mcp_*.md` 与脚本。

### CDP 与 Launch 默认端口 `19876`（本应用）

- 该端口是 **Launch HTTP 服务**；仅当**已有活跃浏览器档案**（内部已登记 `debugPort`）时，才会把 DevTools 流量**代理**到真实 Chromium。若**未**先在应用内启动档案、也**未** `POST /api/launch` 成功拉起会话，则 `connectOverCDP('http://127.0.0.1:19876')` 可能报 **503**、或提示「不像 DevTools」——**先启动/Launch 再连**，不是端口写错。
- 终端调试可优先用脚本的 **`--useLaunchApi`**：会调 `/api/launch` 打开 Compass 等 `startUrl` 并得到可用的 `cdpUrl`，避免「只有 Health、没有浏览器」的空连。

MCP 应配置为附着**已登录**的浏览器（例如 `mcp.json` 中 `--cdp-endpoint=...` 指向本机带登录态的 CDP）。

## 如何连接真实浏览器（最直接）

**原则：** 先在本机有一个**带远程调试**的 Chromium（Launch 返回的 `cdpUrl`、或能打开 `/json/version` 的地址），再 **`chromium.connectOverCDP(url)`**。仓库里的脚本等价于在命令行传 **`--cdp <url>`**。

**办法 A（推荐）：`--useLaunchApi`**  
1. 确认 Launch 可用：`GET http://127.0.0.1:19876/api/health` 返回 `{"ok":true}`（端口以你环境为准）。  
2. 运行脚本时加上 **`--useLaunchApi`** 和 **`--code <环境码>`**（及业务需要的 `--shop_region` 等）。脚本会 **`POST /api/launch`** 拉起浏览器、打开脚本的 `startUrl`，再 **`connectOverCDP`** 到返回地址（一般为 `http://127.0.0.1:19876`）。**无需自己查 debug 端口。**

**办法 B：应用里已经开好浏览器**  
1. 在 NexBrowser 里**启动**目标环境档案（已登录 TikTok 卖家中心等）。  
2. 再运行：`node playwright_scripts/.../xxx.mjs --cdp http://127.0.0.1:19876 ...`  
   此时 **19876** 仅在有**活跃**档案（内部已登记 `debugPort`）时把 DevTools **代理**到真 Chrome；未启动实例时会 **503**，须先办法 A 或在应用内点开浏览器。

**办法 C：直连 Chromium 调试端口**  
若你用 `--remote-debugging-port=xxxxx` 等方式单独起了 Chrome，且浏览器根地址 **`http://127.0.0.1:xxxxx`** 下 `/json/version` 正常，则 **`--cdp http://127.0.0.1:xxxxx`**（MCP 的 `--cdp-endpoint` 也用同一 URL）。

**Playwright MCP（Cursor）**  
在 `mcp.json` 里为 Playwright MCP 配置 **`--cdp-endpoint=`**，与上列 **同一** CDP 地址（常用有活跃实例时的 **`http://127.0.0.1:19876`**），这样 MCP 与终端脚本附着**同一台**真实浏览器。

---

本文件为 **`README.md`**，位于 **`playwright_scripts/`** 根目录，作为约定与示例索引（写脚本前可先读本文）。

## `script.json`（应用内「自动化脚本」列表）

每个**业务子目录**可放置固定文件名 **`script.json`**，供桌面端扫描并展示；**必填**字段如下。

| 字段 | 说明 |
|------|------|
| `name` | 展示名称 |
| `description` | 简介 |
| `entry` | 入口脚本相对本目录的文件名，如 `baidu_today_weather.mjs` |

**常用可选字段**：`id`（缺省为文件夹名）、`order`（排序）、`tags`、`version`、`defaultArgs`（字符串数组，与 UI「附加参数」合并传入 Node）、`argsHint`、`requiresLaunchServer`（为 `true` 时若 Launch HTTP 未就绪会提示）、`mcpDoc`（相对路径，如 `mcp_xxx.md`）。  
若缺少 `script.json`、JSON 不合法或 `entry` 文件不存在，该目录会在应用内列表中跳过并出现**扫描提示**。

## 从仓库根运行示例

```bash
node playwright_scripts/baidu_today_weather/baidu_today_weather.mjs --useLaunchApi --code ICHPPH
node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --useLaunchApi --code ICHPPH--shop_region PH
node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --cdp http://127.0.0.1:19876 --shop_region PH --days_ago 2
node playwright_scripts/tiktok_compass_top10_random5_ai_video/tiktok_compass_top10_random5_ai_video.mjs --useLaunchApi --code ICHPPH --shop_region PH
node playwright_scripts/launch_and_connect/launch_and_connect.mjs
```

## 新增一组时的检查清单

- [ ] **已先连接真实浏览器（MCP→CDP 或 `node ... --cdp ...` 等价），并在目标页完成调试**，再编写/修改 `*.mjs` 与 `mcp_*.md`（助手改脚本前同样勾选此项）
- [ ] 已先在业务目录的 `_temp/` 子文件夹内创建/更新探针，并用探针在真实浏览器中复现或验证目标问题
- [ ] 探针已得到明确可用结论：可用选择器、点击顺序、等待条件、异常分支、页面返回值或本地存储结果
- [ ] 只把探针验证通过的逻辑迁移到主 `<主题>.mjs`，未验证的猜测逻辑不进主流程
- [ ] 主 `<主题>.mjs` 已通过 `node --check`，并至少完成一次真实浏览器 dry-run 验证
- [ ] 临时日志、截图、JSON 快照、DOM dump、测试数据等调试产物均放入 `_temp/`
- [ ] 任务完成后已清空 `_temp/` 子文件夹内本次任务产生的临时文件
- [ ] 新建文件夹 `playwright_scripts/<主题>/`
- [ ] `mcp_<主题>.md` + `<主题>.mjs`（或约定主文件名）
- [ ] 同一主题文件夹内 `mcp_*.md` 与 `.mjs` 的说明、路径、示例命令相互引用一致
