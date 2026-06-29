/**
 * Live Bridge 页面正文提取（基于 Defuddle，与 Obsidian Web Clipper 同款引擎）
 */
import { Defuddle } from 'defuddle/node'
import type { PlaywrightPage } from './playwright-loader'

export interface ExtractContentOptions {
  /** 输出 Markdown（默认 true） */
  markdown?: boolean
  /** 同时返回清洗后的 HTML */
  includeHtml?: boolean
  /** 截断 Markdown 最大字符数（0 = 不截断） */
  maxChars?: number
  /** 强制以此 CSS 选择器为正文根，跳过自动检测 */
  contentSelector?: string
  /** 允许异步 extractor（如 YouTube 字幕），默认 true */
  useAsync?: boolean
}

export interface ExtractContentResult {
  url: string
  title: string
  author: string
  description: string
  site: string
  published: string
  language: string
  image: string
  favicon: string
  wordCount: number
  parseTime: number
  extractorType?: string
  markdown: string
  contentHtml?: string
  variables?: Record<string, string>
  truncated?: boolean
}

/**
 * 从 HTML 字符串提取页面正文 Markdown 与元数据。
 */
export async function extractContentFromHtml(
  html: string,
  url: string,
  options: ExtractContentOptions = {},
): Promise<ExtractContentResult> {
  const wantMarkdown = options.markdown !== false
  const includeHtml = Boolean(options.includeHtml)
  const maxChars = Math.max(0, Number(options.maxChars ?? 0))
  const useAsync = options.useAsync !== false

  const defuddleOptions: Record<string, unknown> = {
    url,
    useAsync,
  }

  if (wantMarkdown && includeHtml) {
    defuddleOptions.separateMarkdown = true
  } else if (wantMarkdown) {
    defuddleOptions.markdown = true
  }

  if (options.contentSelector) {
    defuddleOptions.contentSelector = options.contentSelector
  }

  const result = await Defuddle(html, url, defuddleOptions)

  let markdown = ''
  let contentHtml: string | undefined

  if (wantMarkdown && includeHtml) {
    markdown = result.contentMarkdown ?? ''
    contentHtml = result.content
  } else if (wantMarkdown) {
    markdown = result.content
  } else {
    contentHtml = result.content
  }

  let truncated = false
  if (maxChars > 0 && markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars) + '\n\n...[truncated]'
    truncated = true
  }

  return {
    url,
    title: result.title || '',
    author: result.author || '',
    description: result.description || '',
    site: result.site || '',
    published: result.published || '',
    language: result.language || '',
    image: result.image || '',
    favicon: result.favicon || '',
    wordCount: result.wordCount,
    parseTime: result.parseTime,
    extractorType: result.extractorType,
    markdown,
    contentHtml,
    variables: result.variables,
    truncated,
  }
}

/**
 * 在页面上下文中展平 Shadow DOM 并序列化完整 HTML。
 */
export async function capturePageHtml(page: PlaywrightPage): Promise<string> {
  return page.evaluate(() => {
    function flattenShadow(root: Document | Element) {
      const all = root.querySelectorAll('*')
      for (let i = 0; i < all.length; i++) {
        const el = all[i]
        const shadow = el.shadowRoot
        if (!shadow || shadow.childNodes.length === 0) continue
        const host = el
        if (host.tagName.includes('-')) {
          const div = document.createElement('div')
          div.setAttribute('data-shadow-host', host.tagName.toLowerCase())
          while (shadow.firstChild) {
            div.appendChild(shadow.firstChild)
          }
          host.replaceWith(div)
        } else {
          while (shadow.firstChild) {
            host.appendChild(shadow.firstChild)
          }
        }
      }
    }
    flattenShadow(document)
    return `<!DOCTYPE html>${document.documentElement.outerHTML}`
  })
}
