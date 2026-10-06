import { type CleanCandidate, type RegistryEntry } from './model'
import type { SocialItem } from './social'
import type { InstallerItem } from './installer'
import type { LogItem } from './logs'
import type { ContextMenuItem, ShellIconItem } from './contextmenu'
import type { DriverItem } from './drivers'
import type { MigrateItem } from './migrate'
import type { ResidueItem } from './residue'
import type { RecycleEntry } from './recycle'

/**
 * 一次扫描的会话：保存候选清单（以 id 为键），清理时按 id 反查真实路径。
 * 这样渲染层永远不能传入任意路径，从机制上杜绝路径注入（对应 Rust AppState）。
 */
export interface ScanSession {
  candidates: Map<string, CleanCandidate>
}

/**
 * 全局应用状态（单例）。
 * - `session`：垃圾清理候选会话
 * - `dupSession`：重复文件候选会话（与垃圾清理隔离，互不覆盖）
 * - `cancel`：扫描取消标志（前端点击「取消扫描」后置 true，扫描循环轮询以中断）
 */
/** 注册表清理会话：以 id 为键保存待清理项，清理时反查真实注册表位置。 */
export interface RegistrySession {
  entries: Map<string, RegistryEntry>
}

/** 社交缓存会话：以 id 为键保存条目，清理时反查真实目录（锁定项一并保留，用于拒绝）。 */
export interface SocialSession {
  items: Map<string, SocialItem>
}

/** 安装包 / 日志 / 右键菜单 / 驱动：均为「id → 条目」的会话，清理时反查真实路径。 */
export interface ItemSession<T> {
  items: Map<string, T>
}

export class AppState {
  session: ScanSession | null = null
  dupSession: ScanSession | null = null
  regSession: RegistrySession | null = null
  socialSession: SocialSession | null = null
  installerSession: ItemSession<InstallerItem> | null = null
  logSession: ItemSession<LogItem> | null = null
  ctxSession: ItemSession<ContextMenuItem> | null = null
  iconSession: ItemSession<ShellIconItem> | null = null
  driverSession: ItemSession<DriverItem> | null = null
  residueSession: ItemSession<ResidueItem> | null = null
  /** 回收站条目会话：以 id 为键保存真实 $R/$I 路径，清理时反查（已在回收站内，删除即永久删除） */
  recycleSession: ItemSession<RecycleEntry> | null = null
  /** 可迁移目录清单（迁移/还原按 id 反查，避免前端传入任意路径） */
  migrateItems: MigrateItem[] = []
  cancel = false

  setSession(candidates: CleanCandidate[]): void {
    const map = new Map<string, CleanCandidate>()
    for (const c of candidates) map.set(c.id, c)
    this.session = { candidates: map }
  }

  setDupSession(candidates: CleanCandidate[]): void {
    const map = new Map<string, CleanCandidate>()
    for (const c of candidates) map.set(c.id, c)
    this.dupSession = { candidates: map }
  }

  setRegSession(entries: RegistryEntry[]): void {
    const map = new Map<string, RegistryEntry>()
    for (const e of entries) map.set(e.id, e)
    this.regSession = { entries: map }
  }

  setSocialSession(items: SocialItem[]): void {
    const map = new Map<string, SocialItem>()
    for (const it of items) map.set(it.id, it)
    this.socialSession = { items: map }
  }

  /** 通用条目会话工厂（安装包 / 日志 / 右键菜单 / 驱动共用同一套反查机制）。 */
  setItemSession<T extends { id: string }>(
    key:
      | 'installerSession'
      | 'logSession'
      | 'ctxSession'
      | 'iconSession'
      | 'driverSession'
      | 'residueSession'
      | 'recycleSession',
    items: T[],
  ): void {
    const map = new Map<string, T>()
    for (const it of items) map.set(it.id, it)
    // 各会话的条目类型不同，但结构一致（Map<string, T>），此处统一收纳
    ;(this as unknown as Record<string, unknown>)[key] = { items: map }
  }

  resetCancel(): void {
    this.cancel = false
  }
}

// 进程级单例
export const appState = new AppState()
