# TikTok Shop 带货视频 · AI 视频生成器（Playwright MCP）

> **成对脚本（终端 / CI）：** 本目录下 `tiktok_shoppable_ai_video.mjs`  
> **桌面端清单：** `script.json`  
> **成对约定说明：** 上级目录 [`../README.md`](../README.md)

修改本文或脚本前，须遵守 [`../README.md`](../README.md) **开发/修改流程（必守）**：优先用 **Playwright MCP** 在真实页面验证；若 **MCP 无法连上本机 CDP**，则按 README 同一条：在本机用 **同一 CDP** 做等价验证后再改 `mcp_*.md` 与 `*.mjs`。

---

## MCP 无法连上本机 CDP 时（等价实机验证）

与 [`../README.md`](../README.md) **第二段**一致：**不得**省略实机验证；在未接入 MCP 的情况下，用脚本 **`--cdp`** 附着 Launch 暴露的 CDP（默认与 NexBrowser Launch 一致时为 `http://127.0.0.1:19876`，以你环境为准）。

**前提：** 应用已启动 Launch 服务，且已有**带登录态**的浏览器实例挂在该 CDP 上。

从仓库根示例（按需替换区域码、商品 ID）：

```bash
node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --cdp http://127.0.0.1:19876 --shop_region PH
node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --cdp http://127.0.0.1:19876 --shop_region PH --product_id YOUR_PRODUCT_ID
```

也可在本机用 Playwright **`connectOverCDP(cdpUrl)`** 打开同一 URL、逐步调试 `locatorProductPickerDialog` / `locatorAiVideoGeneratorDialog`，将**实测结论**（稳定文案、层级、是否 iframe）记入本文件对应小节并同步 `tiktok_shoppable_ai_video.mjs`。

### 全流程 E2E（先于改脚本）

在修改「点击路径 / locator」类代码前，须在带登录态的 CDP 上**整条脚本跑通一次**。示例（仓库根、实例已挂在 CDP）：

```bash
node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --cdp http://127.0.0.1:19876 --shop_region PH
```

**实测记录：** 上述命令在开发环境跑通：`exit 0`，约十余秒内进入「正在生成视频」类进度（未传 `--product_id` 时为表格首行商品）。若失败，根据终端报错与当前 URL 再改 `tiktok_shoppable_ai_video.mjs`。

---

## 目标 URL

基础：

`https://seller.tiktokshopglobalselling.com/shoppable-videos/material-2-video?from=tab`

多区域店铺追加 **`shop_region`**（与卖家中心查询参数一致），例如：

`https://seller.tiktokshopglobalselling.com/shoppable-videos/material-2-video?from=tab&shop_region=PH`

---

## CLI 参数（与 `tiktok_shoppable_ai_video.mjs` 对齐）

| 参数 | 说明 |
|------|------|
| `--useLaunchApi` | 走 Launch HTTP；需应用内 Launch 服务与本机 `node_modules/playwright` |
| `--code` / `--keyword` / `--profileId` / `--profileName` | 与 Launch `/api/launch` 的 selector 一致（见脚本 `resolveSelector`） |
| `--shop_region <区域码>` | 非空时在上列 URL 上追加 `shop_region=<区域码>` |
| `--product_id <ID>` | 选品弹窗：搜索后 **`Enter`**，再 **先点目标行 `tr`**；若「确认」仍灰，脚本会再点行内 **label / radio**（与当前卖家中心表格行为一致） |
| `--baseUrl` | Launch 根地址，默认 `http://127.0.0.1:19876` |
| `--cdp <url>` | 不使用 Launch 时直连 CDP（与 `PLAYWRIGHT_CDP_URL` 二选一） |
| `--launch-edge` / `--headed` / `--keepOpen` | 见脚本头注释 |

---

## MCP 实测记录（步骤骨架）

**SPA：** `material-2-video` 在 `domcontentloaded` 后主区「AI 视频生成器」按钮仍可能未挂载；脚本在 `goto` 后对该按钮 **`waitFor({ state: 'visible' })`**（本仓库曾用 `connectOverCDP('http://127.0.0.1:19876')` 探测：约十余秒后出现按钮）。

| 步骤 | 操作 |
|------|------|
| 1 | `browser_navigate` → **material-2-video** 完整 URL（含 `from=tab`，按需含 `shop_region`）；标题侧栏体现 TikTok Shop 卖家中心 |
| 2 | 确认主区 Tab **「创作内容」** 已选中（默认一般为选中） |
| 3 | `browser_click` → `role=button`，名称匹配 **「AI 视频生成器」** |
| 4 | 弹出 **dialog「AI 视频生成器」**；点击 **「选择商品」** |
| 5 | **「选择一款商品」**：有 ID 时先搜索出结果，**点击目标商品行** 选中；无 ID 时点首行；再点 **「确认」** |
| 6 | 回到主 dialog：**等待约 2s**（选品关闭后主区按钮状态稳定），再点击 **「生成视频」**（文案可能含箭头） |
| 7 | 出现 **「正在生成视频」** 类进度文案 |

**快照：** `ref=e…` 会变；以 **`browser_snapshot` + `getByRole` / 文案** 为准。

### 选品 dialog 定位（与脚本一致；须 MCP 或同 CDP 实测后更新）

勿仅用「文案包含 **选择一款商品**」命中 **`[role=dialog]`**：外层 **Drawer** 与内层 **Arco Modal** 可能同时匹配。

当前脚本收窄为：**含「选择一款商品」文案 + 内含 `table` + 内含底部按钮「确认」** 的 dialog。

主流程 **AI 视频生成器** dialog：含「AI 视频生成器」文案 + 内含 **「生成视频」** 按钮。

若线上 DOM 变更，须 **Playwright MCP** 或 **`--cdp` 等价运行** 重新验证后，再更新本段与 `tiktok_shoppable_ai_video.mjs` 内 `locatorProductPickerDialog` / `locatorAiVideoGeneratorDialog`。

---

## 发给 AI 的 Prompt（复制即用）

请用 Playwright MCP 在我已登录的 TikTok Shop 卖家中心浏览器中：

1. 打开 material-2-video 页（需要区域时在 URL 加 `&shop_region=<区域码>`，如 PH）。  
   `https://seller.tiktokshopglobalselling.com/shoppable-videos/material-2-video?from=tab&shop_region=PH`
2. 在 **创作内容** 下点击 **AI 视频生成器**。
3. 在弹窗中点击 **选择商品**；若指定商品 ID，**搜索出结果后点击对应商品行** 选中，点 **确认**。
4. 点击 **生成视频**，确认出现「正在生成视频」类提示后结束。

---

## 终端脚本

等价自动化：**`tiktok_shoppable_ai_video.mjs`**（需已登录会话： **`--useLaunchApi`** 拉起，或 **`--cdp`** / 环境变量附着已有会话）。

从仓库根示例：

```bash
# Launch API 唤起并跑流程
node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --useLaunchApi --code YOUR_CODE --shop_region PH
node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --useLaunchApi --code YOUR_CODE --shop_region PH --product_id YOUR_PRODUCT_ID

# 仅附着本机 CDP（与「MCP 无法连上」时的等价验证一致；实例须已登录卖家中心）
node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --cdp http://127.0.0.1:19876 --shop_region PH
```

---

## 与本目录其它文件

| 文件 | 用途 |
|------|------|
| [`../README.md`](../README.md) | 成对维护、`script.json` 约定、先 MCP 后改脚本 |
| `mcp_tiktok_shoppable_ai_video.md`（本文件） | MCP 步骤、CLI、dialog 定位约定 |
| `tiktok_shoppable_ai_video.mjs` | 与本文一致的 Node 自动化 |
| `script.json` | 应用内「自动化脚本」列表元数据 |

**前置：** 已在卖家中心登录；**直播和视频 → 带货视频** 可访问；店铺有可售商品与 AI 视频额度。
