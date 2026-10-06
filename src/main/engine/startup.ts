import fs from 'fs'
import path from 'path'
import { type StartupEntry } from './model'
import { runPs, psQuote, parseJsonArray } from './ps'

/** 禁用标记：追加到注册表值名 / 快捷方式文件名末尾，可逆、不丢失数据。 */
const DISABLED_SUFFIX = '.grdisabled'

// ---------------------------------------------------------------------------
// 1) 注册表 Run / RunOnce
// ---------------------------------------------------------------------------

interface RegRow {
  hive: string
  sub: string
  name: string
  command: string
}

async function registryRows(): Promise<RegRow[]> {
  const script = `
$targets = @(
  @{ h='HKCU'; s='Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
  @{ h='HKCU'; s='Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' },
  @{ h='HKLM'; s='Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
  @{ h='HKLM'; s='Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' },
  @{ h='HKLM'; s='Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run' },
  @{ h='HKLM'; s='Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce' }
)
$out = @()
foreach ($t in $targets) {
  $full = $t.h + ':\\' + $t.s
  $props = Get-ItemProperty -Path $full -ErrorAction SilentlyContinue
  if ($props) {
    foreach ($p in $props.PSObject.Properties) {
      if ($p.Name -like 'PS*') { continue }
      $out += [PSCustomObject]@{ hive=$t.h; sub=$t.s; name=$p.Name; command=[string]$p.Value }
    }
  }
}
ConvertTo-Json -InputObject ([object[]]$out) -Depth 4 -Compress
`
  const json = await runPs(script)
  return parseJsonArray(json) as RegRow[]
}

async function regEntries(): Promise<StartupEntry[]> {
  const out: StartupEntry[] = []
  for (const r of await registryRows()) {
    const disabled = r.name.endsWith(DISABLED_SUFFIX)
    const display = disabled
      ? r.name.slice(0, -DISABLED_SUFFIX.length)
      : r.name
    out.push({
      id: `reg|${r.hive}|${r.sub}|${r.name}`,
      name: display,
      command: r.command,
      location: `${r.hive}: ${r.sub}`,
      source: 'registry',
      enabled: !disabled,
    })
  }
  return out
}

async function setRegEnabled(
  hive: string,
  sub: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const isDisabledName = name.endsWith(DISABLED_SUFFIX)
  const targetDisabled = !enabled
  if (isDisabledName === targetDisabled) return // 已是目标状态

  const newName = targetDisabled
    ? name + DISABLED_SUFFIX
    : name.slice(0, -DISABLED_SUFFIX.length)
  const full = `${hive}:\\${sub}`
  const script = `Rename-ItemProperty -Path ${psQuote(full)} -Name ${psQuote(
    name,
  )} -NewName ${psQuote(newName)} -ErrorAction Stop`
  await runPs(script)
}

// ---------------------------------------------------------------------------
// 2) 启动文件夹（当前用户 + 所有用户）
// ---------------------------------------------------------------------------

function startupFolders(): string[] {
  const dirs: string[] = []
  const appdata = process.env.APPDATA
  if (appdata) {
    dirs.push(
      path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    )
  }
  const programData = process.env.ProgramData || process.env.ALLUSERSPROFILE
  if (programData) {
    dirs.push(
      path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    )
  }
  return dirs
}

function folderEntries(): StartupEntry[] {
  const out: StartupEntry[] = []
  for (const d of startupFolders()) {
    let names: string[]
    try {
      names = fs.readdirSync(d)
    } catch {
      continue
    }
    for (const fname of names) {
      const full = path.join(d, fname)
      if (fname.endsWith('.lnk' + DISABLED_SUFFIX)) {
        const stem = path.basename(fname, '.lnk' + DISABLED_SUFFIX)
        out.push({
          id: `folder|${full}`,
          name: stem,
          command: full,
          location: '启动文件夹',
          source: 'folder',
          enabled: false,
        })
      } else if (fname.endsWith('.lnk')) {
        const stem = path.basename(fname, '.lnk')
        out.push({
          id: `folder|${full}`,
          name: stem,
          command: full,
          location: '启动文件夹',
          source: 'folder',
          enabled: true,
        })
      }
    }
  }
  return out
}

function setFolderEnabled(p: string, enabled: boolean): void {
  const ext = path.extname(p)
  const isDisabled = ext === DISABLED_SUFFIX
  if (isDisabled === !enabled) return // 已是目标状态

  const target = enabled
    ? p.slice(0, -DISABLED_SUFFIX.length) // x.lnk.grdisabled -> x.lnk
    : p + DISABLED_SUFFIX
  fs.renameSync(p, target)
}

// ---------------------------------------------------------------------------
// 3) 任务计划（schtasks，best-effort）
// ---------------------------------------------------------------------------

/** 解析一条 CSV（schtasks 输出），支持双引号转义 `""`。 */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQ = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQ = true
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out
}

async function taskEntries(): Promise<StartupEntry[]> {
  let text = ''
  try {
    text = await runPs('schtasks /query /fo CSV /nh')
  } catch {
    return []
  }
  const out: StartupEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const cols = parseCsvLine(line)
    if (cols.length < 3) continue
    const name = cols[0].trim()
    if (!name) continue
    // 过滤系统自带任务，减少噪音
    if (name.toLowerCase().includes('\\microsoft\\')) continue
    const status = cols[2].trim()
    const enabled = !status.toLowerCase().includes('disabled')
    out.push({
      id: `task|${name}`,
      name: name.replace(/^\\/, ''),
      command: name,
      location: '任务计划程序',
      source: 'task',
      enabled,
    })
  }
  return out
}

async function setTaskEnabled(name: string, enabled: boolean): Promise<void> {
  const verb = enabled ? '/enable' : '/disable'
  await runPs(`schtasks /change /tn ${psQuote(name)} ${verb}`)
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 汇总全部启动项（注册表 + 启动文件夹 + 任务计划）。 */
export async function collectStartupEntries(): Promise<StartupEntry[]> {
  const out: StartupEntry[] = []
  try {
    out.push(...(await regEntries()))
  } catch {
    /* 部分注册表不可读时跳过 */
  }
  try {
    out.push(...folderEntries())
  } catch {
    /* 启动文件夹不可读时跳过 */
  }
  try {
    out.push(...(await taskEntries()))
  } catch {
    /* schtasks 不可用时跳过 */
  }
  return out
}

/**
 * 启动项流式扫描：收集完成后按小批 yield（每批间 setImmediate 让权），
 * 前端「边扫边显示」从上方逐行增加；全程可取消。
 */
export async function* scanStartupStream(
  isCancelled: () => boolean,
): AsyncGenerator<StartupEntry[], void, unknown> {
  const all = await collectStartupEntries()
  let batch: StartupEntry[] = []
  for (const e of all) {
    if (isCancelled()) return
    batch.push(e)
    if (batch.length >= 10) {
      yield batch
      batch = []
      await new Promise((r) => setImmediate(r))
    }
  }
  if (batch.length) yield batch
}

/** 启用 / 禁用某个启动项（不可逆删除，仅重命名，随时可恢复）。 */
export async function setStartupEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  if (id.startsWith('reg|')) {
    const parts = id.split('|')
    // reg|hive|sub|name（name 中可能含 '|'，故合并剩余部分）
    const hive = parts[1]
    const sub = parts[2]
    const name = parts.slice(3).join('|')
    await setRegEnabled(hive, sub, name, enabled)
    return
  }
  if (id.startsWith('folder|')) {
    setFolderEnabled(id.slice('folder|'.length), enabled)
    return
  }
  if (id.startsWith('task|')) {
    await setTaskEnabled(id.slice('task|'.length), enabled)
    return
  }
  throw new Error('无法识别的启动项 id')
}
