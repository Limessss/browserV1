# TikTok Shop · Compass 默认 Top10 随机 5 个 → AI 视频生成（Playwright MCP）

> **成对脚本（终端）：** 本目录下 `tiktok_compass_top10_random5_ai_video.mjs`  
> **桌面端清单：** `script.json`  
> **成对约定说明：** 上级目录 [`../README.md`](../README.md)

修改本文或脚本前，须遵守 [`../README.md`](../README.md) **开发/修改流程（必守）**：优先用 **Playwright MCP** 在真实页面验证；若 MCP 无法连上本机 CDP，则在本机用 **`--cdp`** 附着同一 CDP 后再改 `mcp_*.md` 与 `*.mjs`。

---

## 业务流程（两段）

1. **Compass 单品卡** `/compass/single-product-card`  
   - **不修改**页面日期筛选，使用 Compass **默认统计区间**（如「最近 7 天」等，以线上为准）。  
   - 点击「曝光」列表头，使商品按曝光 **降序**。  
   - 从表格解析前 **Top N**（默认 **10**）条：`product_id`、标题、主图 URL（解析逻辑与 `tiktok_compass_ereyesterday_top_products` 一致）。

2. **随机选品**  
   - 从上述 Top N 条中 **随机抽取 M 条**（默认 **5**；可用 `--pick_n` 调整，且不超过实际解析到的条数）。

3. **带货视频 · AI 视频生成器**（每个选中商品各执行一轮）  
   - 打开 `material-2-video?from=tab`（按需带 `shop_region`）。  
   - **AI 视频生成器** → **选择商品** → 搜索 `product_id` 并选中行 → **确认** → **生成视频** → 等待 **「正在生成视频」**（与 `tiktok_shoppable_ai_video.mjs` 一致）。

---

## `shop_region` 与曝光 Top10（重要）

卖家中心为 SPA：**仅打开带 `?shop_region=XX` 的 URL 时，应用层有时仍停留在当前店铺区域**。脚本在打开 Compass / material-2-video 时会做 **多次导航**（含 `location.replace`、带 `_nc` 的二次 `goto`），并尽量等待地址栏中 `shop_region` 与 `--shop_region` 一致。

- 终端 JSON 中 **`urlShopRegion` / `shopRegionUrlMatchesArg` / `finalUrl`** 可用来确认是否已切到目标区域。  
- 若仍不一致：可能需在**顶栏/店铺切换**中手动选目标市场，或当前登录主体下**没有该区域店铺**（URL 无法强切）。  
- CLI 里 **`--code` 与 `--shop_region` 请分开写**（不要写成 `ICHPPH--shop_region` 拼在 code 上，否则 `getArgValue` 可能解析不到区域）。

## CLI 参数（与脚本对齐）

| 参数 | 说明 |
|------|------|
| `--useLaunchApi` | 走 Launch HTTP；`startUrl` 为 **Compass 单品卡**（先完成 Top 解析再跳转到带货视频页） |
| `--code` / `--keyword` / `--profileId` / `--profileName` | 与 Launch `/api/launch` 的 selector 一致 |
| `--shop_region <区域码>` | Compass 与 material-2-video URL 上追加 `shop_region`（默认脚本内为 `PH`，可按店铺修改） |
| `--top_n <数字>` | 高曝光取前几条，默认 **10** |
| `--pick_n <数字>` | 从 Top N 中随机抽几条去生成视频，默认 **5** |
| `--baseUrl` | Launch 根地址，默认 `http://127.0.0.1:19876` |
| `--cdp <url>` | 附着已有登录会话（与 `PLAYWRIGHT_CDP_URL` 二选一） |
| `--launch-edge` / `--headed` / `--keepOpen` | 见脚本头注释 |

---

## 终端示例（仓库根）

```bash
node playwright_scripts/tiktok_compass_top10_random5_ai_video/tiktok_compass_top10_random5_ai_video.mjs --useLaunchApi --code ICHPPH --shop_region PH
node playwright_scripts/tiktok_compass_top10_random5_ai_video/tiktok_compass_top10_random5_ai_video.mjs --cdp http://127.0.0.1:19876 --shop_region PH
node playwright_scripts/tiktok_compass_top10_random5_ai_video/tiktok_compass_top10_random5_ai_video.mjs --useLaunchApi --code ICHPPH --shop_region PH --top_n 10 --pick_n 5
```

---

## MCP 调试要点

- **须已登录**卖家中心；单品卡与带货视频权限与店铺一致。  
- Compass 段若解析不到行：对照 `tiktok_compass_ereyesterday_top_products` 的表格解析与「曝光」列头。  
- AI 段若失败：对照 `mcp_tiktok_shoppable_ai_video.md` 的 dialog 定位（「选择一款商品」+ `table` +「确认」）。

---

## 版本与变更

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.1.0 | 06-11 | 初始发布（commit 24fe194） |
| 1.1.1 | 06-20 | **修复系统性 `page.evaluate: Execution context was destroyed`** — 新增 `safePageEvaluate` helper（3 次 retry on destroyed + 每次 retry 前 `waitForLoadState('domcontentloaded')` 缓冲），替换 3 处 navigation 紧耦合的 evaluate：`readUrlShopRegionParam` + `gotoSellerPageRespectingShopRegion` 内 `window.location.replace` 触发点。修复是**纯增量 retry 包装**，行为兼容（3 次内成功 = 原 evaluate 1 次成功；3 次都 fail = 原 evaluate 抛 destroyed）。详见 handoff `devops-evaluate-destroyed-2026-06-20.md`。 |

## 已知间歇问题（已修 v1.1.1）

**症状**：跨 batch 跨店 fail，err 字节级相同：

```
page.evaluate: Execution context was destroyed, most likely because of a navigation
```

**根因**：TikTok Shop 是 SPA，`page.goto` / `window.location.replace` 后 navigation 状态不稳定；紧随其后的 `page.evaluate` 偶尔撞 destroyed context（Playwright 已知 race）。

**触发场景**：06-18 / 06-19 / 06-20 batch 中 GMNQ5O / 6KFTAN / M2SKTR 等多店 fail，间歇性 ~30-50%。

**修复**：v1.1.1 加 `safePageEvaluate` retry 包装（见上表）。dry-run 探针见 `_temp/devops_probe_evaluate_destroyed.mjs`（间歇 bug 未 100% 复现，但 safePageEvaluate 验证 5/5 OK，修复不破坏好情况行为）。

---

## 与本目录其它文件

| 文件 | 用途 |
|------|------|
| [`../README.md`](../README.md) | 成对维护、CDP、Launch、`script.json` 约定 |
| `mcp_tiktok_compass_top10_random5_ai_video.md`（本文件） | MCP 步骤与 CLI |
| `tiktok_compass_top10_random5_ai_video.mjs` | Node 自动化 |
| `script.json` | 应用内「自动化脚本」列表元数据 |

**说明：** 当前环境若无法连接你本机 CDP，助手无法在页上代你完成验证；请在本机按 README 用 **`--cdp` 或 `--useLaunchApi`** 跑通后，再反馈 DOM/报错以便更新选择器。
