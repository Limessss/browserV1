/**
 * 实例代理与系统代理隔离：清理子进程环境变量、解析物理网卡。
 */
import { networkInterfaces } from 'node:os'

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

const VIRTUAL_IFACE_PATTERN =
  /clash|wintun|meta|tun|vpn|virtual|hyper-v|vether|npcap|loopback|tap-/i

/**  spawn Chrome / 桥接进程时使用，避免继承 Clash 等系统代理环境变量 */
export function envWithoutSystemProxy(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of PROXY_ENV_KEYS) {
    delete env[key]
  }
  env.NO_PROXY = '*'
  return env
}

/** 尽量选取真实物理网卡名，供 xray/sing-box 出站 bind，降低 TUN 劫持概率 */
export function resolvePhysicalNetworkInterface(): string {
  const ifaces = networkInterfaces()
  const candidates: Array<{ name: string; score: number }> = []

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs?.length || VIRTUAL_IFACE_PATTERN.test(name)) {
      continue
    }
    const ipv4 = addrs.filter((a) => a.family === 'IPv4' && !a.internal)
    if (ipv4.length === 0) {
      continue
    }
    let score = 0
    const low = name.toLowerCase()
    if (/^(以太网|ethernet|wlan|wi-fi|wifi)/i.test(name)) {
      score += 10
    }
    if (low.includes('ethernet') || low.includes('wlan')) {
      score += 5
    }
    if (low.includes('bluetooth')) {
      score -= 5
    }
    candidates.push({ name, score })
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.name ?? ''
}
