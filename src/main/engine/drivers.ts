/**
 * 驱动清理（design.md §3.14）。
 *
 * 清理「已安装但设备不再存在」的旧驱动包（`DriverStore\FileRepository` 中的孤立 inf）。
 * **仅删确认无设备使用的旧版本，当前在用驱动绝不碰。**
 *
 * 字段与判定逻辑参考 lightC 的旧驱动清理：
 * - 每个驱动包展示：原始 INF 名(originalName)、发布名(published)、厂商(providerName)、
 *   版本(driverVersion)、驱动类(className)、状态(status)、判定理由(reason)，
 *   以及设备统计 deviceCount / activeDeviceCount / installedDeviceCount /
 *   outrankedDeviceCount / fileCount。
 * - 状态 status 取值：in_use（使用中）/ old_confirmed（旧版待清理，高置信）/
 *   recommended（推荐清理）/ no_newer_version（无更新版本，需谨慎）/ unknown（信息不足）。
 * - 仅 old_confirmed 与 recommended 视为可安全清理（actionable），可勾选删除。
 *
 * 判定「在用」的两条依据（缺一即视为可清理候选，取更保守者）：
 * 1. `Win32_PnPSignedDriver.InfName` —— 所有已绑定设备的驱动 inf 名集合；
 * 2. `Get-WindowsDriver -Online` —— 驱动包的 Published Name（oemNN.inf）与
 *    原始文件名，用于把目录映射回 `pnputil` 可删除的发布名。
 *
 * 删除走 `pnputil /delete-driver <oemNN.inf> /force`，需要管理员权限；
 * 无法解析出发布名的目录**不提供删除**，只展示体积（避免误删）。
 *
 * 任何采集失败（无管理员 / DISM 不可用）都降级为「未知 / 视为在用」，一律不列为可清理项。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { runPs, parseJsonArray } from './ps'

/** 驱动存储库目录。 */
function repoDir(): string {
  // 直接读 Windows 进程环境变量，避免 expandEnv 在打包环境下未展开 %WINDIR% 导致路径错误
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  return path.join(windir, 'System32', 'DriverStore', 'FileRepository')
}

export type DriverStatus =
  | 'in_use'
  | 'old_confirmed'
  | 'recommended'
  | 'no_newer_version'
  | 'unknown'

export interface DriverItem {
  id: string
  /** 目录名，如 `nv_disp.inf_amd64_xxxx` */
  name: string
  path: string
  size: number
  /** 目录内的 inf 文件名列表 */
  infs: string[]
  /** 是否有设备正在使用 */
  inUse: boolean
  /** pnputil 发布名（oemNN.inf）；为空表示无法安全删除 */
  published: string | null
  /** 驱动类名（来自 DISM，可能为空） */
  className: string
  /** 是否为候选（可安全清理） */
  candidate: boolean
  /** 原始 INF 文件名（如 nv_disp.inf），作为主要标题 */
  originalName?: string | null
  /** 厂商（ProviderName） */
  providerName?: string | null
  /** 版本（DriverVersion） */
  driverVersion?: string | null
  /** 关联设备总数 */
  deviceCount?: number
  /** 活动设备数（Status=OK） */
  activeDeviceCount?: number
  /** 已安装/当前设备数（Present=1） */
  installedDeviceCount?: number
  /** 被更新版本取代的设备数 */
  outrankedDeviceCount?: number
  /** 驱动包内文件数 */
  fileCount?: number
  /** 安全分类状态 */
  status?: DriverStatus
  /** 判定理由（中文） */
  reason?: string
  /** 是否可安全清理（可勾选删除） */
  actionable?: boolean
  /** 是否系统自带驱动（Microsoft 等），不可删除 */
  isSystem?: boolean
}

function hashId(p: string): string {
  return 'drv:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

function dirStat(p: string, maxFiles = 20000): { bytes: number; files: number } {
  let total = 0
  let n = 0
  let files = 0
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
          files++
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { bytes: total, files }
}

/** 版本号比较：返回 >0 表示 a 更新，<0 表示 b 更新，0 表示相等/不可比。 */
function cmpVer(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x - y
  }
  return 0
}

/** 最近一次采集的诊断信息（供前端提示采集是否可靠）。 */
let lastDriverDiag = ''

interface InfMeta {
  published: string
  original: string
  provider: string
  version: string
  className: string
}

/** 采集「在用驱动 inf 信息」与「驱动包发布名/元数据映射」。 */
async function collectDriverState(): Promise<{
  usedInfs: Set<string>
  /** 原始 inf 基名（小写）→ 元数据（发布名/原始名/厂商/版本/类） */
  meta: Map<string, InfMeta>
  /** 原始 inf 基名（小写）→ 设备聚合信息 */
  byInf: Map<string, { count: number; active: number; installed: number; devices: string[]; provider: string; version: string; className: string }>
}> {
  const usedInfs = new Set<string>()
  const meta = new Map<string, InfMeta>()
  const byInf = new Map<string, { count: number; active: number; installed: number; devices: string[]; provider: string; version: string; className: string }>()

  // 1) 在用驱动信息（WMI/CIM，普通权限可读）：inf 名 + 设备名 + 厂商 + 版本 + 状态 + 是否在位
  const tw0 = Date.now()
  try {
    const wmi = `$ErrorActionPreference='SilentlyContinue'
$d = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue |
      Select-Object InfName, DeviceName, Status, Present, Manufacturer, DriverVersion, DriverClass | Where-Object { $_.InfName })
ConvertTo-Json -Compress @($d)`
    const arr = parseJsonArray(await runPs(wmi))
    for (const d of arr) {
      const inf = String(d.InfName ?? '').toLowerCase()
      if (!inf) continue
      usedInfs.add(inf)
      let rec = byInf.get(inf)
      if (!rec) {
        rec = { count: 0, active: 0, installed: 0, devices: [], provider: '', version: '', className: '' }
        byInf.set(inf, rec)
      }
      rec.count++
      if (String(d.Status ?? '').toUpperCase() === 'OK') rec.active++
      if (Number(d.Present) === 1) rec.installed++
      const dn = String(d.DeviceName ?? '').trim()
      if (dn) rec.devices.push(dn)
      if (!rec.provider && d.Manufacturer) rec.provider = String(d.Manufacturer)
      if (!rec.version && d.DriverVersion) rec.version = String(d.DriverVersion)
      if (!rec.className && d.DriverClass) rec.className = String(d.DriverClass)
    }
    console.log('[drivers] wmi usedInfs=' + usedInfs.size + ' devices=' + arr.length + ' in ' + (Date.now() - tw0) + 'ms')
  } catch (e) {
    console.log('[drivers] wmi FAILED in ' + (Date.now() - tw0) + 'ms: ' + (e instanceof Error ? e.message : String(e)))
    /* WMI 不可用时 usedInfs 为空，下面会把所有项视为「未知」而非「可清理」 */
  }

  // 2) 已安装驱动包发布名与元数据映射：
  //    优先 Get-WindowsDriver（PowerShell 对象属性名语言无关，且含 ProviderName/Version/ClassName）；
  //    失败（DISM 模块缺失 / 权限不足）再回退 pnputil 文本解析（系统自带、跨版本，
  //    但输出字段名随系统语言，故中英文正则都匹配）。
  let gotPublished = false
  const td0 = Date.now()
  try {
    const dism = `$ErrorActionPreference='SilentlyContinue'
$pkgs = @(Get-WindowsDriver -Online -ErrorAction SilentlyContinue |
          Select-Object Driver, OriginalFileName, ClassName, ProviderName, Version)
ConvertTo-Json -Compress @($pkgs)`
    const arr = parseJsonArray(await runPs(dism))
    for (const p of arr) {
      const pub = String(p.Driver ?? '').toLowerCase()
      const orig = String(p.OriginalFileName ?? '')
      const base = path.basename(orig).toLowerCase()
      if (pub && base && !meta.has(base)) {
        meta.set(base, {
          published: pub,
          original: base,
          provider: String(p.ProviderName ?? ''),
          version: String(p.Version ?? ''),
          className: String(p.ClassName ?? ''),
        })
      }
    }
    gotPublished = arr.length > 0
    console.log('[drivers] dism gotPublished=' + gotPublished + ' pkgs=' + arr.length + ' in ' + (Date.now() - td0) + 'ms')
  } catch (e) {
    console.log('[drivers] dism FAILED in ' + (Date.now() - td0) + 'ms: ' + (e instanceof Error ? e.message : String(e)))
    gotPublished = false
  }

  if (!gotPublished) {
    const tp0 = Date.now()
    try {
      const out = await runPs('& pnputil /enum-drivers 2>$null')
      // 累积当前驱动块的字段，遇到下一个 Published Name 或结束时再落库，
      // 避免「Class Name / Provider Name / Version 排在 Original Name 之后」导致漏采。
      let cur: {
        pub: string
        orig: string
        provider: string
        version: string
        className: string
      } | null = null
      const flush = () => {
        if (cur && cur.pub && cur.orig) {
          const base = path.basename(cur.orig).toLowerCase()
          if (base && !meta.has(base)) {
            meta.set(base, {
              published: cur.pub,
              original: base,
              provider: cur.provider,
              version: cur.version,
              className: cur.className,
            })
          }
        }
        cur = null
      }
      for (const raw of out.split(/\r?\n/)) {
        const ln = raw.trim()
        const mPub = ln.match(/(Published Name|已发布的名称)\s*[:：]\s*(\S+)/i)
        if (mPub) {
          flush()
          cur = { pub: mPub[2].toLowerCase(), orig: '', provider: '', version: '', className: '' }
          continue
        }
        const mOrig = ln.match(/(Original Name|原始名称)\s*[:：]\s*(\S+)/i)
        if (mOrig && cur) {
          cur.orig = mOrig[2]
          continue
        }
        const mClass = ln.match(/(Class Name|类名)\s*[:：]\s*(\S+)/i)
        if (mClass && cur) {
          cur.className = mClass[2]
          continue
        }
        const mProv = ln.match(/(Provider Name|提供程序名称|提供者名称|提供方)\s*[:：]\s*(.+)/i)
        if (mProv && cur) {
          cur.provider = mProv[2].trim()
          continue
        }
        const mVer = ln.match(/(Version|版本)\s*[:：]\s*(\S+)/i)
        if (mVer && cur) {
          cur.version = mVer[2]
          continue
        }
      }
      flush()
      console.log('[drivers] pnputil fallback published=' + meta.size + ' in ' + (Date.now() - tp0) + 'ms')
    } catch (e) {
      console.log('[drivers] pnputil FAILED in ' + (Date.now() - tp0) + 'ms: ' + (e instanceof Error ? e.message : String(e)))
      /* pnputil 也不可用：meta 保持空 */
    }
  }

  // 诊断文本（前端用于解释「为什么没有可清理项」）
  if (usedInfs.size === 0 && meta.size === 0) {
    lastDriverDiag =
      '未能读取驱动信息：可能未以管理员身份运行 GrClean，或当前系统缺少 DISM/pnputil 组件。无法判断哪些驱动包可安全清理。'
  } else if (meta.size === 0) {
    lastDriverDiag =
      '已读取在用驱动，但未能枚举驱动包发布名（pnputil/DISM 不可用），无法确定可删除项。'
  } else {
    lastDriverDiag = ''
  }
  return { usedInfs, meta, byInf }
}

/** 读取最近一次驱动采集诊断（由 handlers 在扫描完成时回传前端）。 */
export function getLastDriverDiag(): string {
  return lastDriverDiag
}

/** 两个驱动包是否属于同一厂商 + 同一驱动类（用于比较版本新旧）。 */
function sameFamily(a: DriverItem, b: DriverItem): boolean {
  return (
    !!a.providerName &&
    !!b.providerName &&
    !!a.className &&
    !!b.className &&
    a.providerName.toLowerCase() === b.providerName.toLowerCase() &&
    a.className.toLowerCase() === b.className.toLowerCase()
  )
}

/**
 * 后处理：根据全部驱动包交叉比对，计算每个包的状态/理由/被替换设备数。
 * - 在使用 → in_use（不可清理）
 * - 不在使用但有同族更新版本正在使用 → old_confirmed（高置信，可清理）
 * - 不在使用但有同族更新版本（未在使用）→ recommended（可清理）
 * - 不在使用且无同族更新版本 → no_newer_version（需谨慎，不可清理）
 * - 采集不可靠 → 一律视为 in_use（不可清理）
 */
function enrichDrivers(all: DriverItem[], deviceSets: Set<string>[], reliable: boolean): void {
  for (let i = 0; i < all.length; i++) {
    const it = all[i]
    if (!reliable) {
      it.status = 'in_use'
      it.inUse = true
      it.actionable = false
      it.candidate = false
      it.reason = '未能确定驱动使用情况，为安全起见视为在用'
      it.outrankedDeviceCount = 0
      continue
    }
    if ((it.deviceCount ?? 0) > 0) {
      it.status = 'in_use'
      it.inUse = true
      it.actionable = false
      it.candidate = false
      it.reason = '该驱动包当前有设备正在使用'
      it.outrankedDeviceCount = 0
      continue
    }
    // 查找同族更新版本
    let newer: DriverItem | null = null
    for (let j = 0; j < all.length; j++) {
      if (j === i) continue
      const o = all[j]
      if (!sameFamily(it, o)) continue
      if (cmpVer(o.driverVersion, it.driverVersion) > 0) {
        newer = o
        break
      }
    }
    if (newer) {
      if ((newer.deviceCount ?? 0) > 0) {
        it.status = 'old_confirmed'
        it.reason = '检测到更新版本正在使用，可安全清理旧版本'
      } else {
        it.status = 'recommended'
        it.reason = '存在更新版本，建议清理'
      }
      it.actionable = true
    } else {
      it.status = 'no_newer_version'
      it.actionable = false
      it.reason = '未检测到更新版本，清理请谨慎'
    }
    it.inUse = false
    it.candidate = it.actionable

    // 被替换设备数：本包设备中被「同族更新且正在使用」的包占用的数量
    const myDevices = deviceSets[i]
    let out = 0
    if (myDevices && myDevices.size) {
      const seen = new Set<string>()
      for (let j = 0; j < all.length; j++) {
        if (j === i) continue
        const o = all[j]
        if (!sameFamily(it, o)) continue
        if (cmpVer(o.driverVersion, it.driverVersion) <= 0) continue
        if ((o.deviceCount ?? 0) === 0) continue
        for (const d of deviceSets[j]) {
          if (myDevices.has(d) && !seen.has(d)) {
            seen.add(d)
            out++
          }
        }
      }
    }
    it.outrankedDeviceCount = out
  }
}

/**
 * 流式扫描驱动存储库（先累加全部条目，交叉比对后批量 yield，保证状态/理由正确）。
 * 注意：若无法采集到任何在用驱动信息（无权限 / DISM 不可用），
 * 所有条目一律标记 `inUse = true`，绝不误判为可清理。
 */
export async function* scanDriversStream(
  isCancelled: () => boolean,
  onProgress?: (scanned: number, total: number) => void,
): AsyncGenerator<DriverItem[], void, unknown> {
  const repo = repoDir()
  console.log('[drivers] scan start; repo=' + repo + ' exists=' + fs.existsSync(repo))
  if (!fs.existsSync(repo)) {
    console.log('[drivers] repo not found, abort scan')
    return
  }
  const t0 = Date.now()
  const state = await collectDriverState()
  console.log(
    '[drivers] state collected in ' +
      (Date.now() - t0) +
      'ms; usedInfs=' +
      state.usedInfs.size +
      ' meta=' +
      state.meta.size +
      ' reliable=' +
      (state.usedInfs.size > 0),
  )
  const reliable = state.usedInfs.size > 0

  let ents: fs.Dirent[] = []
  try {
    ents = fs.readdirSync(repo, { withFileTypes: true })
  } catch {
    console.log('[drivers] repo readdir FAILED')
    return
  }
  console.log('[drivers] repo dirs=' + ents.length)
  const totalDirs = ents.length
  let scanned = 0
  onProgress?.(0, totalDirs)

  const pairs: { it: DriverItem; devices: Set<string> }[] = []

  for (const e of ents) {
    if (isCancelled()) return
    if (!e.isDirectory()) continue
    scanned++
    const fp = path.join(repo, e.name)
    let infs: string[] = []
    try {
      infs = fs
        .readdirSync(fp)
        .filter((n) => n.toLowerCase().endsWith('.inf'))
    } catch {
      continue
    }
    const st = dirStat(fp)
    const size = st.bytes
    if (size <= 0) continue

    const lowerInfs = infs.map((i) => i.toLowerCase())
    // 目录名形如 `xxx.inf_amd64_yyy`，其前缀即原始 inf 基名
    const dirBase = e.name.split('_')[0]?.toLowerCase() ?? ''
    let m: InfMeta | null = null
    for (const i of lowerInfs) {
      if (state.meta.has(i)) {
        m = state.meta.get(i) as InfMeta
        break
      }
    }
    if (!m && dirBase && state.meta.has(dirBase)) {
      m = state.meta.get(dirBase) as InfMeta
    }

    // 聚合厂商 / 版本 / 设备数 / 活动数 / 当前在位设备数（按 inf 累加）
    let providerName: string | null = null
    let driverVersion: string | null = null
    let className = ''
    let deviceCount = 0
    let activeDeviceCount = 0
    let installedDeviceCount = 0
    const devices = new Set<string>()
    for (const i of lowerInfs) {
      const info = state.byInf.get(i)
      if (!info) continue
      deviceCount += info.count
      activeDeviceCount += info.active
      installedDeviceCount += info.installed
      for (const dn of info.devices) devices.add(dn)
      if (!providerName && info.provider) providerName = info.provider
      if (!driverVersion && info.version) driverVersion = info.version
      if (!className && info.className) className = info.className
    }
    // 元数据优先取自 Get-WindowsDriver（对所有包可用，含未使用包）
    if (m) {
      if (!providerName && m.provider) providerName = m.provider
      if (!driverVersion && m.version) driverVersion = m.version
      if (!className && m.className) className = m.className
    }

    // 系统自带驱动判定：厂商为 Microsoft，或驱动类为 system devices（随 Windows 预装、不可删）
    const isSystem =
      (!!providerName && /microsoft/i.test(providerName)) ||
      /^system(\s+devices)?$/i.test(className)

    pairs.push({
      it: {
        id: hashId(fp),
        name: e.name,
        path: fp,
        size,
        infs,
        inUse: !reliable || deviceCount > 0,
        published: m ? m.published : null,
        className,
        candidate: false,
        originalName: m ? m.original : infs[0] ?? null,
        providerName,
        driverVersion,
        deviceCount,
        activeDeviceCount,
        installedDeviceCount,
        fileCount: st.files,
        status: 'unknown',
        reason: '',
        actionable: false,
        isSystem,
        outrankedDeviceCount: 0,
      },
      devices,
    })

    if (pairs.length % 12 === 0) {
      onProgress?.(scanned, totalDirs)
      await new Promise((r) => setImmediate(r))
    }
  }
  onProgress?.(scanned, totalDirs)

  // 排序：按目录名数字字母自然升序（数字在前、字母在后）
  pairs.sort((a, b) =>
    a.it.name.localeCompare(b.it.name, undefined, { numeric: true, sensitivity: 'base' }),
  )
  const raw = pairs.map((p) => p.it)
  const deviceSets = pairs.map((p) => p.devices)

  // 交叉比对，计算状态 / 理由 / 被替换设备数
  enrichDrivers(raw, deviceSets, reliable)
  // 系统自带驱动一律不可删除（override 任何判定结果）
  for (const it of raw) {
    if (it.isSystem) {
      it.candidate = false
      it.actionable = false
      it.inUse = true
    }
  }
  console.log('[drivers] enriched; total=' + raw.length + ' reliable=' + reliable)

  // 批量 yield（前端累加显示，done 时整体覆盖）
  for (let i = 0; i < raw.length; i += 12) {
    yield raw.slice(i, i + 12)
    await new Promise((r) => setImmediate(r))
  }
  console.log('[drivers] scan finished; dirs=' + ents.length + ' yielded=' + raw.length)
}

export interface DriverDeleteResult {
  id: string
  ok: boolean
  message: string
}

/**
 * 删除孤立驱动包（`pnputil /delete-driver <oemNN.inf> /force`）。
 * 仅接受会话内 id，且再次校验 `actionable` 与发布名，防止误删在用驱动。
 */
export async function deleteDrivers(
  items: Map<string, DriverItem>,
  ids: string[],
): Promise<DriverDeleteResult[]> {
  const out: DriverDeleteResult[] = []
  for (const id of ids) {
    const it = items.get(id)
    if (!it) {
      out.push({ id, ok: false, message: '条目不在本次扫描会话内' })
      continue
    }
    if (it.inUse || !it.actionable) {
      out.push({ id, ok: false, message: '该驱动包可能仍被设备使用，已拒绝删除' })
      continue
    }
    if (!it.published) {
      out.push({ id, ok: false, message: '无法解析驱动发布名，已拒绝删除' })
      continue
    }
    try {
      await runPs(`pnputil /delete-driver ${it.published} /force`)
      out.push({ id, ok: true, message: `已删除 ${it.published}` })
    } catch (e) {
      out.push({ id, ok: false, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
