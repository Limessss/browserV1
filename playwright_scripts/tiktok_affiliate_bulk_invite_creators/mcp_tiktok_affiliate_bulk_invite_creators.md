# TikTok 联盟批量邀约达人

配套脚本：`tiktok_affiliate_bulk_invite_creators.mjs`

## 目标

访问：

`https://affiliate.tiktokshopglobalselling.com/connection/creator?shop_region=PH`

执行流程：

1. 打开联盟达人发现页；若 URL 的 `shop_region` 与顶栏站点不一致，点击右上角头像，在下拉菜单中选择目标站点（如 `MY Malaysia`）。
2. 等待"查找达人"页面加载。
3. 默认应用筛选：`商品类目=女装与女士内衣`、`平均佣金率=小于 15%`、`过去 90 天内未获邀请的达人`；如果传入其他筛选参数，继续应用对应筛选。
4. 勾选 1 位达人并打开 `批量邀请` 弹窗，识别弹窗结构。
5. 切换到 `创建新邀请` 标签。
6. 选择 `仅佣金` 类型。
7. 点击弹窗底部 `邀请` 按钮，跳转到表单页 `/target-invitation/create`。
8. 填写表单：
   - 邀请名称（默认日期+4位随机字符串）
   - 有效期截止（默认一年后）
   - Facebook 账号（默认 `linkeoo`）
   - 邀请文本（默认英文模板）
9. 展开"选择商品"面板，点击 `添加商品` 打开弹窗：
   - 切换搜索字段为 `商品 ID`
   - 输入并搜索用户提供的商品ID
   - 点击搜索图标
   - 勾选搜索结果中的商品
   - 点击弹窗的 `添加` 按钮确认
10. 在已添加商品行中：
   - 双击 `标准佣金率` 列单元格，填写 `--standard_commission_rate`（默认 12%）
   - 打开 `店铺广告佣金` 开关（Playwright force click）
   - 双击 `店铺广告佣金率` 列单元格，填写 `--shop_ads_commission_rate`（默认 6%）
11. 勾选 `提供免费样品` 和 `手动审核申请`。
12. 点击 `发送` 提交邀约。

## 参数

| 参数 | 说明 |
|---|---|
| `--shop_region <value>` | 默认 `PH`；支持 `PH`、`PH,MY`、或 JSON 数组 `["PH","MY"]` |
| `--useLaunchApi` | 通过本地 Launch API 启动并连接真实已登录浏览器 |
| `--code <code>` | Launch 环境代码，默认示例为 `BUPM2Z` |
| `--cdp <url>` | 直接连接已启动浏览器 CDP |
| `--max_creators <n>` | 本轮最多勾选达人数量，默认 `50`，脚本会限制不超过页面上限 50 |
| `--product_category <text>` | 商品类目筛选；支持单值、逗号分隔或 JSON 数组；支持多层级如 `女装与女士内衣-女士连衣裙` |
| `--avg_commission_rate <text>` | 平均佣金率筛选；支持单值、逗号分隔或 JSON 数组 |
| `--content_type <text>` | 内容类型筛选；支持 `video`/`live` 别名，或直接传页面中文选项 |
| `--creator_agency <text>` | 达人机构筛选；支持单值、逗号分隔或 JSON 数组 |
| `--content_language <text>` | 内容语言筛选；支持 `english`/`en` 别名，或直接传页面中文选项 |
| `--uninvited_90_days <true/false>` | 是否勾选 `过去 90 天内未获邀请的达人`；默认 `true` |
| `--reset_filters <true/false>` | 传入任一筛选参数时默认先重置筛选；可设为 `false` 保留当前筛选叠加 |
| `--creator_search <keyword>` | 查找达人页顶部关键词搜索，默认 `top`；别名：`--search_keyword`、`--creator_keyword` |
| `--random_sort <true/false>` | 筛选和关键词搜索后，从 `相关性`、`GMV`、`成交件数`、`粉丝数`、`平均视频播放量`、`互动率` 中随机选择排序依据，默认 `true` |
| `--sort_by <text>` | 指定排序依据；支持 `相关性`、`GMV`、`成交件数`、`粉丝数`、`平均视频播放量`、`互动率`，别名：`--creator_sort_by` |
| `--useNewFlow` | **新增**：启用创建新邀约流程（默认），不走已有计划 |
| `--product_ids <id1,id2,...>` | **新增**：商品ID列表，多个用逗号分隔（必填） |
| `--invitation_name <text>` | **新增**：邀请名称，默认日期+4位随机字符串 |
| `--invitation_text <text>` | **新增**：邀请文本，默认英文模板 |
| `--expiration_days <n>` | **新增**：有效期天数，默认 365 |
| `--facebook <text>` | **新增**：Facebook 账号，默认 `linkeoo` |
| `--standard_commission_rate <n>` | **新增**：标准佣金率%，默认 12 |
| `--shop_ads_commission <true/false>` | **新增**：是否开启店铺广告佣金，默认 `true` |
| `--shop_ads_commission_rate <n>` | **新增**：店铺广告佣金率%，默认 6 |
| `--free_sample <true/false>` | **新增**：是否勾选提供免费样品，默认 `true` |
| `--auto_approve <true/false>` | **新增**：是否勾选手动审核申请，默认 `true` |
| `--scroll_rounds <n>` | 为选择更多达人而滚动列表的轮数，默认 `8` |

## 示例

测试创建邀约流程（使用默认值）：

```bash
node tiktok_affiliate_bulk_invite_creators.mjs --useLaunchApi --code BUPM2Z --shop_region PH --max_creators 3 --product_ids "1735908621623067671" --useNewFlow
```

多层级类目选择（女装与女士内衣下的女士连衣裙）：

```bash
node tiktok_affiliate_bulk_invite_creators.mjs --useLaunchApi --code BUPM2Z --shop_region PH --max_creators 5 --product_category "女装与女士内衣-女士连衣裙" --product_ids "1735908621623067671" --useNewFlow
```

多个商品ID：

```bash
node tiktok_affiliate_bulk_invite_creators.mjs --useLaunchApi --code BUPM2Z --shop_region PH --max_creators 3 --product_ids "1735908621623067671,1735908517355226135" --useNewFlow
```

自定义参数：

```bash
node tiktok_affiliate_bulk_invite_creators.mjs --useLaunchApi --code BUPM2Z --shop_region PH --max_creators 5 --product_ids "1735908621623067671" --invitation_name "女装品牌合作" --invitation_text "Hi, we'd love to collaborate!" --standard_commission_rate 15 --shop_ads_commission_rate 8 --useNewFlow
```

关键词搜索并随机排序：

```bash
node tiktok_affiliate_bulk_invite_creators.mjs --useLaunchApi --code BUPM2Z --shop_region PH --max_creators 5 --product_ids "1733357293296059415" --creator_search "bra" --random_sort true --useNewFlow
```

## 已实测页面结构

- 联盟中心顶栏右上角：头像 + 站点码（如 `PH`）。仅改 URL 的 `shop_region` 不一定生效；需以顶栏站点标识为准，不一致时点击头像，在 `Choose one to manage` 面板内选择目标行（探针实测：`MY Malaysia`、`PH Philippines`、`SG Singapore`、`TH Thailand`、`Vietnam (店名)` 等）。**禁止**在全页模糊匹配 `PH`，避免误点达人名（如 `PhượngEm99`）。
- 页面顶部按钮为 `批量邀请`，未选择达人时禁用。
- 列表行左侧是 `arco-checkbox`，勾选后页面显示 `已选择 N/50 位达人`。
- 批量邀请弹窗内有两个标签：`进行中` 和 `创建新邀请`。
- `创建新邀请` 标签中有 `仅佣金` 选项。
- 弹窗底部 `邀请` 按钮点击后跳转到 `/target-invitation/create` 表单页。
- 表单页有 6 个折叠面板：创建邀请（基础信息）、选择商品、设置免费样品、选择达人。
- 商品表格支持双击单元格进入行内编辑：标准佣金率（%）和店铺广告佣金率（-）。
- 店铺广告佣金有开关（switch），打开后显示"-"cell 可填佣金率。
- 必填字段：邀请名称、有效期、Facebook、邀请文本、商品 + 佣金率。

## 默认值说明

| 字段 | 默认值 |
|---|---|
| 邀请名称 | 日期+4位随机数（如 `202606053592`） |
| 有效期 | 一年后 |
| Facebook 账号 | `linkeoo` |
| 邀请文本 | `Hi, your content style aligns perfectly with our product. This item is already a bestseller and has delivered outstanding sales results across other markets. We provide free samples and competitive commission, hoping we can cooperate.` |
| 标准佣金率 | 12% |
| 店铺广告佣金 | 开启 |
| 店铺广告佣金率 | 6% |
| 免费样品 | 勾选 |
| 手动审核申请 | 勾选 |

## 已知限制

- 产品选择：脚本会在"选择商品"面板中按用户提供的商品ID搜索并勾选。如果商品不在店铺列表中，会跳过该ID。
- 佣金率设置：使用行内编辑（双击单元格）。如果双击未触发编辑，会跳过该字段。
- 提交验证：如果有任何必填字段未填，提交会显示"无法提交"错误。需手动检查后重试。

## 页面运行步骤说明（showPageToast）

| 阶段 | 页面提示示例 |
|---|---|
| 开始 | `[脚本] 开始联盟批量邀约达人：区域 PH，最多 50 人` |
| 打开页面 | `[脚本] 正在打开联盟达人发现页（区域 PH）` |
| 站点切换 | `[脚本] 页面站点为 PH，正在通过顶栏切换到 MY` / `[脚本] 已通过顶栏切换到站点 MY` |
| 筛选/搜索 | `[脚本] 正在搜索达人：「top」` |
| 勾选达人 | `[脚本] 已勾选 N 位达人，正在点击「批量邀约」` |
| 创建邀请 | `[脚本] 正在切换到「创建新邀请」·「仅佣金」` |
| 填表 | `[脚本] 正在填写邀约表单（商品 1 个）` |
| 发送 | `[脚本] 合作邀请发送成功` |

单/多区域结束后弹 **汇总 modal**；`--keepOpen` 时不自动关浏览器。

## 注意

- 真实运行会发出联盟达人邀约，请谨慎使用。
- 需要使用已登录 TikTok Shop 联盟中心的浏览器档案。
- 如果页面筛选条件或排序变化，脚本会基于当前列表前若干位达人进行邀约。
