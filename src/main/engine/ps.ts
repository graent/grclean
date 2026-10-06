import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** 强制 PowerShell 以 UTF-8 输出，避免中文 Windows 下乱码（控制台默认 GBK）。 */
const PS_UTF8 =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;"

/**
 * 异步执行 PowerShell 脚本并返回 stdout。
 * 用 execFile（非 Sync）避免阻塞主进程事件循环，保障扫描期间 UI 不卡顿。
 */
export async function runPs(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      PS_UTF8 + script,
    ],
    {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120000,
    },
  )
  // 去 BOM 后按 UTF-8 解码
  return Buffer.from(stdout).toString('utf8').replace(/^\uFEFF/, '')
}

/** PowerShell 单引号字符串转义（内部单引号写两遍）。 */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** 解析 PowerShell 输出的 JSON，容错处理空 / 单元素情况。 */
export function parseJsonArray(json: string): any[] {
  const t = json.trim()
  if (!t) return []
  try {
    const p = JSON.parse(t)
    return Array.isArray(p) ? p : p ? [p] : []
  } catch {
    return []
  }
}
