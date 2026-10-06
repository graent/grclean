// 与 Tauri 后端 model.rs 对应的 TypeScript 数据模型（按模块逐步启用）

export interface CleanCandidate {
  id: string;
  path: string;
  size: number;
  category: string;
  rule_id: string;
}

export interface CategorySummary {
  category: string;
  count: number;
  size: number;
}

export interface ScanResult {
  total_count: number;
  total_size: number;
  categories: CategorySummary[];
  candidates: CleanCandidate[];
  /** 是否被前端「取消扫描」中断 */
  cancelled: boolean;
}

export interface BigFileEntry {
  path: string;
  size: number;
}

export interface RuleInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  source: string;
  paths: string[];
  max_age_days: number;
}

export interface UserRuleInput {
  id: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  paths: string[];
  max_age_days: number;
  min_size_kb: number;
}

/** 一条无效注册表项（仅检测已确认失效的项，绝不批量删键）。 */
export interface RegistryEntry {
  /** 由「键路径 + 名称」哈希而来，清理时用于反查真实位置 */
  id: string;
  /** 分类：卸载残留 / 无效启动项 / 丢失的共享 DLL / 无效应用路径 */
  category: string;
  /** 父键的 PowerShell 路径，如 `HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall` */
  key_path: string;
  /** kind=value 时为值名；kind=key 时为子键名 */
  name: string;
  /** value=删除某个值；key=删除整个子键 */
  kind: "value" | "key";
  /** 指向的、已不存在的目标路径（判定依据） */
  target: string;
  /** 展示用详情（如程序显示名 / 原始命令） */
  detail: string;
}

/** 注册表清理结果（含备份文件路径，便于失败后恢复）。 */
export interface RegistryCleanResult {
  deleted_count: number;
  skipped: Array<{ id: string; reason: string }>;
  errors: string[];
  /** 本次删除前写入的备份文件（JSON 快照），失败时为 null */
  backup_file: string | null;
}

/** 一条定时隐私清理计划（序列化到 `schedules/<id>.json`）。 */
export interface ScheduleConfig {
  /** 唯一标识，同时用作文件名（净化后）与 Windows 任务名后缀 */
  id: string;
  name: string;
  /** "daily" | "weekly" */
  frequency: string;
  /** 触发时间 "HH:MM"（24 小时制） */
  time: string;
  /** 选中的规则 id 列表（空 = 全部内置隐私规则） */
  rule_ids: string[];
  /** 是否启用（对应 Windows 任务是否存在） */
  enabled: boolean;
}

/** 隐私清理可勾选的规则项（精简结构，仅前端勾选用）。 */
export interface PrivacyRuleOption {
  id: string;
  name: string;
}

export interface StartupEntry {
  id: string;
  name: string;
  command: string;
  source: string;
  location: string;
  enabled: boolean;
}

export interface SkippedItem {
  id: string;
  path: string;
  reason: string;
}

export interface UninstallEntry {
  id: string;
  name: string;
  version: string;
  publisher: string;
  install_location: string;
  size_kb: number;
  uninstall_string: string;
  quiet_uninstall_string: string;
  can_uninstall: boolean;
}

export interface UninstallResult {
  launched: boolean;
  command: string;
  error: string | null;
}

export interface DuplicateFile {
  id: string;
  path: string;
  size: number;
}

export interface DuplicateGroup {
  group_id: string;
  hash: string;
  size: number;
  count: number;
  wasted: number;
  files: DuplicateFile[];
}

export interface CleanResult {
  deleted_count: number;
  deleted_size: number;
  skipped: SkippedItem[];
  errors: string[];
}
