# TikTok 自动关键词提报

成对脚本：[`tiktok_auto_keyword_submit.mjs`](./tiktok_auto_keyword_submit.mjs) 与探针组
[`_temp/probe_*.mjs`](./_temp/) / [`_temp/live-bridge-*.json`](./_temp/)。

遵守上级 [`../README.md`](../README.md)：**探针首选 NexBrowser Live Bridge**（`profile { code }` → `navigate` → `evaluate` / `snapshot`），
Live Bridge 不便表达的长循环再写 `_temp/probe_*.mjs`（`--useLaunchApi --code <环境码>`）。**任何修改主 `.mjs` 前**须先在真实浏览器得到可用结论。

## 探针方式（Live Bridge 优先）

| 方式 | 何时用 | 入口 |
|------|--------|------|
| **Live Bridge batch** | DOM 结构、Tab 切换、滚动容器、单行点击、evaluate 读表格 | `live-bridge-cmd.mjs -f _temp/live-bridge-*.json` |
| **Live Bridge MCP** | Cursor Agent 逐步接管、snapshot 语义定位 | `.cursor/skills/nexbrowser-live-bridge/` |
| **`_temp/probe_*.mjs`** | 完整 DOM 提报循环、ERP 联调、SQLite 过滤 | `node _temp/probe_*.mjs --useLaunchApi --code …` |

**约定**：用户指定环境码时**必须** `profile { "code": "0ZF9ZK" }`，勿用 `attach`（会挂错实例）。

### Live Bridge 示例（关键词页 + 滚动探针）

```bash
# 1) 连接 0ZF9ZK 并打开 PH 关键词页，读 scrollRoot
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs \
  -f playwright_scripts/tiktok_auto_keyword_submit/_temp/live-bridge-scroll-probe.json

# 2) 向下滚 .core-table-body，对比不同 scrollTop 下的行文案
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs \
  -f playwright_scripts/tiktok_auto_keyword_submit/_temp/live-bridge-scroll-probe2.json
```

batch 模板（`_temp/live-bridge-scroll-probe.json`）：

```json
[
  { "cmd": "profile", "args": { "code": "0ZF9ZK" } },
  { "cmd": "navigate", "args": { "url": "https://seller.tiktokshopglobalselling.com/product/opportunity?shop_region=PH&sort_field=1&use_like=false&tab=trending_keywords" } },
  { "cmd": "wait_for", "args": { "timeoutMs": 15000, "selector": "div.core-table-tr" } },
  { "cmd": "evaluate", "args": { "expression": "..." } }
]
```

更多命令见 [`docs/live-bridge/README.md`](../../docs/live-bridge/README.md)。

## 目标

打开：
`https://seller.tiktokshopglobalselling.com/product/opportunity?shop_region=PH&sort_field=1&use_like=false&tab=trending_keywords`

**v0.9.3**：部分店铺 URL 虽带 `tab=trending_keywords`，首屏仍默认停在「精选」Tab。
脚本在每次 `goto` 后会检测并**显式点击「关键词」Tab**（`getByRole('tab', { name: /关键词/ })`，探针 v26 验证 0DAY5O MY）。
切换后表格行文案可能是「搜索次数」而非「搜索关键词」（样例：`Blouse … Style推荐+3,537 搜索次数434添加同款商品`），行识别逻辑已同步。

**v0.9.4 / v28 探针**：DOM 提报有两种 UI——
- **legacy**（如 AF7H54）：行含 `# … 查看详情`，**点整行** → drawer →「绑定现有商品」
- **new**（如 0DAY5O）：行含「添加同款商品」无 `#` 前缀，**点行内「添加同款商品」** → drawer →「绑定现有商品」

1. 从页面主世界读取 `shop_id`
2. 通过 Launch `GET /api/integrations/linkeoo-erp` 读取链氪 ERP 凭证（`X-Api-Key` 头鉴权，
   参考 [tiktok_ranking_1688_image_collect.mjs](../tiktok_ranking_1688_image_collect/tiktok_ranking_1688_image_collect.mjs#resolveErpCredentials)）。
3. 调 `GET {erpBase}/api/organization/userinfo/`（X-Api-Key 头，含 3 次重试）。
4. 在 `userinfo.shop_list` 中按 `platform === 'Tiktok' && shop_id === 当前页 shop_id` 匹配出 `shop_pk`（实际值 1386）。
5. 通过页面主世界 fetch 调 TikTok `lead/list` 拉取 trending_keyword 机会列表（探针 v6 验证 endpoint
   形状：opportunity_type=202, total_product_count=500）。**DOM 端不可信**（v4/v5 确认虚拟滚动只渲染
   视口内 12 行），主流程 100% 走 API。
6. 对每个 lead，调 ERP `POST /api/tiktok/product/search_by_keyword/`，body `{ shop_pk, keyword, top_n }`，
   返 `{ result: { items: [{ product_id, title, ... }] } }`。
7. **真实 DOM 三步提报**（探针 v14-v18 + v28 双 UI，**linkeoo_extension 旧流程已废弃**）：
   - 第 1 步：legacy 点行 / new 点行内「添加同款商品」→ drawer → 点"绑定现有商品" →
     循环对每个 productId 在 input[placeholder="搜索商品名称"] 输入 + Enter + 勾选 checkbox
   - 第 2 步：系统已自动填入 lead_name 作为推荐关键词（v16 探针真实显示 "推荐关键词 93/255 Cotton Spandex Cross Over Blouse"）
   - 第 3 步：点"提交" → "商品提交成功。你将在 3 个工作日内收到审核结果。"
8. **v0.6 关键**：每次提报后**强制 `page.goto(trending_keywords)` 重新加载页面**，
   让后续 lead 在新页面里能找到行（lead 状态在 TikTok 端会被刷新）。
9. **v0.8 关键**：DOM 缺关键元素（行 / 按钮 / 输入框 / 勾选失败 / 提交未成功）→ 标记
   `skipped: true` 跳过**该 product**，主流程继续下一个 product。`row.skipped_product_ids`
   / `row.submitted_product_ids` 全量记录用于审计。
10. **v0.9 关键**：**SQLite 持久化去重**（`node:sqlite` / `DatabaseSync`，Node 22+）——
    - DB 路径：默认 `playwright_scripts/tiktok_auto_keyword_submit/.data/submissions.sqlite`
      （`--db <path>` / `--reset-db` 重置）
    - 表 `lead_submissions`：
      `UNIQUE INDEX uq_lps(lead_name, product_id, shop_id, region) WHERE status='submitted'`
    - 启动时读 DB 拿 `getSubmittedLeads({ shopId, region })` → 注入 page
      `window.__SUBMITTED_LEADS__` → `discovered` 阶段双重过滤（页面状态 + DB）
    - 同 lead 下用 `getSubmittedProductIds(...)` 排除已成功提报的 product_id（不再点侧栏搜索）
    - 每次结果落库：`status ∈ {submitted, skipped, failed}`（历史库可能仍有 dryRun 行）；UNIQUE 命中即跳过
    - 跨 shop / region 隔离正确
11. **v0.9.1 关键**：**`--shop_region` 数组化 + 页面运行日志提示**
    - `--shop_region` 支持 `'PH'` / `'PH,MY'` / `'["PH","MY","TH"]'` 三种写法
      （与 `tiktok_compass_top10_random5_ai_video.mjs#parseShopRegions` 一致）
    - 多 region 时**依次独立**跑：每个 region 都拉起独立的 Launch 档案（与该 region 店铺档案匹配），
      提报循环跑完后**立即 close**，下一个 region 重新启动；DB 共享所以去重仍生效
    - 最后一个 region 跑完后弹汇总 modal：列出每个 region 的 success / skipped / 错误数
    - 页面运行日志（`showPageToast`，3 秒一闪）：
      - `shop_id` 读取成功 → `[脚本 [区域 i/n · PH]] shop_id=... · 即将匹配 ERP`
      - ERP 凭证 OK → `[脚本 ...] ERP 凭证 OK（source=...）`
      - shop_pk 匹配 → `[脚本 ...] shop_pk=... · lead/list 抓取中…`
      - lead/list 返回 → `[脚本 ...] lead/list N 条 · limit=3`
      - 每条 lead 完成 → `[脚本 ...] lead i/3 "Lead Name" 完成 · 成功 N 跳过 M`
      - 每个 product 成功 → `[脚本 ...] ✓ Lead → product=... (i/n)`
    - 单 region 时行为不变（toast 都在 + 末尾弹 modal）
12. **v0.9.2 关键**：**discovered 按 lead/list API 顺序 + 虚拟滚动兜底**
    - 背景：TikTok 表格使用虚拟滚动（rc-virtual-list），视口内只渲染约 11 行；
      v0.8 的「DOM 视口首条」策略会跳过 lead/list API 第 N 条（N > 视口内行数）——
      即使该 lead 已被发现（视口外），DOM 上查不到它，row.click 不发生，drawer 不开，
      5 个 product 全部「未找到「绑定现有商品」按钮」/「checkbox 勾选失败」误判为 DOM 失败
    - 修复：把 `report.allLeads`（lead/list API 全量顺序）作为 `window.__API_LEAD_ORDER__`
      传给前端，前端按这个顺序在 DOM 视口内查询，找到的第一个可见 lead 作为 discovered[0]
    - 兜底：如果「API 顺序里的 lead 没有一个在视口内」，触发一次 `sc.scrollBy` 滚 0.6 个视口高度
      再 `requestAnimationFrame` 回调里回滚——`rc-virtual-list` 用 IntersectionObserver
      触发渲染，滚动事件能让其渲染下一批行；300ms 后再查一次
    - 仍找不到：兜底退化为「DOM 视口内首条」（与 v0.8 行为一致）
    - 探针 v25 验证 PH 段 `Cotton Printed Short Sleeve Blouse` (lead/list API 第14条)：
      11 行视口里看不到它；新算法会按 API 顺序找，触发滚动兜底
    - 同样修复了 lastPage bug：runForRegion 现返回 `{ report, page, conn }`，外层
      直接拿最后一个 region 的 page 弹 modal，不再"为弹窗重开浏览器"
13. **v0.9.5 关键**：**视口内关键词均已提报时，向下滚动 `.core-table-body` 加载更多**
    - 背景：首屏虚拟滚动只渲染 ~11 行；若这些 lead 均已写入 SQLite（或页面显示「已提报」），
      v0.9.2 的 `discovered[0]` 为空 → 脚本直接 `break`，但列表向下拉仍能加载更多未提报关键词
    - 修复：`discoverNextLeadName()` 每轮先 `resetKeywordTableScroll` 回顶，再按 API 顺序查视口；
      找不到则 `scrollKeywordTableBody`（滚 `.core-table-body` 65% 视口 + `scroll`/`wheel` 事件），
      最多 50 轮或滚到底；找到后 `openLeadOpportunityDrawer` 仍用 `scrollIntoViewIfNeeded`
    - Live Bridge 探针（0ZF9ZK PH）：`scrollRoot=div.core-table-body`，`scrollHeight` 随滚动从 1944→6500
    - E2E 验证（0ZF9ZK PH，DB 已 20 lead）：自动发现 `Cotton Spandex Cross Over Blouse`（API 第 12 条），`submitSuccess=5`

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

## 探针清单

### Live Bridge（首选，`_temp/live-bridge-*.json`）

| batch 文件 | 目的 | 环境 | 状态 |
|------------|------|------|------|
| `live-bridge-scroll-probe.json` | 关键词页 `div.core-table-tr` 行数 + `.core-table-body` scrollRoot | 0ZF9ZK PH | ✅ 2026-06-14 |
| `live-bridge-scroll-probe2.json` | 滚 `scrollTop` 0→600→1200，对比首屏/中段/底部行文案 | 0ZF9ZK PH | ✅ 2026-06-14 |

**结论（v0.9.5）**：滚动容器为 `div.core-table-body`；向下滚时 `scrollHeight` 从 ~1944 增至 ~6500，可加载视口外未提报关键词。

### Node 探针（`_temp/probe_*.mjs`，Live Bridge 补充）

| 探针 | 目的 | 状态 |
|------|------|------|
| `probe_keyword_submit.mjs` (v1) | shop_id 多来源 + DOM 行 | ✅ |
| `probe_dom_v2.mjs` (v2) | 列头、tab 真实状态 | ✅ |
| `probe_tab_v3.mjs` (v3) | "热门关键词" tab 激活 | ✅ |
| `probe_keyword_tab_v26.mjs` (v26) | 精选默认 Tab → 点击「关键词」+「搜索次数」行识别（0DAY5O MY） | ✅ 2026-06-14 |
| `probe_keyword_dom_v28.mjs` (v28) | 两种 UI：legacy 点行 / new 点行内「添加同款商品」→「绑定现有商品」drawer | ✅ 2026-06-14 |
| `probe_parse_v4.mjs` (v4) | `.core-table-body.innerText` 只 12 行 | ✅ |
| `probe_scroll_v5.mjs` (v5) | 滚动不补齐 DOM 行（已被 Live Bridge + v0.9.5 主流程取代） | ✅ 历史 |
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
| `probe_sqlite_v23.mjs` (v23) | **SQLite 持久化（建表/UNIQUE/读写/discover 过滤/shop-region 隔离）** | ✅ |
| `probe_parse_regions_v24.mjs` (v24) | **`parseShopRegions` 3 种写法 + 错误路径（与 compass 参考一致）** | ✅ |
| `probe_drawer_ph_v25.mjs` (v25) | **PH 段 `Cotton Printed Short Sleeve Blouse` drawer 失败根因排查**（v0.9.2 修复 discovered 视口外 lead） | ✅ |

## 主脚本依赖的辅助脚本（`_temp/*.js`）

主入口 `tiktok_auto_keyword_submit.mjs` 通过 `readFile(path.join(scriptDir, '_temp/lead_list_script.js'), 'utf8')` 加载
`lead/list` API 调用的内联 JS 字符串（见主脚本 line 371）。**该文件不可缺失**——缺失将直接 ENOENT 报错、整次任务 fail-exit。

| 文件 | 用途 | 状态 |
|------|------|------|
| `lead_list_script.js` (72 行) | 在页面主世界 fetch `https://api16-normal-sg.tiktokshopglobalselling.com/api/v1/product/oc/seller_product_opportunity/seller/lead/list` 拉 trending_keyword 机会列表，返回 `{ ok, status, data, totalProductCount, sample, rawPreview }` | ✅ 2026-06-12 恢复 |

### 历史事故
- **2026-06-11 06:04 commit 24fe194**（Limessss）整批清空了 `_temp/` 下的 18 个 `*_script.js` 探针脚本 + 19 个 `probe_*.mjs` 探针 mjs，唯一留下 `debug_reports/header-click-msg.png`。
- **2026-06-12 00:32-00:59 Task 3 / 13 店真跑**首次暴露该问题：9 店 ENOENT，2 店跳登录页，2 店超时，13 店全 fail-exit。
- **2026-06-12 01:05 devops 修复**：`git checkout 24fe194^ -- playwright_scripts/tiktok_auto_keyword_submit/_temp/lead_list_script.js` 写回 72 行原内容（3008 字节），`node --check` 通过。
- **未来 18 个 `*_script.js` 探针脚本**（`parse_script.js` / `multi_select_script.js` / `drawer_*_script.js` / `bind_drawer_script.js` / `click_row_script.js` / `dom_tree_script.js` / `lead_detail_script.js` / `parse_scroll_script.js` / `multi_select_v19_script.js`）当前仍未恢复——**主脚本当前不依赖这些**（仅 `lead_list_script.js`），但若将来 devops 需写新探针验证 DOM 端提交流程，需先 `git checkout 24fe194^ --` 恢复对应文件。

## 参数

| 参数 | 说明 |
|------|------|
| `--useLaunchApi` / `--cdp <url>` | 连接方式（二选一） |
| `--code <code>` | NexBrowser 环境码，默认 `GMNQ5O` |
| `--shop_region <code>` | 单码 `'PH'`、逗号分隔 `'PH,MY'`、JSON 数组 `'["PH","MY"]'`；v0.9.1 起依次独立跑每个 region（拉起独立 Launch 档案） |
| `--topN <n>` | 每个关键词 ERP 返回商品数，默认 `5` |
| `--limit <n>` | 本次提报关键词上限，默认 `50`（**v0.6 建议 ≤ 5，跑得稳定**） |
| `--leadPageSize <n>` | lead/list 单页大小，默认 `100` |
| `--erpBase <url>` | linkeoo-erp base，默认 `https://api.linkeoo.com` |
| `--erpKey <k>` / `--erpPass <p>` | ERP 凭证覆盖（也走 env `ERP_API_KEY` / `ERP_API_BASE`） |
| `--keepOpen` | 结束后不关闭 CDP |
| `--report_dir <path>` | 报告 JSON 输出目录（默认 `./reports`） |
| `--db <path>` | v0.9：去重 SQLite 文件路径（默认 `./.data/submissions.sqlite`） |
| `--reset-db` | v0.9：清空去重 SQLite 后重跑（**慎用**：会让已成功提报的 lead 重新被发现） |

## 示例

```bash
# Live Bridge：滚动容器探针（改 DOM/滚动逻辑前必跑）
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs \
  -f playwright_scripts/tiktok_auto_keyword_submit/_temp/live-bridge-scroll-probe2.json

# Node 探针：完整多商品 DOM 提报（Live Bridge 不便表达的长循环）
node playwright_scripts/tiktok_auto_keyword_submit/_temp/probe_multi_v18.mjs \
    --useLaunchApi --code GMNQ5O --shop_region PH --wait_ms 8000

# 主脚本：真实提报（DB 首屏已提报时应向下滚找下一条，v0.9.5）
node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \
    --useLaunchApi --code 0ZF9ZK --shop_region PH --limit 1

# v0.9：重置 DB（**慎用**：会重置全部去重历史，需先备份）
node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \
    --useLaunchApi --code GMNQ5O --shop_region PH --reset-db --limit 1
```

## 注意事项

- 凭证优先级：`env ERP_API_KEY/ERP_API_BASE` > `--erpKey/--erpBase` > Launch `GET /api/integrations/linkeoo-erp`。
  推荐在应用「系统设置 → 第三方接口配置 → 链氪 ERP」保存后由 Launch 提供。
- 始终 **真实 DOM 提报**，会向 TikTok 机会系统提交。
- v0.6 **每个 lead 提报 ERP 搜索结果的全部商品**（多商品勾选+一次性提交），`row.success = 实际勾选数`。
- **v0.6 真实测得**：limit=5 全部 5 条 lead 提报成功（23 商品）；v0.9.5 起首屏均已提报时会**向下滚 `.core-table-body`** 继续发现，不再提前结束。
- **建议 `--limit ≤ 5`** 单批稳定跑；大批量依赖 v0.9.5 滚动发现 + DB 去重。
- 真实提报会向 TikTok 机会系统提交（"商品提交成功。你将在 3 个工作日内收到审核结果。"），属有副作用操作。
- ERP `userinfo` 接口偶发网络异常，主 mjs 已内置 3 次重试。
- 与 linkeoo_extension `opportunityAutoSubmit.js` 相比，本脚本**不使用它的 DOM 流程**（已过时），
  基于真实探针链 v14-v18 重建。
