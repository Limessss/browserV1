# TikTok Shop 发布待发布带货视频

成对脚本：`tiktok_publish_pending_videos.mjs`

遵守上级 `../README.md`：先用真实已登录浏览器/CDP 验证，再维护脚本。

## 目标

打开：

`https://seller.tiktokshopglobalselling.com/shoppable-videos/material-2-video?from=tab&shop_region=MY`

扫描资源库中：

- `已完成`
- `已生成 N 个视频`，且 `N > 0`
- 发布状态为 `未发布 0/N 已发布` 或 `已部分发布 M/N 已发布`

对这些项目进入 `查看`，逐个发布，直到 `已发布数 == 已生成数`。`未完成`、`0/0 已发布` 的项目跳过。

## 已验证的真实页面流程

1. 通过 NexBrowser/Launch 的真实 CDP 连接已登录会话，例如：

```bash
node playwright_scripts/tiktok_publish_pending_videos/tiktok_publish_pending_videos.mjs --cdp http://127.0.0.1:55638 --shop_region MY
```

2. 列表页行文案包含商品 ID、生成数、发布数，示例：

`ID: 1734932798466852532 已完成 已生成 2 个视频 未发布 0/2 已发布 ... 查看`

3. 点击行内 `查看` 后，右侧出现 AI 视频生成器详情：

`你的视频已准备就绪！选择一个视频发布。`

4. 点击详情区 `在 TikTok 上发布`，进入最终发布表单。

5. 最终表单发布前必须做两个等待/修正：

- 确认 `商品` 区已经加载出商品卡片，能看到当前商品 ID 和 `编辑` 按钮。
- 滚动到 `AI 生成的内容`，确保开关处于开启状态。

6. 若过早点击最终发布，会出现 `将商品添加到你的视频` 对话框。脚本会关闭该对话框，等待商品卡片加载后重试。

7. 点击最终表单底部 `在 TikTok 上发布`，等待：

`你的视频发布成功`

然后刷新回列表继续。

## 参数

| 参数 | 说明 |
|---|---|
| `--cdp <url>` | 连接真实浏览器 CDP，推荐使用 NexBrowser 的调试端口 |
| `--useLaunchApi` | 通过 Launch HTTP `/api/launch` 启动档案并获取 CDP |
| `--code` / `--keyword` / `--profileId` / `--profileName` | Launch selector |
| `--shop_region <code>` | 默认 `MY` |
| `--pages <n>` | 扫描页数，默认 5 |
| `--max <n>` | 最大发布视频数，默认 200 |
| `--keepOpen` | 结束后不关闭 CDP 连接 |

## 注意

- 发布动作会实际发布 TikTok 内容。
- 脚本每次发布前都会重新确认商品卡片已加载，避免误触 `将商品添加到你的视频`。
- 脚本会打开 `AI 生成的内容` 开关后再最终发布。
