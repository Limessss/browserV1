import { existsSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'

function checkFile(path) {
  const ok = existsSync(path)
  return { ok, path }
}

async function checkHealth(url) {
  return await new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        resolve({
          ok: res.statusCode === 200,
          status: res.statusCode ?? 0,
          body: body.trim(),
        })
      })
    })
    req.setTimeout(3000, () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, body: String(err?.message ?? err) })
    })
  })
}

async function main() {
  const root = process.cwd()
  const xray = checkFile(join(root, 'bin', 'xray.exe'))
  const singbox = checkFile(join(root, 'bin', 'sing-box.exe'))
  const health = await checkHealth('http://127.0.0.1:19876/api/health')

  console.log('[smoke] runtime binaries')
  console.log(`- xray: ${xray.ok ? 'OK' : 'MISSING'} (${xray.path})`)
  console.log(`- sing-box: ${singbox.ok ? 'OK' : 'MISSING'} (${singbox.path})`)
  console.log('[smoke] launch server')
  console.log(`- /api/health: ${health.ok ? 'OK' : 'FAIL'} status=${health.status} body=${health.body}`)

  if (!xray.ok || !singbox.ok) {
    process.exit(1)
  }
}

await main()

