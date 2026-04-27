/**
 * Launch HTTP 固定端口的 CDP 统一入口：指向当前最近一次成功拉起且就绪的浏览器调试端口。
 */

let activeDebugPort = 0
let activeProfileId = ''
let activeProfileName = ''

export function setLaunchServerActiveProfile(profile: Record<string, unknown> | null | undefined): void {
  if (!profile) {
    return
  }
  const port = Number(profile.debugPort ?? 0)
  const ready = Boolean(profile.debugReady)
  if (!ready || port <= 0) {
    return
  }
  activeDebugPort = port
  activeProfileId = String(profile.profileId ?? '').trim()
  activeProfileName = String(profile.profileName ?? '').trim()
}

export function clearLaunchServerActiveProfile(profileId: string): void {
  const id = profileId.trim()
  if (!id || activeProfileId !== id) {
    return
  }
  activeDebugPort = 0
  activeProfileId = ''
  activeProfileName = ''
}

export function getLaunchServerActiveTarget(): {
  debugPort: number
  profileId: string
  profileName: string
} {
  return {
    debugPort: activeDebugPort,
    profileId: activeProfileId,
    profileName: activeProfileName,
  }
}
