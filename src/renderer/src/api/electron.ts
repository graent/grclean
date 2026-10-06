// 与后端 engine/model.ts 对应的前端类型（阶段一：垃圾清理 + 阶段二：大文件）
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
  /** 是否被「取消扫描」中断 */
  cancelled: boolean;
}

export interface SkippedItem {
  id: string;
  path: string;
  reason: string;
}

export interface CleanResult {
  deleted_count: number;
  deleted_size: number;
  skipped: SkippedItem[];
  errors: string[];
}

export interface BigFileEntry {
  path: string;
  size: number;
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

export interface StartupEntry {
  id: string;
  name: string;
  command: string;
  /** registry / folder / task */
  source: string;
  location: string;
  enabled: boolean;
}

export interface UninstallEntry {
  id: string;
  name: string;
  version: string;
  publisher: string;
  install_location: string;
  /** EstimatedSize（KB） */
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

export interface RuleInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  /** builtin | user */
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

export interface ScheduleConfig {
  id: string;
  name: string;
  /** daily | weekly */
  frequency: string;
  /** HH:MM */
  time: string;
  /** 空数组 = 全部规则 */
  rule_ids: string[];
  enabled: boolean;
}

export interface PrivacyRuleOption {
  id: string;
  name: string;
}

export interface OkResult {
  ok: boolean;
  error: string | null;
}

/** 一条无效注册表项。 */
export interface RegistryEntry {
  id: string;
  category: string;
  /** 父键的 PowerShell 路径 */
  key_path: string;
  /** kind=value 时为值名；kind=key 时为子键名 */
  name: string;
  kind: "value" | "key";
  /** 指向的、已不存在的目标路径 */
  target: string;
  detail: string;
}

export interface RegistryCleanResult {
  deleted_count: number;
  skipped: Array<{ id: string; reason: string }>;
  errors: string[];
  /** 删除前写入的备份文件路径 */
  backup_file: string | null;
}

export interface RegistryBackup {
  file: string;
  created_at: string;
  count: number;
}

/** 增强清理项（垃圾清理页可勾选，含风险等级与说明）。 */
export interface ExtraJunkItem {
  id: string;
  name: string;
  description: string;
  /** safe=安全 | caution=需确认 | danger=不可逆 */
  level: "safe" | "caution" | "danger";
  recommend: boolean;
}

/** 社交缓存风险等级：安全 / 建议 / 谨慎 / 锁定。 */
export type SocialLevel = "safe" | "advise" | "caution" | "locked";

/** 社交缓存条目（一款应用的一类缓存目录）。 */
export interface SocialItem {
  id: string;
  app: string;
  level: SocialLevel;
  name: string;
  path: string;
  size: number;
  fileCount: number;
  /** 聊天记录等锁定项：界面不可勾选，后端亦拒绝删除 */
  locked: boolean;
  recommend: boolean;
}

/** 风险等级元信息（分组标题 / 说明 / 配色 / 是否默认勾选）。 */
export interface LevelMeta {
  order: number;
  label: string;
  desc: string;
  color: string;
  recommend: boolean;
  locked: boolean;
}

/** 单个磁盘的结构化信息（磁盘分析页）。 */
/** 语言包摘要（设置页语言下拉用）。 */
export interface LocaleMeta {
  /** 语言代码，同时也是文件名（不含 .json） */
  code: string;
  name: string;
  nativeName: string;
  /** 是否为内置播种包 */
  builtin: boolean;
  /** 词条数量 */
  count: number;
  file: string;
}

export interface DiskInfo {
  letter: string;
  /** 卷标名称（用户给盘符起的名字，如「系统」「软件」），无则空串 */
  name: string;
  fileSystem: string;
  totalBytes: number;
  freeBytes: number;
  /** SSD / HDD / Unknown */
  type: string;
  model: string;
  trimEnabled: boolean | null;
  aligned: boolean | null;
  smartOk: boolean | null;
  /** 健康 / 关注 / 警告 / 危险 */
  healthy: string;
  /** 是否为系统盘（%SystemDrive%，通常 C:） */
  system: boolean;
}

/** SMART 概览一行：ok=true 正常（绿）/ false 异常（红）/ null 未知（灰）。 */
export interface SmartRow {
  label: string;
  value: string;
  ok: boolean | null;
}

/** 物理磁盘（硬盘本体）。 */
export interface PhysicalDiskInfo {
  deviceId: number;
  model: string;
  type: string;
  serial: string;
  firmware: string;
  busType: string;
  sizeBytes: number;
  letters: string[];
  totalBytes: number;
  freeBytes: number;
  smartOk: boolean | null;
  healthy: string;
  isSystem: boolean;
}

/** 安装包条目（§3.7）。 */
export interface InstallerItem {
  id: string;
  path: string;
  size: number;
  mtime: number;
  days: number;
  ext: string;
  byName: boolean;
}

/** 日志条目（§3.8）。 */
export interface LogItem {
  id: string;
  /** app=应用日志 / temp=临时日志 / crash=崩溃转储与错误报告 */
  group: "app" | "temp" | "crash";
  name: string;
  path: string;
  size: number;
  mtime: number;
}

/** C 盘瘦身项（§3.12）。 */
export interface SlimItem {
  kind: string;
  name: string;
  desc: string;
  size: number;
  /** safe=可逆 / caution=需确认 / danger=不可逆 */
  risk: "safe" | "caution" | "danger";
  recommend: boolean;
  /** false = 需跳转对应模块处理 */
  actionable: boolean;
  goto?: string;
}

/** 右键菜单项（§3.13）。 */
export interface ContextMenuItem {
  id: string;
  name: string;
  verb: string;
  source: string;
  key: string;
  command: string;
  /** 系统内置，不可操作 */
  system: boolean;
  disabled: boolean;
}

/** 卸载残留目录（§3.11）。 */
export interface ResidueItem {
  id: string;
  name: string;
  path: string;
  size: number;
  mtime: number;
  days: number;
  source: string;
}

/** 驱动包条目（§3.14）。字段参考 lightC 旧驱动清理。 */
export interface DriverItem {
  id: string;
  name: string;
  path: string;
  size: number;
  infs: string[];
  inUse: boolean;
  published: string | null;
  className: string;
  candidate: boolean;
  /** 原始 INF 文件名（如 nv_disp.inf），作为主要标题 */
  originalName?: string | null;
  /** 厂商（ProviderName） */
  providerName?: string | null;
  /** 版本（DriverVersion） */
  driverVersion?: string | null;
  /** 关联设备总数 */
  deviceCount?: number;
  /** 活动设备数（Status=OK） */
  activeDeviceCount?: number;
  /** 已安装/当前设备数（Present=1） */
  installedDeviceCount?: number;
  /** 被更新版本取代的设备数 */
  outrankedDeviceCount?: number;
  /** 驱动包内文件数 */
  fileCount?: number;
  /** 安全分类状态 */
  status?: 'in_use' | 'old_confirmed' | 'recommended' | 'no_newer_version' | 'unknown';
  /** 判定理由（中文） */
  reason?: string;
  /** 是否可安全清理（可勾选删除） */
  actionable?: boolean;
  /** 是否系统自带驱动（Microsoft 等），不可删除 */
  isSystem?: boolean;
}

/** 可迁移目录（§5.2）。 */
export interface MigrateItem {
  id: string;
  name: string;
  path: string;
  size: number;
  source: string;
  isJunction: boolean;
}

/** 迁移目标盘符。 */
export interface MigrateTarget {
  letter: string;
  freeBytes: number;
  totalBytes: number;
}

/** 通用按条操作结果。 */
export interface OpResult {
  id: string;
  ok: boolean;
  message: string;
}

/** C 盘瘦身执行结果（按 kind 回传）。 */
export interface SlimOpResult {
  kind: string;
  ok: boolean;
  message: string;
}

/** 外壳图标项（§3.13「此电脑」命名空间扩展）。 */
export interface ShellIconItem {
  id: string;
  name: string;
  guid: string;
  source: string;
  key: string;
  dll: string;
  system: boolean;
}

/** 磁盘优化项状态（§5.1）：good=已优化 / warn=可改进 / bad=异常 / unknown=采集失败。 */
export interface OptimizeOption {
  id: string;
  title: string;
  desc: string;
  status: "good" | "warn" | "bad" | "unknown";
  value: string;
  advice: string;
  needAdmin: boolean;
}

/** 单个优化 / 系统设置动作的结果。 */
export interface OptimizeResult {
  ok: boolean;
  message: string;
}

/** 可延迟启动的服务（启动加速）。 */
export interface DelayableService {
  name: string;
  displayName: string;
  delayed: boolean;
  thirdParty: boolean;
}

/** WSL / Docker 占用检测。 */
export interface VhdInfo {
  id: string;
  title: string;
  location: string;
  bytes: number;
  exists: boolean;
  advice: string;
}

/** 页面文件状态（§5.3）。 */
export interface PagefileInfo {
  autoManaged: boolean;
  ramMb: number;
  raw: string;
  files: Array<{
    drive: string;
    initialMb: number;
    maxMb: number;
    usedMb: number;
  }>;
  suggestInitialMb: number;
  suggestMaxMb: number;
  suggestReason: string;
}

/** 页面文件可迁移目标盘。 */
export interface PagefileTarget {
  letter: string;
  freeBytes: number;
  totalBytes: number;
}

/** 系统还原点状态（§3.9 / §5.3）。 */
export interface RestoreStatus {
  enabled: boolean;
  systemVolume: string;
  storage: Array<{ volume: string; maxMb: number; usedMb: number }>;
  points: Array<{ seq: number; description: string; time: string; type: string }>;
  totalUsedMb: number;
}

/** 目录树节点（大目录钻取）。 */
export interface TreeNode {
  path: string;
  name: string;
  size: number;
  fileCount: number;
  dirCount: number;
  children: TreeNode[];
}

/** 大目录钻取进度。 */
export interface AnalyzeProgress {
  dirs: number;
  files: number;
  bytes: number;
  current: string;
}

/** 容量快照。 */
export interface Snapshot {
  id: string;
  ts: number;
  time: string;
  volumes: Array<{ letter: string; totalBytes: number; freeBytes: number }>;
  dirs: Array<{ path: string; bytes: number }>;
}

/** 两次快照对比结果。 */
export interface SnapshotDiff {
  base: Snapshot;
  target: Snapshot;
  volumes: Array<{
    letter: string;
    usedBefore: number;
    usedAfter: number;
    delta: number;
  }>;
  dirs: Array<{
    path: string;
    before: number;
    after: number;
    delta: number;
    isNew: boolean;
  }>;
  totalDelta: number;
  days: number;
}

/** 一条评分因素结果。 */
export interface FactorResult {
  key: string;
  label: string;
  weight: number;
  score: number;
  max: number;
  detail: string;
}

/** 一键体检报告。 */
export interface HealthReport {
  score: number;
  level: string;
  levelColor: string;
  factors: FactorResult[];
  suggestions: string[];
  stats: {
    junkBytes: number;
    socialBytes: number;
    dupBytes: number;
    bigfileBytes: number;
    registryCount: number;
    startupCount: number;
    systemFreeGB: number;
    systemTotalGB: number;
    diskType: string;
    diskHealthy: string;
    scannedAt: string;
  };
}

/** 一条扫描记录（上次扫描时间 + 结果摘要）。 */
export interface ScanRecord {
  module: string;
  scannedAt: number;
  summary: string;
}

/** 一条捐赠记录（捐赠页列表用）。 */
export interface DonationItem {
  name: string;
  amount: number;
  date: string;
  message?: string;
  /** 支付方式（微信 / 支付宝 …） */
  method?: string;
}

/** 一个社群 / 群聊入口（反馈页底部用）。 */
export interface GroupInfo {
  /** qq / wechat / telegram / discord / other */
  type: string;
  name: string;
  /** 入群链接（可选，移动端可直接点开） */
  link?: string;
  /** 群二维码图片地址（可选；QQ / 微信类群悬停展示，缺省用前端占位） */
  qr?: string;
  note?: string;
  /** true = 界面不显示该项，但数据保留（临时下线某个群） */
  hidden?: boolean;
}

/** 一条公开反馈（已反馈列表用）。 */
export interface FeedbackItem {
  name?: string;
  content: string;
  date: string;
  reply?: string;
}

/** 社区信息：捐赠列表 + 群聊列表 + 公开反馈列表（远程拉取，带示例回退）。 */
/** 收款码配置（远程下发；图片由主进程校验哈希后下载，渲染层不直接请求网络） */
export interface DonateQrConfig {
  platform: string;
  url: string;
  sha256: string;
  payee?: string;
  account?: string;
}

export interface Community {
  donations: DonationItem[];
  groups: GroupInfo[];
  feedbacks: FeedbackItem[];
  qrs: DonateQrConfig[];
}

/** 收款码获取结果：ok=true 才有 dataUrl；否则 message 为英文错误码（i18n 映射后展示） */
export interface DonateQrResult {
  ok: boolean;
  platform: string;
  dataUrl?: string;
  payee?: string;
  account?: string;
  message: string;
}

/**
 * 程序完整性校验结果。
 * code：OK / MISMATCH / NOT_CONFIGURED / REMOTE_UNAVAILABLE / DEV_MODE /
 * NO_TARGET / HASH_FAILED（界面按 i18n 映射）。
 */
export interface IntegrityResult {
  code: string;
  version: string;
  /** 服务端返回的说明（正确 / 已被篡改） */
  msg: string;
  files: Array<{
    name: string;
    size: number;
    local: string;
    match: boolean | null;
  }>;
  checkedAt: number;
  /** 诊断明细：异常时携带本机实况（ASCII），便于定位环境 */
  detail?: string;
}

/** 更新信息（检查更新用）。 */
/** 系统属性信息（概览页「系统信息」卡片） */
export interface SystemInfo {
  os: string;
  arch: string;
  processor: string;
  cpuCores: number;
  cpuThreads: number;
  cpuGHz: number;
  memTotalGB: number;
  memFreeGB: number;
  computerName: string;
  user: string;
  /** 采集时间戳（ms） */
  updatedAt: number;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  url: string;
  notes: string[];
  /** remote=远程拉取成功 / sample=使用本地示例 */
  source: "remote" | "sample";
  checkedAt: number;
}

/** 反馈提交结果。 */
export interface FeedbackResult {
  ok: boolean;
  /** demo=true 表示演示环境（无后端），仅本地记录成功 */
  demo: boolean;
  message: string;
}

// preload 暴露的 window.api 接口（详见 preload/index.d.ts）
declare global {
  interface Window {
    api: {
      scanJunk(
        extraIds: string[],
        onItem: (item: CleanCandidate) => void,
      ): Promise<ScanResult>;
      scanBigFiles(
        minMb: number,
        scope: string,
        onItem: (item: BigFileEntry) => void,
      ): Promise<BigFileEntry[]>;
      scanDuplicates(
        minMb: number,
        onGroup: (g: DuplicateGroup) => void,
        onProgress: (n: number) => void,
        drive?: string,
      ): Promise<DuplicateGroup[]>;
      scanStartup(
        onItem: (item: StartupEntry) => void,
      ): Promise<StartupEntry[]>;
      setStartupEnabled(
        id: string,
        enabled: boolean,
      ): Promise<{ ok: boolean; error: string | null }>;
      scanUninstall(
        onItem: (item: UninstallEntry) => void,
      ): Promise<UninstallEntry[]>;
      scanRegistry(
        onItem: (item: RegistryEntry) => void,
      ): Promise<RegistryEntry[]>;
      scanSocial(onItem: (item: SocialItem) => void): Promise<SocialItem[]>;
      cancelScanSocial(): void;
      deleteSocial(ids: string[], purge: boolean): Promise<CleanResult>;
      listDisks(): Promise<DiskInfo[]>;
      listPhysicalDisks(): Promise<PhysicalDiskInfo[]>;
      smartOverview(deviceId: number): Promise<SmartRow[]>;
      diskInfo(letter: string): Promise<DiskInfo | null>;
      scanInstallers(
        minSizeMb: number,
        minDays: number,
        drive: string,
        onItem: (item: InstallerItem) => void,
      ): Promise<InstallerItem[]>;
      cancelScanInstallers(): void;
      deleteInstallers(ids: string[], purge: boolean): Promise<CleanResult>;
      scanLogs(
        minDays: number,
        drive: string,
        onItem: (item: LogItem) => void,
      ): Promise<LogItem[]>;
      cancelScanLogs(): void;
      deleteLogs(ids: string[], purge: boolean): Promise<CleanResult>;
      slimPlan(): Promise<SlimItem[]>;
      slimRun(kinds: string[]): Promise<SlimOpResult[]>;
      scanContextMenu(
        onItem: (item: ContextMenuItem) => void,
      ): Promise<ContextMenuItem[]>;
      setContextMenuDisabled(
        ids: string[],
        disabled: boolean,
      ): Promise<OpResult[]>;
      deleteContextMenu(ids: string[]): Promise<OpResult[]>;
      ctxBackupDir(): Promise<string>;
      /** 在资源管理器中打开某文件 / 目录所在的目录。 */
      openPath(path: string): Promise<{ ok: boolean; error: string | null }>;
      /** 大文件 / 单文件：删除（默认移入回收站）。 */
      deleteOne(path: string): Promise<{ ok: boolean; error: string | null }>;
      scanDrivers(
        onItem: (item: DriverItem) => void,
        onProgress?: (scanned: number, total: number) => void,
      ): Promise<{ items: DriverItem[]; note: string }>;
      deleteDrivers(ids: string[]): Promise<OpResult[]>;
      listMigratable(
        minMb: number,
        onItem: (item: MigrateItem) => void,
      ): Promise<MigrateItem[]>;
      listMigrateTargets(): Promise<MigrateTarget[]>;
      migrateDirectory(id: string, targetRoot: string): Promise<OpResult>;
      restoreDirectory(id: string): Promise<OpResult>;
      scanResidue(
        minSizeMb: number,
        minDays: number,
        onItem: (item: ResidueItem) => void,
      ): Promise<ResidueItem[]>;
      cancelScanResidue(): void;
      deleteResidue(ids: string[], purge: boolean): Promise<CleanResult>;
      scanShellIcons(
        onItem: (item: ShellIconItem) => void,
      ): Promise<ShellIconItem[]>;
      deleteShellIcons(ids: string[]): Promise<OpResult[]>;
      optStatus(letter: string): Promise<OptimizeOption[]>;
      optSetTrim(enable: boolean): Promise<OptimizeResult>;
      optDefrag(letter: string, analyze: boolean): Promise<OptimizeResult>;
      optOpenStorageSense(): Promise<OptimizeResult>;
      optRunStorageSense(): Promise<OptimizeResult>;
      optSetCompactOs(enable: boolean): Promise<OptimizeResult>;
      optServices(): Promise<DelayableService[]>;
      optSetServiceDelayed(
        name: string,
        delayed: boolean,
      ): Promise<OptimizeResult>;
      optVhd(): Promise<VhdInfo[]>;
      pfInfo(): Promise<PagefileInfo>;
      pfTargets(): Promise<PagefileTarget[]>;
      pfApply(
        mode: string,
        letter: string,
        initialMb: number,
        maxMb: number,
      ): Promise<OptimizeResult>;
      rpStatus(): Promise<RestoreStatus>;
      rpDeleteOld(keep: number): Promise<OptimizeResult>;
      rpSetMax(pct: number): Promise<OptimizeResult>;
      rpSetProtection(enable: boolean): Promise<OptimizeResult>;
      tmRoots(): Promise<Array<{ label: string; path: string }>>;
      tmAnalyze(root: string, depth: number): Promise<TreeNode>;
      tmCancel(): void;
      onTreemapProgress(cb: (p: AnalyzeProgress) => void): () => void;
      snapTake(root?: string): Promise<Snapshot>;
      snapList(): Promise<Snapshot[]>;
      snapDelete(id: string): Promise<boolean>;
      snapDiff(baseId: string, targetId: string): Promise<SnapshotDiff | null>;
      snapCancel(): void;
      uninstall(id: string, quiet: boolean): Promise<UninstallResult>;
      cancelScan(): void;
      clean(
        ids: string[] | null,
        purge: boolean,
        onProgress?: (ev: { type: 'items'; ids: string[] }) => void,
      ): Promise<CleanResult>;
      deleteDuplicates(
        ids: string[],
        purge: boolean,
      ): Promise<CleanResult>;
      listExtraJunk(): Promise<ExtraJunkItem[]>;
      deleteRegistry(ids: string[]): Promise<RegistryCleanResult>;
      listRegistryBackups(): Promise<RegistryBackup[]>;
      restoreRegistry(
        file: string,
      ): Promise<{ restored: number; errors: string[] }>;
      listRules(): Promise<RuleInfo[]>;
      addUserRule(rule: UserRuleInput): Promise<OkResult>;
      deleteUserRule(id: string): Promise<OkResult>;
      getRulesDir(): Promise<string>;
      openRulesDir(): Promise<void>;
      listSchedules(): Promise<ScheduleConfig[]>;
      addSchedule(cfg: ScheduleConfig): Promise<OkResult>;
      deleteSchedule(id: string): Promise<OkResult>;
      listPrivacyRules(): Promise<PrivacyRuleOption[]>;
      runPrivacyNow(ruleIds: string[] | null): Promise<CleanResult>;
      healthScan(): Promise<HealthReport>;
      getVersion(): Promise<string>;
      getSystemInfo(force?: boolean): Promise<SystemInfo>;
      listLocales(): Promise<LocaleMeta[]>;
      getLocaleMessages(code: string): Promise<Record<string, string>>;
      getI18nDir(): Promise<string>;
      openI18nDir(): Promise<void>;
      getScanHistory(module: string): Promise<ScanRecord | null>;
      recordScanHistory(module: string, summary: string): Promise<ScanRecord>;
      checkUpdate(): Promise<UpdateInfo>;
      fetchCommunity(): Promise<Community>;
      fetchDonateQr(platform: string): Promise<DonateQrResult>;
      submitFeedback(payload: {
        name?: string;
        type?: string;
        contact?: string;
        content: string;
      }): Promise<FeedbackResult>;
      verifyIntegrity(): Promise<IntegrityResult>;
      openExternal(url: string): Promise<boolean>;
      windowControls: {
        minimize(): void;
        close(): void;
        /** 切换窗口置顶，返回切换后的状态。 */
        toggleAlwaysOnTop(): Promise<boolean>;
        /** 读取当前置顶状态。 */
        isAlwaysOnTop(): Promise<boolean>;
      };
    };
  }
}

/**
 * 启动垃圾清理扫描，期间通过回调逐条（批）返回候选，最终 resolve 权威结果。
 * @param extraIds 勾选的「增强清理项」id 列表
 */
export function scanJunk(
  extraIds: string[],
  onItem: (item: CleanCandidate) => void,
): Promise<ScanResult> {
  return window.api.scanJunk(extraIds, onItem);
}

/** 列出增强清理项目录（含风险等级与说明文案）。 */
export function listExtraJunk(): Promise<ExtraJunkItem[]> {
  return window.api.listExtraJunk();
}

/** 扫描无效注册表项，期间逐条回调。 */
export function scanRegistry(
  onItem: (item: RegistryEntry) => void,
): Promise<RegistryEntry[]> {
  return window.api.scanRegistry(onItem);
}

/** 删除选中的注册表项（先备份，再逐项校验删除）。 */
export function deleteRegistry(ids: string[]): Promise<RegistryCleanResult> {
  return window.api.deleteRegistry(ids);
}

/** 列出注册表清理备份。 */
export function listRegistryBackups(): Promise<RegistryBackup[]> {
  return window.api.listRegistryBackups();
}

/** 从备份恢复注册表项。 */
export function restoreRegistry(
  file: string,
): Promise<{ restored: number; errors: string[] }> {
  return window.api.restoreRegistry(file);
}

/** 启动大文件分析，期间通过回调逐条（批）返回大文件，最终 resolve 降序结果。
 *  scope：''=用户目录；'all'=全部盘符；'C'/'D'…=指定盘符。 */
export function scanBigFiles(
  minMb: number,
  scope: string,
  onItem: (item: BigFileEntry) => void,
): Promise<BigFileEntry[]> {
  return window.api.scanBigFiles(minMb, scope, onItem);
}

/** 启动重复文件扫描，期间逐组回调 + 周期上报哈希进度，最终 resolve 降序结果。 */
export function scanDuplicates(
  minMb: number,
  onGroup: (g: DuplicateGroup) => void,
  onProgress: (n: number) => void,
  drive?: string,
): Promise<DuplicateGroup[]> {
  return window.api.scanDuplicates(minMb, onGroup, onProgress, drive);
}

/** 扫描启动项，期间逐条回调，最终 resolve 权威结果。 */
export function scanStartup(
  onItem: (item: StartupEntry) => void,
): Promise<StartupEntry[]> {
  return window.api.scanStartup(onItem);
}

/** 启用 / 禁用启动项（可逆，不删除数据）。 */
export function setStartupEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  return window.api.setStartupEnabled(id, enabled);
}

/** 扫描已安装程序，期间逐条回调，最终 resolve 权威结果。 */
export function scanUninstall(
  onItem: (item: UninstallEntry) => void,
): Promise<UninstallEntry[]> {
  return window.api.scanUninstall(onItem);
}

/**
 * 触发原生卸载（二次确认后调用）。命令由后端从注册表反查，前端仅传 id。
 * @param quiet true=优先使用静默卸载（若程序支持）
 */
export function uninstall(
  id: string,
  quiet: boolean,
): Promise<UninstallResult> {
  return window.api.uninstall(id, quiet);
}

/** 取消正在进行的扫描（各扫描模块共用）。 */
export function cancelScan(): void {
  window.api.cancelScan();
}

/**
 * 删除选中的重复副本（安全删除：受保护路径拦截 + 默认回收站 + 审计）。
 * @param purge true=永久删除；false=移入回收站（默认、安全）
 */
export function deleteDuplicates(
  ids: string[],
  purge: boolean,
): Promise<CleanResult> {
  return window.api.deleteDuplicates(ids, purge);
}

/**
 * 执行清理。
 * @param ids 待删除候选 id 列表；传 null 表示全部
 * @param purge true=永久删除；false=移入回收站（默认、安全）
 */
export function clean(
  ids: string[] | null,
  purge: boolean,
  onProgress?: (ev: { type: 'items'; ids: string[] }) => void,
): Promise<CleanResult> {
  return window.api.clean(ids, purge, onProgress);
}

/** 列出清理规则（内置 + 用户 JSON 规则）。 */
export function listRules(): Promise<RuleInfo[]> {
  return window.api.listRules();
}

/** 新增 / 覆盖一条用户规则。 */
export function addUserRule(rule: UserRuleInput): Promise<OkResult> {
  return window.api.addUserRule(rule);
}

/** 删除一条用户规则（内置规则不可删）。 */
export function deleteUserRule(id: string): Promise<OkResult> {
  return window.api.deleteUserRule(id);
}

/** 用户规则存放目录。 */
export function getRulesDir(): Promise<string> {
  return window.api.getRulesDir();
}

/** 在资源管理器中打开规则目录。 */
export function openRulesDir(): Promise<void> {
  return window.api.openRulesDir();
}

/** 列出定时清理计划。 */
export function listSchedules(): Promise<ScheduleConfig[]> {
  return window.api.listSchedules();
}

/**
 * 创建定时清理计划（注册 Windows 计划任务 + 落盘配置）。
 * 失败时返回 error，常见原因是缺少管理员权限。
 */
export function addSchedule(cfg: ScheduleConfig): Promise<OkResult> {
  return window.api.addSchedule(cfg);
}

/** 删除定时清理计划（同时移除 Windows 计划任务）。 */
export function deleteSchedule(id: string): Promise<OkResult> {
  return window.api.deleteSchedule(id);
}

/** 定时清理可勾选的规则范围。 */
export function listPrivacyRules(): Promise<PrivacyRuleOption[]> {
  return window.api.listPrivacyRules();
}

/** 立即执行一次隐私清理（仅移入回收站，绝不永久删除）。 */
export function runPrivacyNow(ruleIds: string[] | null): Promise<CleanResult> {
  return window.api.runPrivacyNow(ruleIds);
}

/** 读取应用版本号。 */
export function getVersion(): Promise<string> {
  return window.api.getVersion();
}

/** 读取系统属性信息（概览页展示）。 */
/** 读取系统属性；force=true 时忽略缓存重新采集（概览页刷新按钮）。 */
export function getSystemInfo(force = false): Promise<SystemInfo> {
  return window.api.getSystemInfo(force);
}

/** 一键体检：编排各扫描 + 评分，返回完整报告。 */
export function healthScan(): Promise<HealthReport> {
  return window.api.healthScan();
}

/** 列出可用语言包（每次都重新读盘，运行中可热增减）。 */
export function listLocales(): Promise<LocaleMeta[]> {
  return window.api.listLocales();
}

/** 读取指定语言的词条表。 */
export function getLocaleMessages(
  code: string,
): Promise<Record<string, string>> {
  return window.api.getLocaleMessages(code);
}

/** 语言包目录路径。 */
export function getI18nDir(): Promise<string> {
  return window.api.getI18nDir();
}

/** 在资源管理器中打开语言包目录。 */
export function openI18nDir(): Promise<void> {
  return window.api.openI18nDir();
}

/** 在资源管理器中打开某文件 / 目录所在的目录（扫描结果一键定位）。 */
export function openPath(
  path: string,
): Promise<{ ok: boolean; error: string | null }> {
  return window.api.openPath(path);
}

/** 读取某模块最近一次扫描记录（时间 + 结果摘要）。 */
export function getScanHistory(
  module: string,
): Promise<ScanRecord | null> {
  return window.api.getScanHistory(module);
}

/** 写入（覆盖）某模块最近一次扫描记录。 */
export function recordScanHistory(
  module: string,
  summary: string,
): Promise<ScanRecord> {
  return window.api.recordScanHistory(module, summary);
}

/** 检查更新：远程拉取版本信息并与当前版本比较（带本地示例回退）。 */
export function checkUpdate(): Promise<UpdateInfo> {
  return window.api.checkUpdate();
}

/** 获取社区信息（捐赠列表 + 群聊列表，带示例回退）。 */
export function fetchCommunity(): Promise<Community> {
  return window.api.fetchCommunity();
}

/** 拉取收款码（主进程下载 + SHA-256 校验，校验不过只回错误码）。 */
export function fetchDonateQr(platform: string): Promise<DonateQrResult> {
  return window.api.fetchDonateQr(platform);
}

/** 提交反馈（演示环境仅本地确认，不真正发往远程）。 */
export function submitFeedback(payload: {
  name?: string;
  type?: string;
  contact?: string;
  content: string;
}): Promise<FeedbackResult> {
  return window.api.submitFeedback(payload);
}

/** 程序完整性校验：本机程序文件哈希 vs 官方发布值（需联网）。 */
export function verifyIntegrity(): Promise<IntegrityResult> {
  return window.api.verifyIntegrity();
}

/** 用系统默认浏览器打开 http(s) 外链（非 http(s) 会被主进程拒绝）。 */
export function openExternal(url: string): Promise<boolean> {
  return window.api.openExternal(url);
}

/** 社交缓存流式扫描（按应用分批回调）。 */
export function scanSocial(
  onItem: (item: SocialItem) => void,
): Promise<SocialItem[]> {
  return window.api.scanSocial(onItem);
}

/** 取消社交缓存扫描。 */
export function cancelScanSocial(): void {
  window.api.cancelScanSocial();
}

/** 清理社交缓存选中项（purge=true 永久删除，默认移入回收站）。 */
export function deleteSocial(
  ids: string[],
  purge: boolean,
): Promise<CleanResult> {
  return window.api.deleteSocial(ids, purge);
}

/** 大文件 / 单文件：删除（默认移入回收站）。 */
export function deleteOne(
  path: string,
): Promise<{ ok: boolean; error: string | null }> {
  return window.api.deleteOne(path);
}

/** 列出所有本地卷的磁盘信息。 */
export function listDisks(): Promise<DiskInfo[]> {
  return window.api.listDisks();
}

/** 列出本机所有物理磁盘（硬盘本体，含其盘符）。 */
export function listPhysicalDisks(): Promise<PhysicalDiskInfo[]> {
  return window.api.listPhysicalDisks();
}

/** 读取指定物理磁盘（deviceId）的 SMART 概览。 */
export function smartOverview(deviceId: number): Promise<SmartRow[]> {
  return window.api.smartOverview(deviceId);
}

/** 读取指定盘符的磁盘信息。 */
export function diskInfo(letter: string): Promise<DiskInfo | null> {
  return window.api.diskInfo(letter);
}

/** 安装包流式扫描。drive：'' / 'all' = 所有盘符；'C'/'D'… = 仅该盘符下的下载目录。 */
export function scanInstallers(
  minSizeMb: number,
  minDays: number,
  drive: string,
  onItem: (item: InstallerItem) => void,
): Promise<InstallerItem[]> {
  return window.api.scanInstallers(minSizeMb, minDays, drive, onItem);
}

/** 取消安装包扫描。 */
export function cancelScanInstallers(): void {
  window.api.cancelScanInstallers();
}

/** 删除安装包（purge=true 永久删除，默认回收站）。 */
export function deleteInstallers(
  ids: string[],
  purge: boolean,
): Promise<CleanResult> {
  return window.api.deleteInstallers(ids, purge);
}

/** 日志流式扫描。drive：'' / 'all' = 所有盘符；'C'/'D'… = 仅该盘符下的用户日志。 */
export function scanLogs(
  minDays: number,
  drive: string,
  onItem: (item: LogItem) => void,
): Promise<LogItem[]> {
  return window.api.scanLogs(minDays, drive, onItem);
}

/** 取消日志扫描。 */
export function cancelScanLogs(): void {
  window.api.cancelScanLogs();
}

/** 删除日志条目（系统关键日志由后端 isProtected 拦截）。 */
export function deleteLogs(ids: string[], purge: boolean): Promise<CleanResult> {
  return window.api.deleteLogs(ids, purge);
}

/** 生成 C 盘瘦身方案（只统计，不改任何东西）。 */
export function slimPlan(): Promise<SlimItem[]> {
  return window.api.slimPlan();
}

/** 执行 C 盘瘦身项（不可逆项需管理员权限）。 */
export function slimRun(kinds: string[]): Promise<SlimOpResult[]> {
  return window.api.slimRun(kinds);
}

/** 枚举右键菜单项，期间逐条回调。 */
export function scanContextMenu(
  onItem: (item: ContextMenuItem) => void,
): Promise<ContextMenuItem[]> {
  return window.api.scanContextMenu(onItem);
}

/** 禁用 / 启用右键菜单项（可逆）。 */
export function setContextMenuDisabled(
  ids: string[],
  disabled: boolean,
): Promise<OpResult[]> {
  return window.api.setContextMenuDisabled(ids, disabled);
}

/** 删除右键菜单项（删除前自动导出 .reg 备份）。 */
export function deleteContextMenu(ids: string[]): Promise<OpResult[]> {
  return window.api.deleteContextMenu(ids);
}

/** 右键菜单备份目录。 */
export function ctxBackupDir(): Promise<string> {
  return window.api.ctxBackupDir();
}

/** 扫描驱动存储库，期间逐条回调；返回结果数组与采集诊断 note。 */
export function scanDrivers(
  onItem: (item: DriverItem) => void,
  onProgress?: (scanned: number, total: number) => void,
): Promise<{ items: DriverItem[]; note: string }> {
  return window.api.scanDrivers(onItem, onProgress);
}

/** 删除孤立驱动包（需管理员，仅删无设备使用者）。 */
export function deleteDrivers(ids: string[]): Promise<OpResult[]> {
  return window.api.deleteDrivers(ids);
}

/** 列出可迁移目录，期间逐条回调。 */
export function listMigratable(
  minMb: number,
  onItem: (item: MigrateItem) => void,
): Promise<MigrateItem[]> {
  return window.api.listMigratable(minMb, onItem);
}

/** 列出可用目标盘符。 */
export function listMigrateTargets(): Promise<MigrateTarget[]> {
  return window.api.listMigrateTargets();
}

/** 迁移目录（移动 + 目录联接，失败自动回滚）。 */
export function migrateDirectory(
  id: string,
  targetRoot: string,
): Promise<OpResult> {
  return window.api.migrateDirectory(id, targetRoot);
}

/** 还原迁移（删联接 + 数据搬回）。 */
export function restoreDirectory(id: string): Promise<OpResult> {
  return window.api.restoreDirectory(id);
}

/** 卸载残留流式扫描（§3.11）。 */
export function scanResidue(
  minSizeMb: number,
  minDays: number,
  onItem: (item: ResidueItem) => void,
): Promise<ResidueItem[]> {
  return window.api.scanResidue(minSizeMb, minDays, onItem);
}

/** 取消卸载残留扫描。 */
export function cancelScanResidue(): void {
  window.api.cancelScanResidue();
}

/** 删除卸载残留目录（默认回收站）。 */
export function deleteResidue(
  ids: string[],
  purge: boolean,
): Promise<CleanResult> {
  return window.api.deleteResidue(ids, purge);
}

/** 扫描「此电脑」外壳图标（命名空间扩展），期间逐条回调。 */
export function scanShellIcons(
  onItem: (item: ShellIconItem) => void,
): Promise<ShellIconItem[]> {
  return window.api.scanShellIcons(onItem);
}

/** 移除外壳图标（删除前导出 .reg 备份；系统内置 GUID 会被后端拒绝）。 */
export function deleteShellIcons(ids: string[]): Promise<OpResult[]> {
  return window.api.deleteShellIcons(ids);
}

/** 读取磁盘优化四项状态。 */
export function optStatus(letter: string): Promise<OptimizeOption[]> {
  return window.api.optStatus(letter);
}

/** 开启 / 关闭 SSD Trim（需管理员）。 */
export function optSetTrim(enable: boolean): Promise<OptimizeResult> {
  return window.api.optSetTrim(enable);
}

/** 碎片整理（analyze=true 仅分析）。 */
export function optDefrag(
  letter: string,
  analyze: boolean,
): Promise<OptimizeResult> {
  return window.api.optDefrag(letter, analyze);
}

/** 打开系统「存储感知」设置页。 */
export function optOpenStorageSense(): Promise<OptimizeResult> {
  return window.api.optOpenStorageSense();
}

/** 立即运行一次存储感知任务。 */
export function optRunStorageSense(): Promise<OptimizeResult> {
  return window.api.optRunStorageSense();
}

/** 开启 / 关闭 CompactOS 压缩（需管理员）。 */
export function optSetCompactOs(enable: boolean): Promise<OptimizeResult> {
  return window.api.optSetCompactOs(enable);
}

/** 列出可延迟启动的服务。 */
export function optServices(): Promise<DelayableService[]> {
  return window.api.optServices();
}

/** 把服务设为延迟启动 / 取消延迟（需管理员）。 */
export function optSetServiceDelayed(
  name: string,
  delayed: boolean,
): Promise<OptimizeResult> {
  return window.api.optSetServiceDelayed(name, delayed);
}

/** 检测 WSL / Docker 占用。 */
export function optVhd(): Promise<VhdInfo[]> {
  return window.api.optVhd();
}

/** 读取页面文件状态。 */
export function pfInfo(): Promise<PagefileInfo> {
  return window.api.pfInfo();
}

/** 列出页面文件可迁移的目标盘。 */
export function pfTargets(): Promise<PagefileTarget[]> {
  return window.api.pfTargets();
}

/** 应用页面文件设置（重启后生效）。 */
export function pfApply(
  mode: string,
  letter: string,
  initialMb: number,
  maxMb: number,
): Promise<OptimizeResult> {
  return window.api.pfApply(mode, letter, initialMb, maxMb);
}

/** 读取系统还原点状态。 */
export function rpStatus(): Promise<RestoreStatus> {
  return window.api.rpStatus();
}

/** 清理较早的还原点，保留最近 keep 个。 */
export function rpDeleteOld(keep: number): Promise<OptimizeResult> {
  return window.api.rpDeleteOld(keep);
}

/** 调整还原点最大占用比例。 */
export function rpSetMax(pct: number): Promise<OptimizeResult> {
  return window.api.rpSetMax(pct);
}

/** 启用 / 关闭系统保护（关闭会删除全部还原点）。 */
export function rpSetProtection(enable: boolean): Promise<OptimizeResult> {
  return window.api.rpSetProtection(enable);
}

/** 大目录钻取可选的起始根目录。 */
export function tmRoots(): Promise<Array<{ label: string; path: string }>> {
  return window.api.tmRoots();
}

/** 分析目录树体积。 */
export function tmAnalyze(root: string, depth: number): Promise<TreeNode> {
  return window.api.tmAnalyze(root, depth);
}

/** 取消目录分析。 */
export function tmCancel(): void {
  window.api.tmCancel();
}

/** 订阅目录分析进度，返回取消订阅函数。 */
export function onTreemapProgress(
  cb: (p: AnalyzeProgress) => void,
): () => void {
  return window.api.onTreemapProgress(cb);
}

/** 创建一次容量快照。 */
export function snapTake(root?: string): Promise<Snapshot> {
  return window.api.snapTake(root);
}

/** 列出全部快照（最新在前）。 */
export function snapList(): Promise<Snapshot[]> {
  return window.api.snapList();
}

/** 删除一条快照。 */
export function snapDelete(id: string): Promise<boolean> {
  return window.api.snapDelete(id);
}

/** 对比两次快照。 */
export function snapDiff(
  baseId: string,
  targetId: string,
): Promise<SnapshotDiff | null> {
  return window.api.snapDiff(baseId, targetId);
}

/** 取消快照创建。 */
export function snapCancel(): void {
  window.api.snapCancel();
}

/**
 * 开发期自检：校验 preload 实际暴露的 api 是否完整。
 *
 * 背景：preload 仅在 BrowserWindow 创建时执行一次，Vite HMR 只热更新 Vue 组件，
 * 不会更新 preload。因此改了 preload 后若不刷新页面，渲染层拿到的仍是旧 api
 * （表现为 `window.api.xxx is not a function`），而类型检查无法发现——
 * index.d.ts 的声明与运行时对象是两回事。此函数用于把该问题即时暴露到控制台。
 */
export function assertApiKeys(): void {
  const required = [
    "scanJunk",
    "scanBigFiles",
    "scanDuplicates",
    "scanStartup",
    "scanUninstall",
    "setStartupEnabled",
    "uninstall",
    "cancelScan",
    "clean",
    "deleteDuplicates",
    "listExtraJunk",
    "scanRegistry",
    "deleteRegistry",
    "listRegistryBackups",
    "restoreRegistry",
    "listRules",
    "addUserRule",
    "deleteUserRule",
    "getRulesDir",
    "openRulesDir",
    "listSchedules",
    "addSchedule",
    "deleteSchedule",
    "listPrivacyRules",
    "runPrivacyNow",
    "healthScan",
    "scanSocial",
    "cancelScanSocial",
    "deleteSocial",
    "deleteOne",
    "listDisks",
    "listPhysicalDisks",
    "smartOverview",
    "diskInfo",
    "scanInstallers",
    "cancelScanInstallers",
    "deleteInstallers",
    "scanLogs",
    "cancelScanLogs",
    "deleteLogs",
    "slimPlan",
    "slimRun",
    "scanContextMenu",
    "setContextMenuDisabled",
    "deleteContextMenu",
    "ctxBackupDir",
    "openPath",
    "scanDrivers",
    "deleteDrivers",
    "listMigratable",
    "listMigrateTargets",
    "migrateDirectory",
    "restoreDirectory",
    "scanResidue",
    "cancelScanResidue",
    "deleteResidue",
    "scanShellIcons",
    "deleteShellIcons",
    "optStatus",
    "optSetTrim",
    "optDefrag",
    "optOpenStorageSense",
    "optRunStorageSense",
    "optSetCompactOs",
    "optServices",
    "optSetServiceDelayed",
    "optVhd",
    "pfInfo",
    "pfTargets",
    "pfApply",
    "rpStatus",
    "rpDeleteOld",
    "rpSetMax",
    "rpSetProtection",
    "tmRoots",
    "tmAnalyze",
    "tmCancel",
    "onTreemapProgress",
    "snapTake",
    "snapList",
    "snapDelete",
    "snapDiff",
    "snapCancel",
    "getVersion",
    "getSystemInfo",
    "listLocales",
    "getLocaleMessages",
    "getI18nDir",
    "openI18nDir",
    "getScanHistory",
    "recordScanHistory",
    "checkUpdate",
    "fetchCommunity",
    "verifyIntegrity",
    "openExternal",
    "fetchDonateQr",
    "submitFeedback",
    "windowControls",
  ];
  const api = window.api as unknown as Record<string, unknown> | undefined;
  if (!api) {
    console.error(
      "[GrClean] window.api 未注入，请检查 preload 是否加载（重启应用）",
    );
    return;
  }
  const missing = required.filter((k) => typeof api[k] !== "function" && typeof api[k] !== "object");
  if (missing.length) {
    console.error(
      `%c[GrClean] preload 为旧版本，缺少：${missing.join(", ")}\n` +
        `→ 请在窗口内按 Ctrl+R 刷新页面；若无效则 Ctrl+C 停止后重新 npm run dev`,
      "color:#e5484d;font-weight:bold",
    );
  } else {
    console.log(
      `%c[GrClean] preload api 自检通过（${required.length} 项）`,
      "color:#30a46c",
    );
  }
}

// 字节格式化工具
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// 扫描范围选择器（大文件 / 日志共用）：系统盘最上且默认，全部磁盘放最后。
// ---------------------------------------------------------------------------
/** 由盘符列表构建下拉选项：系统盘优先，其余按原序，最后追加「全部磁盘」。 */
export function buildScopeOptions(
  disks: DiskInfo[],
): { value: string; label: string }[] {
  const sys =
    disks.find((d) => d.system) ??
    disks.find((d) => d.letter.toUpperCase() === "C");
  const others = disks.filter((d) => d !== sys);
  const opts: { value: string; label: string }[] = [];
  if (sys) opts.push({ value: sys.letter, label: `${sys.letter}: 系统盘` });
  for (const d of others)
    opts.push({ value: d.letter, label: `${d.letter}: 盘` });
  opts.push({ value: "all", label: "全部磁盘（较慢）" });
  return opts;
}

// ---------------------------------------------------------------------------
// 轻量本地存储辅助：用于记住扫描范围、缓存盘符列表，避免每次重读。
// ---------------------------------------------------------------------------
export function getLocal(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

export function setLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等场景静默失败 */
  }
}

const DISK_CACHE_KEY = "grclean.diskList.cache";

/** 读取缓存的盘符列表（瞬时填充下拉，避免每次进入都跑 PowerShell 查询）。 */
export function getCachedDisks(): DiskInfo[] {
  try {
    const raw = getLocal(DISK_CACHE_KEY);
    if (raw) return JSON.parse(raw) as DiskInfo[];
  } catch {
    /* ignore */
  }
  return [];
}

/** 缓存盘符列表。 */
export function setCachedDisks(disks: DiskInfo[]): void {
  setLocal(DISK_CACHE_KEY, JSON.stringify(disks));
}
