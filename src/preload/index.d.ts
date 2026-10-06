import { ElectronAPI } from '@electron-toolkit/preload'

interface CleanCandidate {
  id: string
  path: string
  size: number
  category: string
  rule_id: string
}
interface ScanResult {
  total_count: number
  total_size: number
  categories: Array<{ category: string; count: number; size: number }>
  candidates: CleanCandidate[]
  cancelled: boolean
}
interface CleanResult {
  deleted_count: number
  deleted_size: number
  skipped: Array<{ id: string; path: string; reason: string }>
  errors: string[]
}
interface BigFileEntry {
  path: string
  size: number
}
interface DuplicateFile {
  id: string
  path: string
  size: number
}
interface DuplicateGroup {
  group_id: string
  hash: string
  size: number
  count: number
  wasted: number
  files: DuplicateFile[]
}
interface StartupEntry {
  id: string
  name: string
  command: string
  source: string
  location: string
  enabled: boolean
}
interface UninstallEntry {
  id: string
  name: string
  version: string
  publisher: string
  install_location: string
  size_kb: number
  uninstall_string: string
  quiet_uninstall_string: string
  can_uninstall: boolean
}
interface UninstallResult {
  launched: boolean
  command: string
  error: string | null
}
interface RuleInfo {
  id: string
  name: string
  description: string
  category: string
  enabled: boolean
  source: string
  paths: string[]
  max_age_days: number
}
interface UserRuleInput {
  id: string
  name: string
  category: string
  description: string
  enabled: boolean
  paths: string[]
  max_age_days: number
  min_size_kb: number
}
interface ScheduleConfig {
  id: string
  name: string
  frequency: string
  time: string
  rule_ids: string[]
  enabled: boolean
}
interface PrivacyRuleOption {
  id: string
  name: string
}
interface OkResult {
  ok: boolean
  error: string | null
}

interface RegistryEntry {
  id: string
  category: string
  key_path: string
  name: string
  kind: 'value' | 'key'
  target: string
  detail: string
}
interface RegistryCleanResult {
  deleted_count: number
  skipped: Array<{ id: string; reason: string }>
  errors: string[]
  backup_file: string | null
}
interface RegistryBackup {
  file: string
  created_at: string
  count: number
}

interface ExtraJunkItem {
  id: string
  name: string
  description: string
  /** safe | caution | danger */
  level: string
  recommend: boolean
}

export interface GrCleanApi {
  scanJunk(
    extraIds: string[],
    onItem: (item: CleanCandidate) => void,
  ): Promise<ScanResult>
  scanBigFiles(
    minMb: number,
    includeAll: boolean,
    onItem: (item: BigFileEntry) => void,
  ): Promise<BigFileEntry[]>
  scanDuplicates(
    minMb: number,
    onGroup: (g: DuplicateGroup) => void,
    onProgress: (n: number) => void,
    drive?: string,
  ): Promise<DuplicateGroup[]>
  scanStartup(onItem: (item: StartupEntry) => void): Promise<StartupEntry[]>
  scanUninstall(
    onItem: (item: UninstallEntry) => void,
  ): Promise<UninstallEntry[]>
  scanRegistry(
    onItem: (item: RegistryEntry) => void,
  ): Promise<RegistryEntry[]>
  uninstall(id: string, quiet: boolean): Promise<UninstallResult>
  setStartupEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error: string | null }>
  cancelScan(): void
  deleteDuplicates(ids: string[], purge: boolean): Promise<CleanResult>
  clean(
    ids: string[] | null,
    purge: boolean,
    onProgress?: (ev: { type: 'items'; ids: string[] }) => void,
  ): Promise<CleanResult>
  deleteOne(path: string): Promise<{ ok: boolean; error: string | null }>
  listExtraJunk(): Promise<ExtraJunkItem[]>
  deleteRegistry(ids: string[]): Promise<RegistryCleanResult>
  listRegistryBackups(): Promise<RegistryBackup[]>
  restoreRegistry(file: string): Promise<{ restored: number; errors: string[] }>
  listRules(): Promise<RuleInfo[]>
  addUserRule(rule: UserRuleInput): Promise<OkResult>
  deleteUserRule(id: string): Promise<OkResult>
  getRulesDir(): Promise<string>
  openRulesDir(): Promise<void>
  listSchedules(): Promise<ScheduleConfig[]>
  addSchedule(cfg: ScheduleConfig): Promise<OkResult>
  deleteSchedule(id: string): Promise<OkResult>
  listPrivacyRules(): Promise<PrivacyRuleOption[]>
  runPrivacyNow(ruleIds: string[] | null): Promise<CleanResult>
  getVersion(): Promise<string>
  windowControls: {
    minimize(): void
    toggleMaximize(): void
    close(): void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: GrCleanApi
  }
}
