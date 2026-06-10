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
| `--dryRun` | 只打开页面并定位按钮，不点击最终的 `更新 N 件商品` |
| `--keepOpen` | 执行后不主动关闭连接的浏览器 |
| `--wait_ms <ms>` | 页面加载后等待时间，默认 `1500` |
| `--update_button_timeout_ms <ms>` | 每一批等待 `更新 N 件商品` 从加载态变为可点击的时间，默认 `60000` |
| `--max_update_batches <n>` | 最大更新批次数，默认 `100`，用于防止页面异常导致无限循环 |
| `--max_optimize_rounds <n>` | 重新进入批量优化流程的最大轮数，默认 `1`。当一轮提示没有更多 `更新 N 件商品` 后，脚本会重新打开商品优化页并再次点击 `批量优化`，直到达到轮数上限或没有新的可更新商品 |
| `--after_optimize_round_ms <ms>` | 每轮结束、重新进入下一轮前的等待时间，默认 `1500` |
| `--max_runtime_ms <ms>` | 整个脚本的最长运行时间，默认 `0` 表示不限制；达到上限后会返回已完成批次 |

## 示例

安全调试，只定位前两个站点的按钮，不提交更新：

```bash
node playwright_scripts/tiktok_product_optimizer_batch_update/tiktok_product_optimizer_batch_update.mjs --useLaunchApi --code IKXSD8 --shop_region '["MY","PH"]' --dryRun
```

真实执行并最多重新进入 20 轮批量优化流程：

```bash
node playwright_scripts/tiktok_product_optimizer_batch_update/tiktok_product_optimizer_batch_update.mjs --useLaunchApi --code IKXSD8 --shop_region '["MY"]' --max_optimize_rounds 20
```

真实执行多个站点：

```bash
node playwright_scripts/tiktok_product_optimizer_batch_update/tiktok_product_optimizer_batch_update.mjs --useLaunchApi --code IKXSD8 --shop_region '["MY","PH","TH"]'
```

连接已有 CDP：

```bash
node playwright_scripts/tiktok_product_optimizer_batch_update/tiktok_product_optimizer_batch_update.mjs --cdp http://127.0.0.1:19876 --shop_region '["MY","PH"]' --dryRun
```

## 注意

- 不加 `--dryRun` 会真实点击 `更新 N 件商品`，会对当前店铺商品优化产生实际影响。
- 需要使用已登录 TikTok Shop 卖家中心的浏览器档案。
- 运行过程中脚本会在页面底部显示短暂日志提示，例如当前站点、轮次、批次与点击数量；终端也会同步输出同样进度。
- 如果页面文案或按钮位置变化，先用 `--dryRun --keepOpen` 观察返回的 `bodyPreview` 和当前页面，再调整选择器。
