# TikTok Shop Compass · 数据概览 · 当日 GMV（Playwright MCP）

> **成对脚本（终端 / CI）：** 本目录下 `tiktok_compass_gmv.mjs`  
> **成对约定说明：** 上级目录 `../README.md`

目标 URL（菲律宾区示例）：  
`https://seller.tiktokshopglobalselling.com/compass/data-overview?shop_region=PH`

其它区域在查询串修改 **`shop_region`**（与卖家中心一致）。终端脚本支持 **`--shop_region <区域码>`**。

**前置：** 已在浏览器登录 TikTok Shop Global Selling 卖家中心；未登录会停在登录页，无法读到 GMV。

在 Cursor **`mcp.json`** 里为 Playwright MCP 配置 **`--cdp-endpoint=http://127.0.0.1:19876`**（或你本机实际 CDP 地址）时，MCP 会附着到**已带登录态**的浏览器。若 **Chat/Agent 里调 MCP 报 `Target page, context or browser has been closed`**，多为 Agent 侧无法连上你本机 CDP，可改用终端：

```bash
node playwright_scripts/tiktok_compass_gmv/tiktok_compass_gmv.mjs --cdp http://127.0.0.1:19876 --shop_region PH
```

---

## 实测 DOM（本机 CDP 调试，用于写死/优先选择器）

在 **数据概览** 顶区「关键指标」下，**GMV 与金额**落在类名包含 **`pcm-smc-wrapper`** 的卡片内；当前选中的主指标还带有 **`pcm-smc-wrapper-selected`**。单卡 `innerText` 归一化后类似：

`GMV ₱ 1,215 .00`

（数字与小数点之间可能多一个空格。）

「关键指标」行上还有 **日期区间** 文案，例如 `2026/05/02 - 2026/05/02`；**GMV 与区间一致**，若你要「日历当天」的 GMV，需先在页面上把该日期区间改到目标日（本页**未必**是 Tab「今日」式交互，以实际 UI 为准）。

标签侧可能还出现 **`gec-metric-center-metric-popover-trigger`**、**`pcm-smc-title-text-underline`** 等，用于说明/下划线，抓金额时**以整块 `pcm-smc-wrapper` 文本**最稳。

---

## MCP 操作步骤（user-Playwright）

可用工具名以当前 MCP 为准（常见：`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_wait_for`、`browser_evaluate` 等）。

| 步骤 | 操作 |
|------|------|
| 1 | `browser_navigate` → 完整 Compass URL（含所需 `shop_region`） |
| 2 | 等待页面标题或主内容出现（含 `TikTok Shop` / `Compass` / `Data` 等）；必要时 `browser_wait_for` 文本 **`GMV`** 或 **`数据概览`** |
| 3 | **（推荐）** 若时间粒度不是「当天」：查找并点击 **`Today` / `今日` / `1D`** 等按钮或 Tab，使指标对应「当日」 |
| 4 | `browser_snapshot` → 找 **`pcm-smc-wrapper`** 且文案含 **GMV** 的卡片（优先带 **`pcm-smc-wrapper-selected`**），读取整卡文本 |
| 5 | 或 `browser_evaluate`：对 **`.pcm-smc-wrapper`** 做 `innerText`，过滤含 **GMV** 且含金额的那一项 |

**说明：** 快照里的 **`ref=e…`** 每次会话会变；写脚本时优先 **`.pcm-smc-wrapper`** 卡片级文本，避免误抓下方 **「GMV 拆解」** 区块里的分项金额。

---

## 发给 AI 的 Prompt（复制即用）

请用 Playwright MCP 在我已登录的 TikTok Shop 卖家中心浏览器中：

1. 打开  
   `https://seller.tiktokshopglobalselling.com/compass/data-overview?shop_region=PH`  
   （若需其它区域，把 `PH` 改成对应 `shop_region`。）
2. 等待数据概览加载；如默认不是「当天」，切换到 **Today / 今日 / 1D**。
3. 读取 **GMV** 指标在「当天」维度下的展示金额，把原始文案与数字回复给我。

---

## 终端脚本（非 MCP）

与上述目标等价的 Playwright 本地脚本：**`tiktok_compass_gmv.mjs`**（需已登录会话，或通过 Launch API / CDP 接管已登录浏览器）。

运行示例（仓库根目录）：

```bash
node playwright_scripts/tiktok_compass_gmv/tiktok_compass_gmv.mjs --useLaunchApi --code ICHPPH--shop_region PH
node playwright_scripts/tiktok_compass_gmv/tiktok_compass_gmv.mjs --cdp http://127.0.0.1:19876 --shop_region PH
```

---

## 与本目录其它文件

| 文件 | 用途 |
|------|------|
| `../README.md` | **MCP 文档与 `.mjs` 成对维护约定**及索引 |
| `mcp_tiktok_compass_gmv.md`（本文件） | MCP 步骤与 Prompt |
| `tiktok_compass_gmv.mjs` | 与本文一致的 `node` 自动化 |
