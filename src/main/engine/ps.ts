import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'
import { StringDecoder } from 'string_decoder'

const execFileAsync = promisify(execFile)

/**
 * 解析 PowerShell 可执行文件的绝对路径。
 * 裸写 'powershell' 依赖 PATH+PATHEXT 解析；在部分用户机器上（PATH 被清理/截断、
 * 32/64 位重定向、杀软改动环境）会令 CreateProcess 失败并抛 'spawn UNKNOWN'。
 * 这里直接给出绝对路径，规避命令名解析失败这一支。
 *
 * 候选顺序：
 *  1) System32 —— 普通情况（32 位进程访问时被重定向到 SysWOW64，那里同样有 powershell.exe）
 *  2) Sysnative —— 32 位进程访问原生 64 位系统目录（极端环境兜底）
 *  3) SysWOW64 —— 再兜底
 * 全部缺失才回退裸名 'powershell'（保持原有行为，便于后续定位而非彻底失灵）。
 */
let _psPath: string | null = null
function getPsPath(): { path: string; resolved: boolean } {
  if (_psPath !== null) {
    return { path: _psPath, resolved: _psPath !== 'powershell' }
  }
  const windir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    `${windir}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    `${windir}\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe`,
    `${windir}\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe`,
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        _psPath = c
        return { path: c, resolved: true }
      }
    } catch {
      /* 忽略，继续下一个候选 */
    }
  }
  _psPath = 'powershell'
  return { path: _psPath, resolved: false }
}

/** 确定的工作目录，避免「继承的 cwd 不存在 → CreateProcess 失败 → spawn UNKNOWN」。 */
const SAFE_CWD = process.env.SystemRoot || 'C:\\Windows'

/** 强制 PowerShell 以 UTF-8 输出，避免中文 Windows 下乱码（控制台默认 GBK）。 */
const PS_UTF8 =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;"

/**
 * 异步执行 PowerShell 脚本并返回 stdout。
 * 用 execFile（非 Sync）避免阻塞主进程事件循环，保障扫描期间 UI 不卡顿。
 */
export async function runPs(script: string): Promise<string> {
  const { path: psPath, resolved } = getPsPath()
  try {
    const { stdout } = await execFileAsync(
      psPath,
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
        cwd: SAFE_CWD,
      },
    )
    // 去 BOM 后按 UTF-8 解码
    return Buffer.from(stdout).toString('utf8').replace(/^\uFEFF/, '')
  } catch (e) {
    // ⚠️ execFile 默认只抛「Command failed: powershell …」这种无用信息，
    // 真正的失败原因在 stderr（如 robocopy 退出码说明、mklink 报错）。
    // 把 stdout+stderr 末尾几行拼进错误信息，让调用方能看到真实原因。
    const err = e as NodeJS.ErrnoException & {
      stdout?: Buffer | string
      stderr?: Buffer | string
    }
    const out = err.stdout
      ? Buffer.from(err.stdout as Buffer).toString('utf8')
      : ''
    const errout = err.stderr
      ? Buffer.from(err.stderr as Buffer).toString('utf8')
      : ''
    const detail = (out + '\n' + errout).replace(/^\uFEFF/, '').trim()
    if (detail) {
      const tail = detail
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(-4)
        .join('  ')
      throw new Error(tail)
    }
    // 进程未能启动（CreateProcess 失败，典型为 'spawn UNKNOWN'）：
    // 补充 powershell 路径与 errno，便于区分「路径解析失败」还是「被杀软拦截」。
    const code = (err as NodeJS.ErrnoException).code || 'UNKNOWN'
    throw new Error(`[runPs] ${err.message} (path=${psPath}, resolved=${resolved}, errno=${code})`)
  }
}

/**
 * 流式执行 PowerShell：脚本每输出一行就回调一次 onLine，**不等待进程结束**。
 * 用于「边扫边出」的扫描（软件卸载列表等），避免等全部枚举完才一次性返回。
 *
 * ⚠️ 实测要点（本机）：① PowerShell 启动本身约 4 秒，属固定成本，因此
 * **绝不可拆成多次调用**（3 次 ≈ 12 秒）；只能一次调用 + 流式输出。
 * ② 重定向到管道时 stdout 会被缓冲，脚本里每条输出后必须显式
 * `[Console]::Out.Flush()`，否则首行要晚 1~2 秒才到（实测 5786ms → 4075ms）。
 */
export function runPsStream(
  script: string,
  onLine: (line: string) => void | boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { path: psPath, resolved } = getPsPath()
    const child = spawn(
      psPath,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        PS_UTF8 + script,
      ],
      { windowsHide: true, cwd: SAFE_CWD },
    )
    const decoder = new StringDecoder('utf8')
    let buf = ''
    let settled = false
    let stopped = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      // 收尾：剩余不满一行的内容也回调（脚本最后一行可能没有换行）
      const tail = (buf + decoder.end()).trim()
      if (tail && !stopped) onLine(tail)
      if (err) reject(err)
      else resolve()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      buf += decoder.write(chunk)
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').trim()
        buf = buf.slice(i + 1)
        // 回调返回 false 表示「不再需要后续结果」：立即终止 PowerShell，避免白跑
        if (line && onLine(line) === false) {
          stopped = true
          child.kill()
          finish()
          return
        }
      }
    })
    child.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code || 'UNKNOWN'
      finish(new Error(`[runPsStream] ${e.message} (path=${psPath}, resolved=${resolved}, errno=${code})`))
    })
    child.on('close', () => finish())
  })
}

/** PowerShell 单引号字符串转义（内部单引号写两遍）。 */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * 解析「每行一个 JSON」的输出（NDJSON），逐行容错：非 JSON 行（如警告）直接跳过。
 * 也兼容一次性返回的 JSON 数组文本。
 */
export function parseJsonLines(text: string): any[] {
  const t = (text ?? '').trim()
  if (!t) return []
  const out: any[] = []
  for (const rawLine of t.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line) continue
    try {
      const p = JSON.parse(line)
      if (Array.isArray(p)) out.push(...p)
      else if (p) out.push(p)
    } catch {
      /* 非 JSON 行，跳过 */
    }
  }
  return out
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
