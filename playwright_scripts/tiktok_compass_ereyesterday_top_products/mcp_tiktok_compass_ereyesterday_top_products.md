# TikTok Shop Compass · 单品卡 · 前天高曝光 Top10（Playwright MCP）

> **成对脚本：** `tiktok_compass_ereyesterday_top_products.mjs`（目录 **`tiktok_compass_ereyesterday_top_products`**，语义为 **前天 / ereyesterday**，避免与「昨日」混淆）  
> **约定：** 上级 [`../README.md`](../README.md)

目标 URL（区域可换查询参数）：

`https://seller.tiktokshopglobalselling.com/compass/single-product-card?shop_region=PH`

**统计日（默认）：** 相对卖家本机日历的 **「今天」往前 2 天 = 前天**（例：今天 5 月 3 日 → 选 **5 月 1 日** 这一自然日，单日 range）。

**可选参数：** `--days_ago <n>`（`1` = 昨天，`2` = 前天，默认 **2**）。

---

## 与 README 一致：MCP 不可用时不得跳过实机验证

若 Cursor / Agent 侧 **Playwright MCP 无法连上本机 CDP**（报 `Target page, context or browser has been closed` 等），**不得**仅凭猜测改选择器；须改用 **同一 CDP** 的等价手段：

```bash
node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --cdp http://127.0.0.1:19876 --shop_region PH
node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --cdp http://127.0.0.1:19876 --shop_region PH --days_ago 2
node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --cdp http://127.0.0.1:19876 --shop_region PH --days_ago 1
```

- **`http://127.0.0.1:19876`** 须与本机 Launch HTTP 一致。  
- 该命令即 **`connectOverCDP`** 附着**已登录**卖家中心的浏览器；将结论写回 **本文件** 与 **`tiktok_compass_ereyesterday_top_products.mjs`**。

---

## connectOverCDP 探测结论（单品卡 `single-product-card`，PH）

辅助探测：`playwright_scripts/tiktok_compass_ereyesterday_top_products/probe_ereyesterday_cdp.mjs`（`--cdp` 同主脚本）

| 项目 | 结论 |
|------|------|
| 顶栏日期 | **Arco** `m4b-date-picker-range`；点击 **`.m4b-date-picker-range:not(.arco-picker-disabled)`** |
| 前缀 | 常见 **「最近 7 天」**；快捷仅有 **最近 7 天 / 最近 28 天** |
| 锁定单日 | `.arco-picker-container` 内翻月到目标年月 → 目标日格子 **连点两次**（range 起止同一天） |
| 平台限制 | 格子可为 **`arco-picker-cell-disabled`** → JSON **`targetDaySelection.strategy: arco-target-day-disabled`**；可调 **`--days_ago`** 换一天 |
| JSON | **`daysAgo`**、**`dateTargetYmd`**、**`dateTargetLabel`**（前天/昨天/…）、**`targetDaySelection`** |

---

## MCP 操作步骤（user-Playwright）

| 步骤 | 操作 |
|------|------|
| 1 | Launch + 已登录；CDP 附着 |
| 2 | `browser_navigate` → URL（含 `shop_region`） |
| 3 | 打开日期 picker → 选中 **前天**对应自然日（单日 range） |
| 4 | 表头 **曝光用户数 / Product impressions** → 降序 |
| 5 | 读前 10 行 |

---

## 发给 AI 的 Prompt（复制即用）

请用 Playwright MCP 在我已登录的 TikTok Shop Global Selling 浏览器中：

1. 打开  
   `https://seller.tiktokshopglobalselling.com/compass/single-product-card?shop_region=PH`
2. 将统计日期设为 **前天**（相对今天的日历：**往前数第 2 个自然日**；若今天为 5/3，则选 **5/1** 这一日）。
3. 按 **曝光用户数** 降序。
4. 列出前 10 个商品的 **图片 URL、标题、product_id**。

---

## 终端脚本

```bash
node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --useLaunchApi --code YOUR_LAUNCH_CODE --shop_region PH
node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --cdp http://127.0.0.1:19876 --shop_region PH
```

| 文件 | 用途 |
|------|------|
| [`../README.md`](../README.md) | MCP 与 `.mjs` 成对约定 |
| 本文件 | MCP 步骤与 `--cdp` / `--days_ago` |
| `tiktok_compass_ereyesterday_top_products.mjs` | 自动化 |
