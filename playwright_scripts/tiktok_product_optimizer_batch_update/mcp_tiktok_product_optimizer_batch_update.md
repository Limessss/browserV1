# TikTok Shop 商品批量优化更新

配套脚本：`tiktok_product_optimizer_batch_update.mjs`

## 目标

按传入的 `shop_region` 数组逐个访问：

`https://seller.tiktokshopglobalselling.com/product/optimizer?shop_region=MY`

进入每个站点后执行：

1. 点击页面上的 `批量优化`。
2. 等待右侧弹出的批量优化侧边栏。
3. 点击侧边栏中的 `更新 N 件商品`。
4. 更新完成后如果侧边栏仍出现新的 `更新 N 件商品`，继续点击，直到没有可更新商品。

## 参数

| 参数 | 说明 |
|---|---|
| `--shop_region <value>` | 使用 JSON 数组依次执行，例如 `["MY","PH","TH"]`；为兼容旧命令，也保留 `MY`、`MY,PH,TH` 写法 |
| `--useLaunchApi` | 通过本地 Launch API 启动并连接真实已登录浏览器 |
| `--code <code>` | Launch 环境代码，默认示例为 `IKXSD8` |
| `--cdp <url>` | 直接连接已启动浏览器 CDP |
| `--keepOpen` | 执行后不主动关闭连接的浏览器 |
| `--wait_ms <ms>` | 页面加载后等待时间，默认 `1500` |
| `--update_button_timeout_ms <ms>` | 每一批等待 `更新 N 件商品` 从加载态变为可点击的时间，默认 `60000` |
| `--max_update_batches <n>` | 最大更新批次数，默认 `100`，用于防止页面异常导致无限循环 |
| `--max_optimize_rounds <n>` | 重新进入批量优化流程的最大轮数，默认 `1`。当一轮提示没有更多 `更新 N 件商品` 后，脚本会重新打开商品优化页并再次点击 `批量优化`，直到达到轮数上限或没有新的可更新商品 |
| `--after_optimize_round_ms <ms>` | 每轮结束、重新进入下一轮前的等待时间，默认 `1500` |
| `--max_runtime_ms <ms>` | 整个脚本的最长运行时间，默认 `0` 表示不限制；达到上限后会返回已完成批次 |

## 示例

单站点执行并最多重新进入 20 轮批量优化流程：

```bash
node playwright_scripts/tiktok_product_optimizer_batch_update/tiktok_product_optimizer_batch_update.mjs --useLaunchApi --code IKXSD8 --shop_region '["MY"]' --max_optimize_rounds 20
```

多站点执行：

```bash
node playwright_scripts/tiktok_product_optimizer_batch_update/tiktok_product_optimizer_batch_update.mjs --useLaunchApi --code IKXSD8 --shop_region '["MY","PH","TH"]'
```

连接已有 CDP：

```bash
node playwright_scripts/tiktok_product_optimizer_batch_update/tiktok_product_optimizer_batch_update.mjs --cdp http://127.0.0.1:19876 --shop_region '["MY","PH"]' --keepOpen
```

## 页面运行步骤说明（showPageToast）

运行时在页面底部显示 **3 秒一闪** 的中文提示（`[脚本]` 前缀），终端同步输出同样内容：

| 阶段 | 页面提示示例 |
|---|---|
| 开始 | `[脚本] 开始商品批量优化更新：区域 MY` |
| 多区域 | `[脚本] 开始商品批量优化更新 [区域 1/3 · MY]：…` |
| 打开页面 | `[脚本] 第 1/20 轮：正在打开商品优化页（区域 MY）` |
| 页面就绪 | `[脚本] 商品优化页已打开` |
| 批量优化 | `[脚本] 正在点击「批量优化」` → `已点击「批量优化」：…` |
| 侧边栏更新 | `[脚本] 侧边栏已打开，正在点击「更新 N 件商品」` |
| 每批更新 | `[脚本] 第 1 批：已点击「更新 5 件商品」（5 件）` |
| 轮次结束 | `[脚本] 本轮结束：无可更新商品 · 累计 15 件` |
| 下一区域 | `[脚本] 区域 MY 已完成，继续下一区域：PH` |

全部区域跑完后弹出 **汇总 modal**（单区域 1 次 / 多区域仅 1 次汇总）；未点「确定」时约 30 秒后自动关闭浏览器（`--keepOpen` 时不倒计时、不自动关）。

## 注意

- 脚本会真实点击 `更新 N 件商品`，会对当前店铺商品优化产生实际影响。
- 需要使用已登录 TikTok Shop 卖家中心的浏览器档案。
- 如果页面文案或按钮位置变化，可用 `--keepOpen` 观察返回的 `bodyPreview` 和当前页面，再调整选择器。
