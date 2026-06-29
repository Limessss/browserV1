#!/usr/bin/env node
/**
 * One-shot sync ant-browser-desktop docs → Obsidian vault (Projects/NexBrowser/).
 * Usage: node scripts/sync-docs-to-obsidian.mjs [vaultRoot]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractLaunchApiDocs } from './extract-launch-api-docs.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const VAULT =
  process.argv[2] ||
  process.env.OBSIDIAN_VAULT ||
  'C:\\Users\\66470\\Desktop\\Memo\\Memo'
const OUT = path.join(VAULT, 'Projects', 'NexBrowser')

const SYNCED = '2026-06-21'

function fm(source, tags = ['nexbrowser']) {
  return `---\nsource: ${source}\nsynced: ${SYNCED}\ntags:\n${tags.map((t) => `  - ${t}`).join('\n')}\n---\n\n`
}

/** @type {{ dest: string; src?: string; content?: string; tags?: string[] }}[] */
const FILES = [
  { dest: 'AGENTS.md', src: 'AGENTS.md', tags: ['nexbrowser', 'agents', 'runbook'] },
  { dest: 'ARCHITECTURE.md', src: 'ARCHITECTURE.md', tags: ['nexbrowser', 'architecture'] },
  { dest: 'Live Bridge.md', src: 'docs/live-bridge/README.md', tags: ['nexbrowser', 'live-bridge'] },
  { dest: 'Live Bridge Roadmap.md', src: 'docs/live-bridge/ROADMAP.md', tags: ['nexbrowser', 'live-bridge', 'roadmap'] },
  {
    dest: 'Playwright 脚本规约.md',
    src: 'playwright_scripts/README.md',
    tags: ['nexbrowser', 'playwright', 'scripts'],
  },
  { dest: 'bin 代理二进制.md', src: 'bin/README.md', tags: ['nexbrowser', 'bin', 'proxy'] },
  {
    dest: 'Scripts/关键词提报.md',
    src: 'playwright_scripts/tiktok_auto_keyword_submit/mcp_tiktok_auto_keyword_submit.md',
    tags: ['nexbrowser', 'script', 'keyword'],
  },
  {
    dest: 'Scripts/联盟批量邀约.md',
    src: 'playwright_scripts/tiktok_affiliate_bulk_invite_creators/mcp_tiktok_affiliate_bulk_invite_creators.md',
    tags: ['nexbrowser', 'script', 'affiliate'],
  },
  {
    dest: 'Scripts/商品批量优化.md',
    src: 'playwright_scripts/tiktok_product_optimizer_batch_update/mcp_tiktok_product_optimizer_batch_update.md',
    tags: ['nexbrowser', 'script', 'optimizer'],
  },
  {
    dest: 'Scripts/发布待发布视频.md',
    src: 'playwright_scripts/tiktok_publish_pending_videos/mcp_tiktok_publish_pending_videos.md',
    tags: ['nexbrowser', 'script', 'video'],
  },
  {
    dest: 'Scripts/Compass Top10 AI视频.md',
    src: 'playwright_scripts/tiktok_compass_top10_random5_ai_video/mcp_tiktok_compass_top10_random5_ai_video.md',
    tags: ['nexbrowser', 'script', 'compass'],
  },
  {
    dest: 'Scripts/Ads GMV Max 概览.md',
    src: 'playwright_scripts/tiktok_ads_gmv_max_dashboard/mcp_tiktok_ads_gmv_max_dashboard.md',
    tags: ['nexbrowser', 'script', 'ads'],
  },
  {
    dest: 'Scripts/榜单1688图搜采集.md',
    src: 'playwright_scripts/tiktok_ranking_1688_image_collect/mcp_tiktok_ranking_1688_image_collect.md',
    tags: ['nexbrowser', 'script', '1688'],
  },
]

const SCRIPTS_OVERVIEW = `# NexBrowser · 自动化脚本总览

> 成对维护：每个脚本目录含 \`*.mjs\` + \`mcp_*.md\` + \`script.json\`。改脚本前读 [[Playwright 脚本规约]]。

| 笔记 | 目录 | 业务 |
|------|------|------|
| [[关键词提报]] | \`tiktok_auto_keyword_submit\` | TikTok 机会中心关键词 DOM+API 提报 |
| [[联盟批量邀约]] | \`tiktok_affiliate_bulk_invite_creators\` | 联盟达人批量邀约 |
| [[商品批量优化]] | \`tiktok_product_optimizer_batch_update\` | 商品优化页批量更新 |
| [[发布待发布视频]] | \`tiktok_publish_pending_videos\` | 带货视频资源库发布 |
| [[Compass Top10 AI视频]] | \`tiktok_compass_top10_random5_ai_video\` | Compass 高曝光随机选品 → AI 视频 |
| [[Ads GMV Max 概览]] | \`tiktok_ads_gmv_max_dashboard\` | TikTok Ads GMV Max 多店汇总 |
| [[榜单1688图搜采集]] | \`tiktok_ranking_1688_image_collect\` | ERP 榜单 → 1688 图搜 → 仓库采集 |

## 通用启动

\`\`\`bash
npm run dev   # Launch API + Live Bridge 依赖主进程

node playwright_scripts/<主题>/<主题>.mjs --useLaunchApi --code <环境码> --shop_region MY
\`\`\`

## 相关

- [[Live Bridge]] · [[AGENTS]] · [[批跑 Runbook]]
`

const RUNBOOK_BATCH = `# 13 店批跑 Runbook

> 与 [[AGENTS#1. Browser Runner 并发模式: 3 槽滚动常驻 (Hard Rule)]] 一致。region 顺序：**MY → PH → SG → TH → VN**（单店按实际开通 region 子集串行）。

## 前置

1. \`npm run dev\` 启动 NexBrowser（Launch \`127.0.0.1:19876\`）
2. 确认 13 店 profile 已导入、关键店已登录 Seller Center
3. 关键词提报跑前确认 \`_temp/lead_list_script.js\` 存在（缺失 = bug）

## 3 槽滚动池（实例维度）

| 阶段 | 行为 |
|------|------|
| 启动 | 填满 **3 个不同店铺** Launch 实例 |
| 运行中 | 某店全部 region done → **立刻**补下一个未跑店铺 |
| 单槽内 | 同一店铺 region **串行**，禁止单实例多 region 并行 |
| 杀进程 | **仅按 profile UUID 杀** done 店 chrome；禁止 \`Get-Process chrome | Stop-Process\` 杀全部 |
| 收尾 | 13 店全部 done 后，逐个 UUID 清理 |

## 13 店环境码与 region（关键词提报参考）

| 环境码 | Regions |
|--------|---------|
| AF7H54 | MY, PH, SG, TH, VN |
| 0ZF9ZK | PH, TH, VN |
| FMUY6Y | MY, PH, TH, VN |
| V2FFWD | MY, PH, TH, VN |
| 0DAY5O | MY, PH, TH, VN |
| GMNQ5O | MY, PH, SG, TH |
| 6KFTAN | MY, TH, VN |
| M2SKTR | MY, PH, VN |
| XXDMP5 | MY, PH, TH |
| 3MBBNW | PH, TH, VN |
| BUPM2Z | MY, PH, TH, VN |
| 7SW0GA | MY, PH, TH, VN |
| NVZ572 | MY, PH, TH, VN |

## 常用命令

\`\`\`bash
# Live Bridge 探针（指定 code，勿 attach）
node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs send profile "{\\"code\\":\\"BUPM2Z\\"}"

# 单店关键词提报
node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \\
  --useLaunchApi --code BUPM2Z --shop_region MY --limit 5

# 脚本语法检查
node --check playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs
\`\`\`

## 日志与报告

| 路径 | 说明 |
|------|------|
| \`_coord/logs/\` | Runner 批跑 stdout/stderr |
| \`playwright_scripts/*/reports/\` | 各脚本 JSON 报告 |
| 应用内「日志」页 | 桌面端运行日志 |

## 相关笔记

- [[踩坑与决策]] · [[Playwright 脚本规约]] · [[关键词提报]]
`

const RUNBOOK_PITFALLS = `# 踩坑与决策记录

> 跨任务复用。详细规约见 [[AGENTS]]。

## 已知坑（来自 AGENTS §3）

- **AI 信用池跨设备消耗**：用户在别的电脑可能预先消耗，不影响脚本继续，不 HALT
- **chrome 进程数 ≠ 实例数**：NexBrowser 退出后 chrome 子进程可能残留，一般不耗资源
- **PowerShell + node JSON 转义**：用逗号分隔字符串，不用 JSON 数组
- **Compass「暂无数据」**：业务事实，不重试
- **\`_temp/lead_list_script.js\` 缺失**：bug，跑关键词提报前必须确认文件存在

## 2026-06-12 · 3 槽 cascade kill 事故

**现象**：3 店同时 fork 后 5–16s 全 cascade 退出；面板显示「每次只跑一个」。

**根因**：\`Get-Process chrome | Stop-Process -Force\` 杀全部 chrome，打断其他 2 槽。

**修正**：
- cascade 改为**按 profile UUID 只杀 done 店**
- 3 槽 = **实例维度**（3 不同店铺），非 region 维度
- 单实例内 region 串行 MY→PH→SG→TH→VN

→ 决策文档：可参考 AiTiktok 库 \`Projects/tiktok-shop-ops/decisions/001-3-slot-rolling-pool.md\`

## 2026-06-12 · lead_list_script.js 被清空

**现象**：13 店关键词提报 9 店 ENOENT。

**根因**：commit 24fe194 清空 \`_temp/*_script.js\`。

**修复**：\`git checkout 24fe194^ -- .../lead_list_script.js\` 恢复 72 行。

## 2026-06-20 · Compass SPA evaluate destroyed

**现象**：\`page.evaluate: Execution context was destroyed\`。

**修复**：\`tiktok_compass_top10_random5_ai_video.mjs\` v1.1.1 增加 \`safePageEvaluate\` retry。

→ 见 [[Compass Top10 AI视频#已知间歇问题（已修 v1.1.1）]]

## 页面/UI 改版

| 日期 | 脚本 | 结论 |
|------|------|------|
| 2026-06-14 | 关键词提报 | 默认 Tab 为「精选」，须显式点「关键词」Tab（v26） |
| 2026-06-14 | 关键词提报 | legacy / new 两种 drawer UI（v28） |
| 2026-06-14 | 关键词提报 | 虚拟滚动 + SQLite 去重 + 向下滚 \`.core-table-body\`（v0.9.5） |

## 模板：新踩坑条目

\`\`\`markdown
## YYYY-MM-DD · 标题

**现象**：

**根因**：

**修正**：
\`\`\`
`

const DOC_MAP = `# 文档地图

| 笔记 | 说明 |
|------|------|
| [[AGENTS]] | Agent 协作硬规则、3 槽并发 |
| [[ARCHITECTURE]] | Electron/Wails 架构对照 |
| [[Live Bridge]] | AI 浏览器接管协议 |
| [[Live Bridge Roadmap]] | Live Bridge 演进 |
| [[Playwright 脚本规约]] | 脚本开发硬性规约 |
| [[自动化接口/README\\|自动化接口]] | Launch HTTP API（应用内「接口文档」） |
| [[Scripts/脚本总览\\|脚本总览]] | 7 套业务自动化 |
| [[Runbook/批跑 Runbook\\|批跑 Runbook]] | 13 店 + 3 槽 |
| [[Runbook/踩坑与决策\\|踩坑与决策]] | 历史事故与已知坑 |
| [[bin 代理二进制]] | xray / sing-box |

---

`

const LAUNCH_API_NAV = `## 目录

| 章节 | 笔记 |
|------|------|
| 快速接入 | [[快速接入]] |
| 选择器规则 | [[选择器规则]] |
| 接口总览 | [[接口总览]] |
| 健康检查 | [[健康检查]] |
| 实例管理 | [[实例管理]] |
| 按 Code 启动 | [[按 Code 启动]] |
| 参数化启动 | [[参数化启动]] |
| CDP 统一入口 | [[CDP 统一入口]] |
| 调用记录 | [[调用记录]] |
| 自动化脚本 API | [[自动化脚本 API]] |
| 场景示例 | [[场景示例]] |
| 错误与重试 | [[错误与重试]] |
| 多语言示例 | [[多语言示例]] |
| 最佳实践 | [[最佳实践]] |
| 常见问题 | [[常见问题]] |

> 应用内：**自动化 → 接口文档**（\`/browser/launch-api\`） · 源码 \`LaunchApiDocsPage.tsx\`

---

`

async function main() {
  await fs.mkdir(path.join(OUT, 'Scripts'), { recursive: true })
  await fs.mkdir(path.join(OUT, 'Runbook'), { recursive: true })

  const written = []

  for (const item of FILES) {
    const srcPath = path.join(REPO, item.src)
    let body
    try {
      body = await fs.readFile(srcPath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        console.warn(`skip missing: ${item.src}`)
        continue
      }
      throw err
    }
    const outPath = path.join(OUT, item.dest)
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    const content = fm(`ant-browser-desktop/${item.src.replace(/\\/g, '/')}`, item.tags) + body
    await fs.writeFile(outPath, content, 'utf8')
    written.push(item.dest)
  }

  const extras = [
    ['Scripts/脚本总览.md', fm('generated', ['nexbrowser', 'scripts', 'moc']) + SCRIPTS_OVERVIEW],
    ['Runbook/批跑 Runbook.md', fm('generated/from AGENTS + _coord', ['nexbrowser', 'runbook']) + RUNBOOK_BATCH],
    ['Runbook/踩坑与决策.md', fm('generated/from AGENTS + postmortems', ['nexbrowser', 'runbook']) + RUNBOOK_PITFALLS],
  ]

  for (const [dest, content] of extras) {
    await fs.writeFile(path.join(OUT, dest), content, 'utf8')
    written.push(dest)
  }

  const launchApiDir = path.join(OUT, '自动化接口')
  await fs.mkdir(launchApiDir, { recursive: true })
  const { files: launchApiFiles } = await extractLaunchApiDocs()
  for (const { dest, content } of launchApiFiles) {
    const body =
      dest === 'README.md'
        ? LAUNCH_API_NAV + content
        : content
    const outPath = path.join(launchApiDir, dest)
    const wrapped = fm(
      'frontend/src/modules/browser/pages/LaunchApiDocsPage.tsx',
      ['nexbrowser', 'launch-api', 'automation'],
    ) + body
    await fs.writeFile(outPath, wrapped, 'utf8')
    written.push(`自动化接口/${dest}`)
  }

  const readmePath = path.join(OUT, 'README.md')
  const repoReadme = await fs.readFile(path.join(REPO, 'README.md'), 'utf8')
  const readme =
    fm('ant-browser-desktop/README.md', ['nexbrowser', 'project', 'readme']) + DOC_MAP + repoReadme
  await fs.writeFile(readmePath, readme, 'utf8')
  written.push('README.md')

  console.log(`Synced ${written.length} files → ${OUT}`)
  for (const f of written) console.log('  ✓', f)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
