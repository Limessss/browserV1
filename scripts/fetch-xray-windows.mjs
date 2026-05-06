/**
 * 在 Windows 安装包构建前，从 Xray-core 官方 Release 拉取 xray.exe 到 bin/windows-amd64/。
 * 不落 Git：二进制仅在本地 / CI 构建产物中存在。
 *
 * 环境变量：
 * - FORCE_XRAY_FETCH=1  即使已有 xray.exe 也重新下载
 * - XRAY_RELEASE_TAG=v26.3.27  固定某个 tag（默认取 GitHub latest）
 * - XRAY_ZIP_URL=https://...  直接指定 zip 完整 URL（最高优先级，跳过 API）
 * - GITHUB_DOWNLOAD_MIRROR=https://ghfast.top  为 GitHub 资源 URL 加镜像前缀（下载 zip / API 用）
 * - 代理（默认同本机 Clash 系：127.0.0.1:7890，无需 Clash 时设 FETCH_XRAY_DIRECT=1）：
 *   FETCH_XRAY_DIRECT=1  禁止走代理、直连
 *   FETCH_XRAY_PROXY / HTTPS_PROXY / HTTP_PROXY / ALL_PROXY  显式代理 URL，如 http://127.0.0.1:7890
 *   FETCH_XRAY_PROXY_HOST / FETCH_XRAY_PROXY_PORT  只改本机代理地址与端口（在未设上述 URL 时生效）
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import AdmZip from 'adm-zip'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'bin', 'windows-amd64')
const OUT_EXE = join(OUT_DIR, 'xray.exe')

const UA = 'nexbrowser-desktop-fetch-xray/1.0'

/** GitHub 访问困难时设置，例如某些镜像站前缀 */
function mirrorGithubUrl(urlString) {
  const mirror = String(process.env.GITHUB_DOWNLOAD_MIRROR ?? '').trim().replace(/\/$/, '')
  if (!mirror || !urlString.includes('github.com')) {
    return urlString
  }
  return `${mirror}/${urlString}`
}

/** 未设置 FETCH_XRAY_DIRECT=1 时，默认经本机 7890 端口（与常见系统代理一致） */
function getProxyUrl() {
  if (String(process.env.FETCH_XRAY_DIRECT ?? '').trim() === '1') {
    return ''
  }
  const fromEnv =
    String(process.env.FETCH_XRAY_PROXY ?? '').trim() ||
    String(process.env.HTTPS_PROXY ?? '').trim() ||
    String(process.env.HTTP_PROXY ?? '').trim() ||
    String(process.env.ALL_PROXY ?? '').trim()
  if (fromEnv) return fromEnv
  const host = String(process.env.FETCH_XRAY_PROXY_HOST ?? '127.0.0.1').trim() || '127.0.0.1'
  const port = String(process.env.FETCH_XRAY_PROXY_PORT ?? '7890').trim() || '7890'
  return `http://${host}:${port}`
}

/** @param {string} targetUrl @param {string} proxyUrl */
function agentForUrl(targetUrl, proxyUrl) {
  if (!proxyUrl) return undefined
  try {
    const u = new URL(targetUrl)
    return u.protocol === 'https:'
      ? new HttpsProxyAgent(proxyUrl)
      : new HttpProxyAgent(proxyUrl)
  } catch {
    return undefined
  }
}

/** @param {string} urlString */
function httpGetBuffer(urlString, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) {
      reject(new Error('重定向次数过多'))
      return
    }
    let u
    try {
      u = new URL(urlString)
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    const client = u.protocol === 'https:' ? https : http
    const proxyUrl = getProxyUrl()
    const agent = agentForUrl(urlString, proxyUrl)
    const req = client.request(
      u,
      {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: '*/*' },
        ...(agent ? { agent } : {}),
      },
      (res) => {
        const loc = res.headers.location
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          const next = new URL(loc, urlString).href
          res.resume()
          httpGetBuffer(next, redirects - 1).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          const msg = `HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim()
          res.resume()
          reject(new Error(msg))
          return
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function fetchJson(url) {
  const buf = await httpGetBuffer(mirrorGithubUrl(url))
  return JSON.parse(buf.toString('utf8'))
}

function pickWindowsZipUrl(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const win = assets.find((a) => a?.name === 'Xray-windows-64.zip')
  if (win?.browser_download_url) {
    return { tag: release.tag_name, url: win.browser_download_url }
  }
  throw new Error('Release 中未找到资源 Xray-windows-64.zip')
}

async function resolveDownloadUrl() {
  const direct = String(process.env.XRAY_ZIP_URL ?? '').trim()
  if (direct) {
    return { tag: '(custom)', url: mirrorGithubUrl(direct) }
  }
  const fixed = String(process.env.XRAY_RELEASE_TAG ?? '').trim()
  if (fixed) {
    const tag = fixed.startsWith('v') ? fixed : `v${fixed}`
    const url = mirrorGithubUrl(
      `https://github.com/XTLS/Xray-core/releases/download/${tag}/Xray-windows-64.zip`,
    )
    return { tag, url }
  }
  const latest = await fetchJson('https://api.github.com/repos/XTLS/Xray-core/releases/latest')
  const picked = pickWindowsZipUrl(latest)
  return { ...picked, url: mirrorGithubUrl(picked.url) }
}

function extractXrayExe(zipBuffer) {
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  for (const e of entries) {
    if (e.isDirectory) continue
    const name = e.entryName.replace(/\\/g, '/')
    if (name.endsWith('xray.exe') || name.split('/').pop()?.toLowerCase() === 'xray.exe') {
      return e.getData()
    }
  }
  throw new Error('ZIP 内未找到 xray.exe')
}

async function main() {
  if (existsSync(OUT_EXE) && process.env.FORCE_XRAY_FETCH !== '1') {
    console.info('[fetch-xray] 已存在，跳过:', OUT_EXE)
    return
  }

  const proxyLog = getProxyUrl()
  console.info('[fetch-xray] 下载 Xray Windows amd64 …', proxyLog ? `（经代理 ${proxyLog}）` : '（直连）')
  const { tag, url } = await resolveDownloadUrl()
  console.info('[fetch-xray] 使用版本:', tag)
  console.info('[fetch-xray] URL:', url)

  const zipBuf = await httpGetBuffer(url)
  const exeBuf = extractXrayExe(zipBuf)

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_EXE, exeBuf)
  console.info('[fetch-xray] 已写入:', OUT_EXE, `(${(exeBuf.length / 1024 / 1024).toFixed(2)} MiB)`)
}

main().catch((e) => {
  console.error('[fetch-xray] 失败:', e instanceof Error ? e.message : e)
  process.exit(1)
})
