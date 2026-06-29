#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractLaunchApiDocs } from './extract-launch-api-docs.mjs'

const VAULT = process.argv[2] || 'C:\\Users\\66470\\Desktop\\Memo\\Memo'
const OUT = path.join(VAULT, 'Projects', 'NexBrowser', '自动化接口')

const NAV = `## 目录

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

function fm() {
  return `---
source: frontend/src/modules/browser/pages/LaunchApiDocsPage.tsx
synced: 2026-06-21
tags:
  - nexbrowser
  - launch-api
  - automation
---

`
}

async function patchReadmeDocMap(readmePath) {
  let text = await fs.readFile(readmePath, 'utf8')
  const row = '| [[自动化接口/README\\|自动化接口]] | Launch HTTP API（应用内「接口文档」） |'
  if (text.includes('[[自动化接口/README')) return
  const anchor = '| [[Playwright 脚本规约]] | 脚本开发硬性规约 |'
  if (text.includes(anchor)) {
    text = text.replace(anchor, `${anchor}\n${row}`)
  } else {
    text = text.replace(
      '# 文档地图\n\n| 笔记 | 说明 |\n|------|------|',
      `# 文档地图\n\n| 笔记 | 说明 |\n|------|------|\n${row}`,
    )
  }
  await fs.writeFile(readmePath, text, 'utf8')
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const { files } = await extractLaunchApiDocs()
  for (const { dest, content } of files) {
    const body = dest === 'README.md' ? NAV + content : content
    await fs.writeFile(path.join(OUT, dest), fm() + body, 'utf8')
    console.log('✓', dest)
  }
  const readmePath = path.join(VAULT, 'Projects', 'NexBrowser', 'README.md')
  try {
    await patchReadmeDocMap(readmePath)
    console.log('✓ README.md 文档地图已更新')
  } catch {
    console.warn('skip README doc map patch')
  }
  console.log(`→ ${OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
