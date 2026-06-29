# 榜单图搜 1688 采集（Playwright MCP）

> **成对脚本：** 本目录下 `tiktok_ranking_1688_image_collect.mjs`  
> **桌面端清单：** `script.json`  
> **成对约定：** 上级目录 [`../README.md`](../README.md)

修改本文或脚本前，须遵守 [`../README.md`](../README.md) 的**实机 CDP 验证**要求；若未在真实 1688 图搜结果页上点通「第二条进详情」，不得凭猜测改选择器。

---

## 业务与 API

1. `GET` `https://<ERP_HOST>/api/opportunity/tiktok_ranking_product/?current=1&pageSize=20&only_developed=false`（`X-Api-Key`）  
2. 从 `results` 中随机取 `--pick` 条（默认 3），将每条 `cover` 解析为图片 URL 列表（数组 / JSON 数组字符串 / 逗号分隔 / 单 URL）。  
3. 浏览器：`https://s.1688.com/selloffer/offer_search.html`  
   - 在 `.ali-search-input` 填入图片 URL  
   - 等待 **1 秒**  
   - 点击 **`div.input-button` 内文案为「图 搜」的 `span.input-button-text`**（勿点「搜 索」关键词搜索）  
   - 在结果列表点击 **第二个** 商品：优先 **顶层可见** **`[data-tracker="offer"]`**（无更近的同属性祖先），再退回 **`[class*="searchOfferWrapper"]`**、**`[class*="offerTitleRow"]`**  
4. `POST` `https://<ERP_HOST>/api/warehouse/collect/`，`platform: "1688"`，`url` 为详情页地址，`data` 为详情页 **HTML**（脚本将对 **HTML 的 `JSON.stringify` 与 `fetch` 放到 `setImmediate`**，主流程立刻继续下一轮图搜；**既不阻塞序列化大正文，也不等待**服务端处理完成）  
5. 全部图片 URL 跑完后：`POST` `.../api/opportunity/tiktok_developed/mark_batch/`，`target_type: "ranking_product"`，`ids` 为三步随机到的 `id` 列表  

链氪 **API Host / Key** 优先从应用 **系统设置 → 第三方接口配置** 写入的 `config.yaml` 读取；脚本经 Launch **`GET /api/integrations/linkeoo-erp`** 拉取。亦可使用环境变量 **`ERP_API_KEY`** / **`ERP_API_BASE`** 或 `--erpKey` 覆盖，勿将密钥提交到仓库。

---

## CLI

| 参数 | 说明 |
|------|------|
| `--useLaunchApi` | 走 Launch `/api/launch`，`startUrl` 为 1688 图搜页 |
| `--code` / `--keyword` / `--profileId` / `--profileName` | Launch selector |
| `--baseUrl` | Launch 根地址，默认 `http://127.0.0.1:19876` |
| `--cdp <url>` | 直连 CDP；与 `PLAYWRIGHT_CDP_URL` 二选一 |
| `--pageSize` | 榜单分页大小，默认 `20` |
| `--pick` | 随机条数，默认 `3` |
| `--skipMark` | 不调用「批量标记已开发」 |
| `--headed` / `--launch-edge` / `--keepOpen` | 与其它脚本一致 |

---

## MCP 实测要点（骨架）

| 步骤 | 操作 |
|------|------|
| 1 | 附着 CDP 后 `browser_navigate` → `offer_search.html` |
| 2 | 在 `.ali-search-input` 填入测试图 URL，等待 1s |
| 3 | 点击 **`div.input-button` 内「图 搜」**（`span.input-button-text`），不要点「搜 索」 |
| 3b | 若 1688 **新开标签**展示图搜列表，后续滚动 / 点第二条须在 **新标签** 上操作（脚本会在点击前监听 `page` 事件并切换到结果页） |
| 4 | 等待列表出现；点第二个 **顶层可见** **`[data-tracker="offer"]`**（若无则 `searchOfferWrapper` / `offerTitleRow`） |
| 4b | 进入详情后 **不要等 `networkidle`**（1688 详情页持续请求，网络很难「空闲」）；脚本在 URL 就绪后再 **`sleep` 10s** 给模块加载，然后取 `content()` |
| 3c | 图搜进入**结果列表页**后（`domcontentloaded` 后）**固定等待 10s** 再点第二条 |
| 5 | 记录是否弹新标签：脚本在点击商品**前**监听 `page`，延长超时，并在各标签中匹配详情 URL |
| 6 | 每张图采集完 HTML 后：**关闭除主标签外全部标签**，主标签 `goto` 回 `offer_search.html`，再跑下一张 |

1688 列表/DOM 经常改版；若「第二条」与业务期望不一致（含广告位），须在实机上确认后同步修改脚本中的 locator 与注释。

---

## 页面运行步骤说明（showPageToast）

| 阶段 | 页面提示示例 |
|---|---|
| 开始 | `[脚本] 开始榜单图搜 1688 采集：ERP 待开发 N 条，随机 3 条` |
| 每件商品 | `[脚本] 商品 1/3：id=… · 标题 · 2 张图` |
| 图搜 | `[脚本] 1688 图搜中：商品 1/3 · 图 1/2` |
| POST 采集 | `[脚本] 已进入 1688 详情页，正在 POST 仓库采集…` |
| 采集结果 | `[脚本] 采集 成功：id=…` |
| 批量标记 | `[脚本] 正在批量标记 3 条商品为已开发…` |

结束后弹 **汇总 modal**（成功/失败条数 + 商品明细）；异常时弹 danger modal。

## 终端示例（仓库根）

```bash
set ERP_API_KEY=erp_sk_your_key_here
set ERP_API_BASE=https://api.linkeoo.com
node playwright_scripts/tiktok_ranking_1688_image_collect/tiktok_ranking_1688_image_collect.mjs --cdp http://127.0.0.1:19876
node playwright_scripts/tiktok_ranking_1688_image_collect/tiktok_ranking_1688_image_collect.mjs --useLaunchApi --code ICHPPH
```
