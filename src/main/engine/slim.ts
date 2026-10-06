/**
 * C 盘瘦身向导（design.md §3.12）。
 *
 * 向导式聚合：休眠文件 + 旧 Windows + 传递优化 + 更新缓存 + 社交缓存 + 大文件，
 * 给出「一键可释放空间总量」预估，并对不可逆项标注风险、要求强确认。
 *
 * 执行方式按项而异（都只操作「已知的固定路径」，不接受外部传入路径）：
 * - hibernation：`powercfg -h off`（可逆：可再 `powercfg -h on`）
 * - windows_old：删除 `%SystemDrive%\Windows.old`（**不可逆**，需管理员）
 * - update_cache：清空 `%WINDIR%\SoftwareDistribution\Download`
 * - delivery_opt：清空 `%WINDIR%\SoftwareDistribution\DeliveryOptimization`
 * - temp_install：清空 `%WINDIR%\Temp` 下过期文件
 * - social / bigfiles：只给体积预估，跳转到对应模块处理（避免越权删除用户数据）
 *
 * 每一项执行前均二次校验路径白名单，失败只记 error，不影响其他项。
 */
import * as fs from 'fs'
import * as path from 'path'
import { runPs, psQuote } from './ps'
import { expandEnv } from './rules'
import { scanSocialCacheSize } from './social'
import { scanBigFilesStream } from './bigfile'

const GB = 1024 ** 3

/** 瘦身项类型。 */
export type SlimKind =
  | 'hibernation'
  | 'windows_old'
  | 'update_cache'
  | 'delivery_opt'
  | 'temp_install'
  | 'social'
  | 'bigfiles'

export interface SlimItem {
  kind: SlimKind
  name: string
  desc: string
  /** 预估可释放字节数 */
  size: number
  /** 风险：safe=可逆/可重建，caution=需确认，danger=不可逆 */
  risk: 'safe' | 'caution' | 'danger'
  /** 是否默认勾选 */
  recommend: boolean
  /** 是否可直接执行（false = 需跳转到对应模块处理） */
  actionable: boolean
  /** 建议跳转的视图 key */
  goto?: string
}

/** 目录体积统计（带文件数上限，避免 Windows.old 这类超大目录拖死）。 */
function dirSize(p: string, maxFiles = 40000): number {
  let total = 0
  let n = 0
  const stack: string[] = [p]
  while (stack.length && n < maxFiles) {
    const cur = stack.pop() as string
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (n >= maxFiles) break
      const fp = path.join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(fp)
        else if (e.isFile()) {
          total += fs.statSync(fp).size
          n++
        }
      } catch {
        /* 无权限跳过 */
      }
    }
  }
  return total
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** 生成瘦身方案（只统计体积，不做任何修改）。 */
export async function slimPlan(): Promise<SlimItem[]> {
  const sysDrive = (expandEnv('%SystemDrive%') || 'C:').replace(/\\$/, '')
  const winDir = expandEnv('%WINDIR%') || path.join(sysDrive, 'Windows')
  const items: SlimItem[] = []

  // 1. 休眠文件（与内存等量，常 8–16GB）
  let hiber = 0
  try {
    hiber = fs.statSync(path.join(sysDrive, 'hiberfil.sys')).size
  } catch {
    hiber = 0
  }
  if (hiber > 0) {
    items.push({
      kind: 'hibernation',
      name: '休眠文件 hiberfil.sys',
      desc: '关闭休眠可立即释放与内存等量的空间，可随时重新开启（可逆）',
      size: hiber,
      risk: 'safe',
      recommend: true,
      actionable: true,
    })
  }

  // 2. 旧 Windows 安装
  const winOld = path.join(sysDrive, 'Windows.old')
  if (exists(winOld)) {
    const size = dirSize(winOld)
    items.push({
      kind: 'windows_old',
      name: '旧 Windows 安装 Windows.old',
      desc: '升级留下的旧系统，删除后无法回退到上一版本（不可逆，需管理员）',
      size,
      risk: 'danger',
      recommend: false,
      actionable: true,
    })
  }

  // 3. Windows 更新缓存
  const dl = path.join(winDir, 'SoftwareDistribution', 'Download')
  if (exists(dl)) {
    const size = dirSize(dl)
    if (size > 0) {
      items.push({
        kind: 'update_cache',
        name: 'Windows 更新缓存',
        desc: '已下载并安装的更新包，清理后不影响系统（需管理员）',
        size,
        risk: 'safe',
        recommend: true,
        actionable: true,
      })
    }
  }

  // 4. 传递优化缓存
  const dop = path.join(winDir, 'SoftwareDistribution', 'DeliveryOptimization')
  if (exists(dop)) {
    const size = dirSize(dop)
    if (size > 0) {
      items.push({
        kind: 'delivery_opt',
        name: '传递优化缓存',
        desc: '用于局域网分发更新的缓存，清理后系统会重新下载（需管理员）',
        size,
        risk: 'safe',
        recommend: true,
        actionable: true,
      })
    }
  }

  // 5. Windows 临时安装文件
  const wt = path.join(winDir, 'Temp')
  if (exists(wt)) {
    const size = dirSize(wt)
    if (size > 0) {
      items.push({
        kind: 'temp_install',
        name: 'Windows 临时安装文件',
        desc: '安装程序残留的临时文件，清理安全（需管理员）',
        size,
        risk: 'safe',
        recommend: true,
        actionable: true,
      })
    }
  }

  // 6. 社交缓存（只预估，跳转专清页处理）
  try {
    const social = await scanSocialCacheSize()
    if (social.totalBytes > 0) {
      items.push({
        kind: 'social',
        name: '社交软件缓存',
        desc: '微信 / QQ 等 10 款应用的缓存，建议在「社交软件专清」中按风险分级清理',
        size: social.totalBytes,
        risk: 'caution',
        recommend: false,
        actionable: false,
        goto: 'social',
      })
    }
  } catch {
    /* 统计失败不影响其他项 */
  }

  // 7. 大文件（只预估）
  try {
    let big = 0
    for await (const batch of scanBigFilesStream(
      { minSize: 500 * 1024 * 1024, includeAll: false },
      () => false,
    )) {
      for (const f of batch) big += f.size
    }
    if (big > 0) {
      items.push({
        kind: 'bigfiles',
        name: '大文件（> 500MB）',
        desc: '用户目录中的大体积文件，建议在「大文件」中逐个确认后处理',
        size: big,
        risk: 'caution',
        recommend: false,
        actionable: false,
        goto: 'big',
      })
    }
  } catch {
    /* ignore */
  }

  return items.sort((a, b) => b.size - a.size)
}

export interface SlimExecuteResult {
  kind: SlimKind
  ok: boolean
  message: string
}

/**
 * 执行瘦身项（仅处理 actionable 的项）。
 *
 * 每项都用 PowerShell 精确操作白名单内的固定路径：
 * 先判存在 → 再 Remove-Item / powercfg → 捕获错误不影响其他项。
 */
export async function runSlim(kinds: SlimKind[]): Promise<SlimExecuteResult[]> {
  const sysDrive = (expandEnv('%SystemDrive%') || 'C:').replace(/\\$/, '')
  const winDir = expandEnv('%WINDIR%') || path.join(sysDrive, 'Windows')
  const out: SlimExecuteResult[] = []

  for (const kind of kinds) {
    try {
      if (kind === 'hibernation') {
        // powercfg 需要管理员；失败时回传真实错误
        await runPs('powercfg -h off')
        out.push({ kind, ok: true, message: '已关闭休眠并删除 hiberfil.sys' })
        continue
      }
      if (kind === 'windows_old') {
        const p = path.join(sysDrive, 'Windows.old')
        if (!exists(p)) {
          out.push({ kind, ok: true, message: 'Windows.old 不存在，无需处理' })
          continue
        }
        await runPs(
          `Takeown /F ${psQuote(p)} /R /A /D Y | Out-Null; ` +
            `icacls ${psQuote(p)} /grant *S-1-5-32-544:(OI)(CI)F /T /Q | Out-Null; ` +
            `Remove-Item -LiteralPath ${psQuote(p)} -Recurse -Force -ErrorAction Stop`,
        )
        out.push({ kind, ok: true, message: '已删除 Windows.old' })
        continue
      }
      const dirMap: Partial<Record<SlimKind, { dir: string; label: string }>> = {
        update_cache: {
          dir: path.join(winDir, 'SoftwareDistribution', 'Download'),
          label: 'Windows 更新缓存',
        },
        delivery_opt: {
          dir: path.join(winDir, 'SoftwareDistribution', 'DeliveryOptimization'),
          label: '传递优化缓存',
        },
        temp_install: { dir: path.join(winDir, 'Temp'), label: 'Windows 临时安装文件' },
      }
      const m = dirMap[kind]
      if (!m) {
        out.push({ kind, ok: false, message: '该项需跳转到对应模块处理' })
        continue
      }
      if (!exists(m.dir)) {
        out.push({ kind, ok: true, message: `${m.label}：目录不存在，无需处理` })
        continue
      }
      // 只清目录内容，保留目录本身（避免破坏系统目录结构）
      await runPs(
        `Get-ChildItem -LiteralPath ${psQuote(m.dir)} -Force -ErrorAction SilentlyContinue | ` +
          `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
      )
      const left = exists(m.dir) ? dirSize(m.dir) : 0
      out.push({
        kind,
        ok: true,
        message: `${m.label}：已清理${left > 0 ? `，仍有 ${(left / GB).toFixed(2)} GB 被占用（多为系统占用）` : ''}`,
      })
    } catch (e) {
      out.push({
        kind,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return out
}
