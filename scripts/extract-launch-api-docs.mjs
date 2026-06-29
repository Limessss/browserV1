#!/usr/bin/env node
/**
 * Extract Launch HTTP API markdown from LaunchApiDocsPage.tsx (single source in UI).
 * Usage: node scripts/extract-launch-api-docs.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const TSX = path.join(REPO, 'frontend/src/modules/browser/pages/LaunchApiDocsPage.tsx')

/** @type {{ constName: string; dest: string }[]} */
const SECTIONS = [
  { constName: 'DOC_OVERVIEW', dest: 'README.md' },
  { constName: 'DOC_QUICKSTART', dest: '快速接入.md' },
  { constName: 'DOC_SELECTOR', dest: '选择器规则.md' },
  { constName: 'DOC_API_INDEX', dest: '接口总览.md' },
  { constName: 'DOC_API_HEALTH', dest: '健康检查.md' },
  { constName: 'DOC_API_PROFILES', dest: '实例管理.md' },
  { constName: 'DOC_API_LAUNCH_GET', dest: '按 Code 启动.md' },
  { constName: 'DOC_API_LAUNCH_POST', dest: '参数化启动.md' },
  { constName: 'DOC_API_CDP', dest: 'CDP 统一入口.md' },
  { constName: 'DOC_API_LOGS', dest: '调用记录.md' },
  { constName: 'DOC_API_PLAYWRIGHT', dest: '自动化脚本 API.md' },
  { constName: 'DOC_SCENARIOS', dest: '场景示例.md' },
  { constName: 'DOC_ERRORS', dest: '错误与重试.md' },
  { constName: 'DOC_EXAMPLES', dest: '多语言示例.md' },
  { constName: 'DOC_PRACTICES', dest: '最佳实践.md' },
  { constName: 'DOC_TROUBLESHOOT', dest: '常见问题.md' },
]

function unescapeTemplateLiteral(raw) {
  return raw.replace(/\\`/g, '`').replace(/\\\$/g, '$')
}

/** @param {string} tsx */
function extractConst(tsx, name) {
  const marker = `const ${name} = \``
  const start = tsx.indexOf(marker)
  if (start < 0) throw new Error(`Missing ${name} in LaunchApiDocsPage.tsx`)
  let i = start + marker.length
  let out = ''
  while (i < tsx.length) {
    const ch = tsx[i]
    if (ch === '\\') {
      const next = tsx[i + 1]
      if (next === '`') {
        out += '\\`'
        i += 2
        continue
      }
      if (next === '$') {
        out += '\\$'
        i += 2
        continue
      }
      out += ch
      i += 1
      continue
    }
    if (ch === '`') {
      const tail = tsx.slice(i + 1).match(/^\s*\n/)
      if (tail) return unescapeTemplateLiteral(out)
    }
    out += ch
    i += 1
  }
  throw new Error(`Unclosed template for ${name}`)
}

export async function extractLaunchApiDocs() {
  const tsx = await fs.readFile(TSX, 'utf8')
  /** @type {Map<string, string>} */
  const byConst = new Map()
  for (const { constName } of SECTIONS) {
    byConst.set(constName, extractConst(tsx, constName))
  }

  /** @type {{ dest: string; content: string }[]} */
  const files = []
  for (const { constName, dest } of SECTIONS) {
    const body = byConst.get(constName)
    if (!body) throw new Error(`No content for ${constName}`)
    files.push({ dest, content: body })
  }

  return { files }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  extractLaunchApiDocs()
    .then(({ files }) => {
      console.log(`Extracted ${files.length} sections from LaunchApiDocsPage.tsx`)
      for (const f of files) console.log(' ', f.dest, `(${f.content.length} chars)`)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
