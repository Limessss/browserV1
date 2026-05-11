# TikTok Ads GMV Max Dashboard · 多店铺广告概览汇总

> 成对脚本：`tiktok_ads_gmv_max_dashboard.mjs`  
> 目标页面：`https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=<广告账号ID>&oec_seller_id=withoutShop`

## 前置

- 需要使用已登录 TikTok Ads / GMV Max 的真实浏览器会话。
- `--aadvid` 是必填参数，脚本会用它拼接访问 `dashboard?aadvid=<广告账号ID>&oec_seller_id=withoutShop`。
- 日期口径通过 `--date_range` 指定，默认 `today`。

## 运行示例

```bash
node playwright_scripts/tiktok_ads_gmv_max_dashboard/tiktok_ads_gmv_max_dashboard.mjs --useLaunchApi --code IKXSD8 --aadvid 7581297450980294657
node playwright_scripts/tiktok_ads_gmv_max_dashboard/tiktok_ads_gmv_max_dashboard.mjs --useLaunchApi --code IKXSD8 --aadvid 7581297450980294657 --date_range yesterday
node playwright_scripts/tiktok_ads_gmv_max_dashboard/tiktok_ads_gmv_max_dashboard.mjs --cdp http://127.0.0.1:19876 --aadvid 7581297450980294657 --date_range last7
```

## CLI 参数

| 参数 | 说明 |
|------|------|
| `--useLaunchApi` | 调用本地 Launch API 拉起登录会话 |
| `--code <code>` | Launch 环境码 |
| `--aadvid <id>` | 必填，广告账号 ID |
| `--date_range <preset>` | 日期快捷项，默认 `today` |
| `--cdp <url>` | 附着已有 CDP 浏览器 |
| `--shops <list>` | 手动指定店铺，支持逗号分隔或 JSON 数组 |
| `--max_shops <n>` | 自动识别店铺时最多处理几个，默认 50 |
| `--out_dir <dir>` | 报告输出目录，默认当前脚本目录下 `reports` |
| `--keepOpen` | 运行结束后保持浏览器不关闭，便于调试 |

## 日期参数

| 参数值 | 页面选项 |
|------|------|
| `today` | 今天 |
| `yesterday` | 昨天 |
| `last7` | 近 7 天 |
| `last30` | 近 30 天 |
| `last3m` | 近 3 个月 |
| `last6m` | 近 6 个月 |
| `last12m` | 过去 12 个月 |

## MCP 页面验证步骤

| 步骤 | 操作 |
|------|------|
| 1 | 打开 `https://ads.tiktok.com/i18n/gmv-max/dashboard?aadvid=<广告账号ID>&oec_seller_id=withoutShop` |
| 2 | 点击日期选择器，选择 `--date_range` 对应的快捷项 |
| 3 | 点击“切换到其他店铺”，读取可用店铺列表 |
| 4 | 逐个选择店铺并点击“下一步” |
| 5 | 等待概览指标刷新，读取成本、总收入、ROI、SKU 订单数、平均下单成本 |

## 输出

脚本会在 `reports` 目录生成：

- `tiktok_ads_gmv_max_dashboard_<timestamp>.json`
- `tiktok_ads_gmv_max_dashboard_<timestamp>.html`

HTML 内含中文看板、排行、可排序明细表和折叠的原始 JSON。
