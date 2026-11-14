import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runPs, psQuote } from './ps'

/**
 * 把文件移入回收站（仅 Windows）。
 *
 * 为什么不用 `trash` 包直接调用：
 * `trash@9` 在内部用 `new URL('windows-trash.exe', import.meta.url)` 定位原生 exe，
 * 再 `fileURLToPath()` 交给 execFile。打包进 app.asar 后，Electron 的 ESM
 * `import.meta.url` 仍指向 `app.asar` 内部路径（asarUnpack 不会改写 import.meta.url
 * 为 unpacked 路径），`fileURLToPath` 于是得到一个带 asar 的 `file://` URL，
 * execFile 把它当成「带 host 的 URL」而抛
 * `TypeError: invalid host defined options`。
 *
 * 这里改为自行定位真实 exe：打包后优先 `resources/app.asar.unpacked/...`（asarUnpack
 * 已把 trash 整包解到此处），dev 下回退到项目根 `node_modules/...`，再用 execFile
 * 直接执行，彻底绕开坏 URL 解析。
 */

/** 定位 trash 包自带的 windows-trash.exe；找不到返回 null。 */
function findWindowsTrashExe(): string | null {
  const candidates: string[] = []

  // 1) 打包后：asarUnpack 把 trash 解到 app.asar.unpacked（真实 OS 路径）
  const resources = process.resourcesPath
  if (resources) {
    candidates.push(
      path.join(
        resources,
        'app.asar.unpacked',
        'node_modules',
        'trash',
        'lib',
        'windows-trash.exe',
      ),
    )
  }

  // 2) dev / 兜底：从本模块或 cwd 反推项目根 node_modules
  //    编译后位于 out/main/engine/，上溯三级即项目根
  candidates.push(
    path.join(__dirname, '..', '..', '..', 'node_modules', 'trash', 'lib', 'windows-trash.exe'),
  )
  candidates.push(
    path.join(process.cwd(), 'node_modules', 'trash', 'lib', 'windows-trash.exe'),
  )

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* 忽略，继续尝试下一个候选 */
    }
  }
  return null
}

let _exe: string | null | undefined

function exePath(): string {
  if (_exe === undefined) _exe = findWindowsTrashExe()
  if (!_exe) throw new Error('未找到 windows-trash.exe，回收站功能不可用')
  return _exe
}

/** 用 windows-trash.exe 移入回收站（快，首选）。 */
async function recycleViaExe(filePath: string): Promise<void> {
  const exe = exePath()
  await new Promise<void>((resolve, reject) => {
    // timeout：dev 未签名 exe 常被杀软拦截/挂起，无 timeout 时会一直等到失败（可达数十秒）；
    // 超时即视为不可用，转 PowerShell。windowsHide 避免意外弹黑窗。
    execFile(
      exe,
      [filePath],
      { timeout: 15000, windowsHide: true, killSignal: 'SIGKILL' },
      (err) => (err ? reject(err) : resolve()),
    )
  })
}

/**
 * 用 PowerShell 的 VisualBasic FileSystem 移入回收站（兜底）。
 * exe 方案在部分环境（无窗口站、COM 受限、exe 缺失）会失败，这里走系统标准接口兜底，
 * 保证「移入回收站」不会因为单一实现失效而整体不可用（代价是每次要启动 PowerShell）。
 */
async function recycleViaPowerShell(filePath: string): Promise<void> {
  // ⚠️ 目录必须走 DeleteDirectory：DeleteFile 对目录无效（整目录清理的兜底路径曾因此静默失败）
  const script = `
$p = ${psQuote(filePath)}
if (-not (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue)) { exit 0 }
Add-Type -AssemblyName Microsoft.VisualBasic
if ((Get-Item -LiteralPath $p -Force) -is [System.IO.DirectoryInfo]) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')
}
if (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue) { throw '仍在原位置，未移入回收站' }
`.trim()
  await runPs(script)
}

/**
 * exe 连续失败次数；达到阈值后整体切到 PowerShell，避免清理几百个文件时
 * 每条都要先白等一次 exe 失败（exe 系统性失效时这是纯浪费）。
 * 只是偶发失败（如某文件被占用）不会触发切换。
 */
let exeFailCount = 0
let exeUnavailable = false
const EXE_FAIL_LIMIT = 2

/**
 * 将单个文件移入回收站（默认删除方式，purge=false 时调用）。
 * 优先 exe（快），失败则回退 PowerShell（稳），两者都失败才抛错。
 */
export async function moveToRecycleBin(filePath: string): Promise<void> {
  if (!exeUnavailable) {
    try {
      await recycleViaExe(filePath)
      exeFailCount = 0
      return
    } catch (e) {
      exeFailCount += 1
      if (exeFailCount >= EXE_FAIL_LIMIT) exeUnavailable = true
      console.warn(
        '[trash-bin] windows-trash.exe failed, fallback to PowerShell:',
        e instanceof Error ? e.message : String(e),
      )
    }
  }
  await recycleViaPowerShell(filePath)
}

/** 把数组按固定大小分块（避免一次命令行超长，且贴合 windows-trash.exe 的批量上限）。 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * 用 windows-trash.exe 一次性把多个文件移入回收站（批量，首选）。
 * 一次进程处理一整批路径，把「删 N 个文件」的外部进程数从 N 降到 ⌈N/200⌉，
 * 这是垃圾清理缓慢的根因（原来逐条 delete = 串行 N 次进程创建/销毁）的最优解法。
 */
async function recycleManyViaExe(filePaths: string[]): Promise<void> {
  const exe = exePath()
  await new Promise<void>((resolve, reject) => {
    // 批量路径同样加 timeout（与单条一致），避免 exe 挂起时整批长时间等待
    execFile(
      exe,
      filePaths,
      { timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' },
      (err) => (err ? reject(err) : resolve()),
    )
  })
}

export interface BatchRecycleFailure {
  path: string
  error?: string
}

export interface BatchRecycleResult {
  /** 最终成功移入回收站的路径（含批量成功 / 降级重试成功） */
  succeeded: string[]
  /** 最终失败（原位置仍存在且重试也失败）的路径与原因 */
  failed: BatchRecycleFailure[]
}

/**
 * 单批文件数。200 是实测的平衡点：批太小则进程启动开销占比高，批太大则命令行
 * 逼近 Windows 32767 字符上限（长路径下 500 个已到 3 万字符）。
 */
const RECYCLE_BATCH = 200

/**
 * 同时回收的批数。⚠️ **实测 800 个文件（4 批 × 200）**：
 * 串行 63.1s（78.9ms/文件）→ 并发 2 为 18.5s → **并发 4 为 11.6s（快 5.4 倍）**
 * → 并发 8 为 10.3s（再翻倍几乎无收益）。
 *
 * 串行慢的原因不只是磁盘 IO：windows-trash.exe 每次启动都要初始化 COM 并逐文件
 * 走 SHFileOperation，串行时这些固定成本无法摊薄，且单进程内是顺序执行。
 */
const RECYCLE_CONC = 6

/** 并发跑批：返回失败（需要降级逐个重试）的批次。 */
async function runBatches(
  batches: string[][],
  onBatch?: (paths: string[]) => void,
  succeeded?: string[],
): Promise<string[][]> {
  const failed: string[][] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= batches.length) return
      const chunk = batches[i]
      try {
        await recycleManyViaExe(chunk)
        // 退出码 0 = 整批成功：逐块回报进度，让「已删除 N 条」随动
        onBatch?.(chunk)
        if (succeeded) for (const p of chunk) succeeded.push(p)
      } catch {
        // 单批失败不影响其它批：先记下，全部跑完再统一降级重试
        failed.push(chunk)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(RECYCLE_CONC, batches.length) }, () => worker()),
  )
  return failed
}

/**
 * 批量把多个文件移入回收站。
 *
 * 主路径：windows-trash.exe 支持多参数，按 200 一批、**多批并发 6**，绝大多数场景
 * 一次进程搞定（exit 0 即全部成功），进程数从 N 降到 ⌈N/200⌉ 且并行执行。
 *
 * 降级：某批 exe 失败时（偶发占用 / exe 系统性失效），用 `existsSync` 区分哪些已
 * 被批量调用悄悄移走（算成功），仅对仍留在原位置的逐个走 `moveToRecycleBin`
 * （exe 单条 + PowerShell 兜底）。这样既不丢进度/审计，又避免对「已成功」文件
 * 重复删除而误报失败。
 */
export async function moveManyToRecycleBin(
  filePaths: string[],
  onBatch?: (paths: string[]) => void,
): Promise<BatchRecycleResult> {
  const succeeded: string[] = []
  const failed: BatchRecycleFailure[] = []
  if (!filePaths.length) return { succeeded, failed }

  // 主路径：批量 exe + 多批并发
  if (!exeUnavailable) {
    const batches = chunkArray(filePaths, RECYCLE_BATCH)
    const bad = await runBatches(batches, onBatch, succeeded)
    if (bad.length) {
      // 批量整批失败通常是 exe 不可用（被杀软拦截/挂起），直接判定不可用并整批走 PowerShell，
      // 避免再走「降级逐条 moveToRecycleBin」——那会每条再试一次 exe（无 timeout 时逐条挂起，
      // N 条累计可达分钟级，正是「极少文件却删除极慢」的根因，见 2026-11-14 修复）。
      exeUnavailable = true
      exeFailCount = EXE_FAIL_LIMIT
      console.warn(
        '[trash-bin] batch recycle failed (' +
          bad.length +
          '/' +
          batches.length +
          '), mark exe unavailable, fallback all to PowerShell',
      )
      for (const p of await fallbackPerItem(bad.flat(), onBatch, succeeded)) failed.push(p)
    }
    return { succeeded, failed }
  }

  for (const p of await fallbackPerItem(filePaths, onBatch, succeeded)) failed.push(p)
  return { succeeded, failed }
}

/**
 * 降级：逐条确认。已不在原位置的算成功；仍在的用单条 `moveToRecycleBin` 重试
 * （exe 单条 + PowerShell 兜底）。返回最终失败项。
 */
async function fallbackPerItem(
  paths: string[],
  onBatch?: (paths: string[]) => void,
  succeeded?: string[],
): Promise<BatchRecycleFailure[]> {
  const failed: BatchRecycleFailure[] = []
  for (const p of paths) {
    let exists = false
    try {
      exists = fs.existsSync(p)
    } catch {
      exists = false
    }
    if (!exists) {
      succeeded?.push(p)
      onBatch?.([p])
      continue
    }
    try {
      // exe 已判定不可用时直接走 PowerShell（不白等每条 exe 超时，避免 N 条累计分钟级）；
      // 否则保留「单条 exe 优先」以救回批量偶发失败（如个别文件被占用）的其余文件
      if (exeUnavailable) await recycleViaPowerShell(p)
      else await moveToRecycleBin(p)
      succeeded?.push(p)
      onBatch?.([p])
    } catch (err) {
      failed.push({
        path: p,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return failed
}

/**
 * 预热 windows-trash.exe：用一个不存在的路径空跑一次，触发防病毒/系统对二进制
 * 的首次扫描与文件缓存，把「冷启动耗时」（dev 下未签名 exe 常被实时扫描，单次可
 * 达十余秒）挪到应用开屏阶段，使真正删除时不再卡在进程启动上。
 * 非阻塞、忽略结果（空跑必然「文件不存在」，属预期）。
 */
export function warmTrashExe(): void {
  try {
    const exe = exePath()
    execFile(
      exe,
      ['C:\\__grclean_warmup_dummy__.tmp'],
      { timeout: 15000, windowsHide: true, killSignal: 'SIGKILL' },
      () => {
        /* 忽略：空跑必失败，仅用于预热 */
      },
    )
  } catch {
    /* exe 缺失则跳过，不影响后续回收站逻辑 */
  }
}
