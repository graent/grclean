import { runPs, parseJsonArray } from './ps'
import { createHash } from 'crypto'

/** 一条回收站内文件的元数据（真实路径由主进程持有，前端只传 id 反查）。 */
export interface RecycleEntry {
  /** 主进程生成的稳定 id（基于 $R 真实路径哈希） */
  id: string
  /** 真实 $R 数据项路径（文件或目录），删除用 */
  rPath: string
  /** 对应的 $I 信息文件路径（可能不存在），删除时一并清理 */
  iPath: string
  /** 原始文件名（如 report.docx） */
  name: string
  /** 原始所在目录（去掉文件名） */
  originalDir: string
  /** 原始完整路径 */
  originalPath: string
  /** 占用体积（字节）：文件取真实大小，目录递归求和 */
  size: number
  /** 删除时间（本地 yyyy-MM-dd HH:mm），解析失败为空串 */
  deletedAt: string
}

export interface RecycleDeleteResult {
  rPath: string
  ok: boolean
  error: string
}

// 复用的 PowerShell 辅助：判断是否为「文件不存在」类错误（坏项/孤儿条目，视为已清理）
const IS_NOT_FOUND_FN = `
function IsNotFound($ex) {
  $h = [int]$ex.Exception.HResult
  if ($h -eq 0x80070002) { return $true }
  $m = [string]$ex.Exception.Message
  if ($m -match 'cannot find the file specified' -or $m -match '系统找不到指定的文件') { return $true }
  return $false
}
`

function hashId(rPath: string): string {
  return 'rec:' + createHash('sha1').update(rPath).digest('hex').slice(0, 16)
}

/**
 * 枚举本机所有本地盘上、当前用户自己的回收站目录，逐条返回回收站内的文件/目录。
 *
 * 为什么按「当前用户 SID」聚合、而非整个 `$Recycle.Bin`：
 * - Windows 回收站按用户隔离，每个用户在 `$Recycle.Bin` 下有一个以自己 SID 命名的子目录；
 * - 只处理当前登录用户自己的回收站，既不越权碰别人数据，也不需要管理员权限。
 *
 * 每条解析 `$I` 信息文件得到：原始文件名、原始位置、删除时间；体积：文件取真实大小，
 * 目录递归求和（与资源管理器展示一致）。孤儿条目（$I 缺失或信息读不出）兜底用 `$R` 名。
 */
export async function recycleBinList(): Promise<RecycleEntry[]> {
  const script = `
${IS_NOT_FOUND_FN}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$out = @()
$drives = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match '^[A-Z]:\\\\$' } | Select-Object -ExpandProperty Name)
foreach ($d in $drives) {
  $rb = Join-Path -Path ($d + ':') -ChildPath '$Recycle.Bin' | ForEach-Object { Join-Path $_ $sid }
  if (-not (Test-Path -LiteralPath $rb -ErrorAction SilentlyContinue)) { continue }
  $rs = @(Get-ChildItem -LiteralPath $rb -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '$R*' })
  foreach ($r in $rs) {
    $iname = '$I' + $r.Name.Substring(2)
    $ip = Join-Path -Path $rb -ChildPath $iname
    $size = 0
    if ($r.PSIsContainer) {
      $sum = (Get-ChildItem -LiteralPath $r.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
      $size = [int64]($sum)
      if (-not $size) { $size = 0 }
    } else { $size = [int64]$r.Length }
    $originalPath = $r.FullName
    $deletedAt = ''
    if (Test-Path -LiteralPath $ip -ErrorAction SilentlyContinue) {
      try {
        $bytes = [System.IO.File]::ReadAllBytes($ip)
        if ($bytes.Length -ge 28) {
          $sizeFromI = [BitConverter]::ToInt64($bytes, 8)
          if ($sizeFromI -gt 0 -and -not $r.PSIsContainer) { $size = [int64]$sizeFromI }
          $ft = [BitConverter]::ToInt64($bytes, 16)
          if ($ft -gt 0) { $deletedAt = ([datetime]::FromFileTime($ft)).ToString('yyyy-MM-dd HH:mm') }
          # version 2（Win10/11）：$I 偏移 24-27 为路径长度(DWORD)，真实路径从 28 开始；
          # 旧版(version 0/1)无长度字段，路径从 24 开始
          $ver = [BitConverter]::ToInt32($bytes, 0)
          $pstart = 28
          if ($ver -ne 2) { $pstart = 24 }
          $plen = $bytes.Length - $pstart
          while ($plen -gt 2 -and [BitConverter]::ToUInt16($bytes, $pstart + $plen - 2) -eq 0) { $plen -= 2 }
          if ($plen -gt 0) { $originalPath = [System.Text.Encoding]::Unicode.GetString($bytes, $pstart, $plen) }
        }
      } catch { }
    }
    $fileName = ''
    $dir = ''
    try {
      $fileName = Split-Path -Leaf -Path $originalPath
      $dir = Split-Path -Parent -Path $originalPath
    } catch { }
    if (-not $fileName) { $fileName = $r.Name }
    $out += [PSCustomObject]@{
      rPath = $r.FullName
      iPath = $ip
      name = $fileName
      originalDir = $dir
      originalPath = $originalPath
      size = $size
      deletedAt = $deletedAt
    }
  }
}
ConvertTo-Json -InputObject $out -Compress
`.trim()

  try {
    const parsed = parseJsonArray(await runPs(script))
    return parsed.map((e: any) => ({
      id: hashId(String(e.rPath ?? '')),
      rPath: String(e.rPath ?? ''),
      iPath: String(e.iPath ?? ''),
      name: String(e.name ?? ''),
      originalDir: String(e.originalDir ?? ''),
      originalPath: String(e.originalPath ?? ''),
      size: Number(e.size ?? 0),
      deletedAt: String(e.deletedAt ?? ''),
    }))
  } catch {
    return []
  }
}

/**
 * 彻底删除指定回收站条目（传入的 $R/$I 真实路径）。因为条目已在回收站内，
 * 删除即「永久删除」，不走回收站二次中转。
 * 显式忽略 0x80070002（文件不存在）——坏项/孤儿条目视为已清理，不再误报失败。
 *
 * ⚠️ 必须分批：条目 JSON 会整体拼进 PowerShell `-Command` 参数，
 * Windows 命令行上限 32767 字符，整批一次传入条目一多就 spawn ENAMETOOLONG
 * （且整批全部误报失败）。按字符预算切块，逐批执行后按原顺序合并结果。
 */
const PS_CMD_CHAR_BUDGET = 12000

export async function deleteRecycleEntries(
  entries: Array<{ rPath: string; iPath: string }>,
  onBatch?: (
    batchResults: RecycleDeleteResult[],
    batchEntries: Array<{ rPath: string; iPath: string }>,
  ) => void,
): Promise<RecycleDeleteResult[]> {
  if (!entries.length) return []
  const out: RecycleDeleteResult[] = []
  let batch: Array<{ rPath: string; iPath: string }> = []
  let budget = 0
  const flush = async () => {
    if (!batch.length) return
    const res = await deleteRecycleEntriesBatch(batch)
    out.push(...res)
    onBatch?.(res, batch)
    batch = []
    budget = 0
  }
  for (const e of entries) {
    // 预算按 JSON 转义后估算：反斜杠翻倍 + 结构开销
    const cost = (e.rPath.length + e.iPath.length) * 2 + 40
    if (batch.length && budget + cost > PS_CMD_CHAR_BUDGET) await flush()
    batch.push(e)
    budget += cost
  }
  await flush()
  return out
}

/** 单批删除（内部使用，条目数受 PS_CMD_CHAR_BUDGET 约束）。 */
async function deleteRecycleEntriesBatch(
  entries: Array<{ rPath: string; iPath: string }>,
): Promise<RecycleDeleteResult[]> {
  if (!entries.length) return []
  const payload = JSON.stringify(entries.map((e) => ({ r: e.rPath, i: e.iPath })))
  const script = `
${IS_NOT_FOUND_FN}
$items = '${payload}' | ConvertFrom-Json
$res = @()
foreach ($it in $items) {
  $r = $it.r
  $i = $it.i
  $ok = $true
  $err = ''
  try {
    if (Test-Path -LiteralPath $r -ErrorAction SilentlyContinue) { Remove-Item -LiteralPath $r -Recurse -Force -ErrorAction Stop }
  } catch {
    if (-not (IsNotFound $_)) { $ok = $false; $err = "r: $($_.Exception.Message)" }
  }
  try {
    if (Test-Path -LiteralPath $i -ErrorAction SilentlyContinue) { Remove-Item -LiteralPath $i -Force -ErrorAction Stop }
  } catch {
    if (-not (IsNotFound $_)) { $ok = $false; if ($err) { $err += '; ' }; $err += "i: $($_.Exception.Message)" }
  }
  $res += [PSCustomObject]@{ rPath = $r; ok = $ok; error = $err }
}
ConvertTo-Json -InputObject $res -Compress
`.trim()

  try {
    const parsed = parseJsonArray(await runPs(script))
    return parsed.map((e: any) => ({
      rPath: String(e.rPath ?? ''),
      ok: e.ok === true || e.ok === 'True' || e.ok === 1,
      error: String(e.error ?? ''),
    }))
  } catch (e) {
    return entries.map((x) => ({
      rPath: x.rPath,
      ok: false,
      error: String(e instanceof Error ? e.message : e),
    }))
  }
}
