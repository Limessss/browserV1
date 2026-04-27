import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

async function runPowershell(script: string, appRoot: string): Promise<void> {
  const powershellPath = existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    : 'powershell.exe'
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      powershellPath,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script, '-Root', appRoot],
      { windowsHide: true, timeout: 8_000 },
      (err, _stdout, stderr) => {
        if (err) {
          const msg = String(stderr ?? '').trim() || err.message
          rejectPromise(new Error(msg))
          return
        }
        resolvePromise()
      },
    )
  })
}

/**
 * 对齐 Go residual_processes_windows：退出前清理应用根目录下残留 runtime 进程。
 */
export async function killResidualRuntimeProcesses(appRoot: string): Promise<void> {
  const root = resolve(String(appRoot ?? '').trim() || process.cwd())
  if (process.platform !== 'win32') {
    return
  }
  const script = `
param([string]$Root)
$ErrorActionPreference = 'SilentlyContinue'
if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root)) { exit 0 }
$root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\\') + '\\'
$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and (
    $_.ExecutablePath.StartsWith(($root + 'bin\\'), [System.StringComparison]::OrdinalIgnoreCase) -or
    $_.ExecutablePath.StartsWith(($root + 'chrome\\'), [System.StringComparison]::OrdinalIgnoreCase)
  )
}
foreach ($p in $targets) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
}
exit 0
`
  await runPowershell(script, root)
}

