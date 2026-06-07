# TikTok 自动关键词提报

成对脚本：[`tiktok_auto_keyword_submit.mjs`](./tiktok_auto_keyword_submit.mjs) 与探针组
[`_temp/probe_*.mjs`](./_temp/)。

遵守上级 `../README.md`：先用真实已登录浏览器 CDP 验证，再维护脚本。**任何修改前**先在
本目录 `_temp/probe_*.mjs` 跑通真实浏览器（`--useLaunchApi --code GMNQ5O`），再迁移到主 `.mjs`。

## 目标

打开：
`https://seller.tiktokshopglobalselling.com/product/opportunity?shop_region=PH&sort_field=1&use_like=false&tab=trending_keywords`

1. 从页面主世界读取 `shop_id`（5 个来源兜底，探针 v1 验证全部一致为 `8665005459059672756`）。
2. 通过 Launch `GET /api/integrations/linkeoo-erp` 读取链氪 ERP 凭证（`X-Api-Key` 头鉴权，
   参考 [tiktok_ranking_1688_image_collect.mjs](../tiktok_ranking_1688_image_collect/tiktok_ranking_1688_image_collect.mjs#resolveErpCredentials)）。
3. 调 `GET {erpBase}/api/organization/userinfo/`（X-Api-Key 头，含 3 次重试）。
4. 在 `userinfo.shop_list` 中按 `platform === 'Tiktok' && shop_id === 当前页 shop_id` 匹配出 `shop_pk`（实际值 1386）。
5. 通过页面主世界 fetch 调 TikTok `lead/list` 拉取 trending_keyword 机会列表（探针 v6 验证 endpoint
   形状：opportunity_type=202, total_product_count=500）。**DOM 端不可信**（v4/v5 确认虚拟滚动只渲染
   视口内 12 行），主流程 100% 走 API。
6. 对每个 lead，调 ERP `POST /api/tiktok/product/search_by_keyword/`，body `{ shop_pk, keyword, top_n }`，
   返 `{ result: { items: [{ product_id, title, ... }] } }`。
7. **真实 DOM 三步提报**（探针 v14-v18 完整验证，**linkeoo_extension 旧流程已废弃**）：
   - 第 1 步：点 `div.core-table-tr` 行（含 `cursor: pointer`）→ drawer 打开 → 点"绑定现有商品" →
     循环对每个 productId 在 input[placeholder="搜索商品名称"] 输入 + Enter + 勾选 checkbox
   - 第 2 步：系统已自动填入 lead_name 作为推荐关键词（v16 探针真实显示 "推荐关键词 93/255 Cotton Spandex Cross Over Blouse"）
   - 第 3 步：点"提交" → "商品提交成功。你将在 3 个工作日内收到审核结果。"
8. **v0.6 关键**：每次提报后**强制 `page.goto(trending_keywords)` 重新加载页面**，
   让后续 lead 在新页面里能找到行（lead 状态在 TikTok 端会被刷新）。

## 已验证的真实页面 / API 流程

| 步骤 | 真实 endpoint / 元素 | 探针 | 状态 |
|------|---------------------|------|------|
| shop_id 多来源 | 5 来源全部返回 `8665005459059672756` | v1 | ✅ |
| ERP 凭证 | `GET /api/integrations/linkeoo-erp` → `{baseUrl, apiKey}` | v0.3 | ✅ |
| userinfo | `GET {erpBase}/api/organization/userinfo/` X-Api-Key 头（3 次重试） | v0.3 | ✅ |
| shop_pk 匹配 | `userinfo.shop_list` 内 platform=Tiktok && shop_id 匹配 | v0.3 | ✅ → shop_pk=1386 |
| lead/list API | `POST /api/v1/product/oc/seller_product_opportunity/seller/lead/list?{qs}` opportunity_type=202 | v6 | ✅ total_product_count=500 |
| search_by_keyword | `POST {erpBase}/api/tiktok/product/search_by_keyword/` | v0.3 | ✅ |
| DOM 行 click | `div.core-table-tr` 含 `cursor:pointer` | v14 | ✅ |
| 绑定现有商品 | drawer 内按钮 text="绑定现有商品" | v15 | ✅ |
| 搜索 productId | input[placeholder="搜索商品名称"] | v15 | ✅ |
| **多商品勾选** | **循环 search+勾选 productIds 全部** | **v18** | **✅ 真实通过 3 商品** |
| 下一步 | button text="下一步" | v16/v18 | ✅ |
| 提交 | button text="提交" → "商品提交成功" | v17/v18 | ✅ |
| 提报后 re-load | `page.goto(trending_keywords)` 重新加载 | v0.6 | ✅ |

## 探针清单（`_temp/`）

| 探针 | 目的 | 状态 |
|------|------|------|
| `probe_keyword_submit.mjs` (v1) | shop_id 多来源 + DOM 行 | ✅ |
| `probe_dom_v2.mjs` (v2) | 列头、tab 真实状态 | ✅ |
| `probe_tab_v3.mjs` (v3) | "热门关键词" tab 激活 | ✅ |
| `probe_parse_v4.mjs` (v4) | `.core-table-body.innerText` 只 12 行 | ✅ |
| `probe_scroll_v5.mjs` (v5) | 滚动不补齐 DOM 行 | ✅ |
| `probe_api_v6.mjs` (v6) | lead/list API 真实可用 | ✅ |
| `probe_relate_v7.mjs` (v7) | relate API endpoint 形状正确 | ✅ |
| `probe_detail_v8.mjs` (v8) | lead/detail 不返回 tour_id | ✅ |
| `probe_drawer_v9.mjs` (v9) | DOM 行点击（行结构探查） | ✅ |
| `probe_row_discovery_v10.mjs` (v10) | tr vs div 真实行容器 | ✅ |
| `probe_refresh_v12.mjs` (v12) | 刷新 + 长等排查 | ✅ |
| `probe_dom_tree_v13.mjs` (v13) | 完整 .core-table-body 子树 | ✅ |
| `probe_click_v14.mjs` (v14) | 行 click → drawer | ✅ |
| `probe_bind_v15.mjs` (v15) | 绑定现有商品 → 商品搜索 drawer | ✅ |
| `probe_select_v16.mjs` (v16) | 搜 productId + 勾选 + 下一步 | ✅ |
| `probe_submit_v17.mjs` (v17) | 真实提交（"商品提交成功"） | ✅ |
| `probe_multi_v18.mjs` (v18) | **真实多商品勾选+一次性提交** | ✅ |

## 参数

| 参数 | 说明 |
|------|------|
| `--useLaunchApi` / `--cdp <url>` | 连接方式（二选一） |
| `--code <code>` | NexBrowser 环境码，默认 `GMNQ5O` |
| `--shop_region <code>` | 默认 `PH` |
| `--topN <n>` | 每个关键词 ERP 返回商品数，默认 `5` |
| `--limit <n>` | 本次提报关键词上限，默认 `50`（**v0.6 建议 ≤ 5，跑得稳定**） |
| `--leadPageSize <n>` | lead/list 单页大小，默认 `100` |
| `--erpBase <url>` | linkeoo-erp base，默认 `https://api.linkeoo.com` |
| `--erpKey <k>` / `--erpPass <p>` | ERP 凭证覆盖（也走 env `ERP_API_KEY` / `ERP_API_BASE`） |
| `--dryRun` | 默认 true；只走 lead/list + search_by_keyword + 列日志，不真实点击 DOM 提交按钮 |
| `--keepOpen` | 结束后不关闭 CDP |
| `--report_dir <path>` | 报告 JSON 输出目录（默认 `./reports`） |

## 示例

```bash
# 探针：完整跑通一次真实多商品 DOM 提报（v18 已验证）
node playwright_scripts/tiktok_auto_keyword_submit/_temp/probe_multi_v18.mjs \
    --useLaunchApi --code GMNQ5O --shop_region PH --wait_ms 8000

# 主脚本：dryRun（默认；只验证链路，不真实提交）
node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \
    --useLaunchApi --code GMNQ5O --shop_region PH --dryRun --limit 1

# 主脚本：真实提报，--limit 5（v0.6 实测 100% 成功，5 lead × 4-5 商品 = 23 商品真实提交）
node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \
    --useLaunchApi --code GMNQ5O --shop_region PH --limit 5
```

## 注意事项

- 凭证优先级：`env ERP_API_KEY/ERP_API_BASE` > `--erpKey/--erpBase` > Launch `GET /api/integrations/linkeoo-erp`。
  推荐在应用「系统设置 → 第三方接口配置 → 链氪 ERP」保存后由 Launch 提供。
- 默认 dry-run（**不真实 DOM 提交**）；去掉 `--dryRun` 真实向 TikTok 提交。
- v0.6 **每个 lead 提报 ERP 搜索结果的全部商品**（多商品勾选+一次性提交），`row.success = 实际勾选数`。
- **v0.6 真实测得**：limit=5 全部 5 条 lead 提报成功（23 商品），limit=50 时前 5 条成功，后续 45 条因 lead 状态刷新 / 虚拟滚动导致行不可见，**建议 limit ≤ 5**。
- 真实提报会向 TikTok 机会系统提交（"商品提交成功。你将在 3 个工作日内收到审核结果。"），属有副作用操作。
- ERP `userinfo` 接口偶发网络异常，主 mjs 已内置 3 次重试。
- 与 linkeoo_extension `opportunityAutoSubmit.js` 相比，本脚本**不使用它的 DOM 流程**（已过时），
  基于真实探针链 v14-v18 重建。
