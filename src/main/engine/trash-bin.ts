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
    execFile(exe, [filePath], (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * 用 PowerShell 的 VisualBasic FileSystem 移入回收站（兜底）。
 * exe 方案在部分环境（无窗口站、COM 受限、exe 缺失）会失败，这里走系统标准接口兜底，
 * 保证「移入回收站」不会因为单一实现失效而整体不可用（代价是每次要启动 PowerShell）。
 */
async function recycleViaPowerShell(filePath: string): Promise<void> {
  const script = `
$p = ${psQuote(filePath)}
if (-not (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue)) { exit 0 }
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')
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
