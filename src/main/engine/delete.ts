import fs from 'fs'
import {
  type CleanCandidate,
  type CleanResult,
} from './model'
import { isProtected } from './protected'
import { logDeletion } from './audit'
import { moveToRecycleBin } from './trash-bin'

/**
 * 通用删除核心（垃圾清理、重复文件、定时隐私清理共用）。
 *
 * 纵深防御：
 * 1. 仅接受候选 `id`，从会话反查真实路径，前端无法注入任意路径；
 * 2. 执行期再次校验 `isProtected`（受保护路径一律拦截）；
 * 3. 仅删除文件，目录跳过；
 * 4. 默认移入回收站（purge=false），purge=true 才永久删除；
 * 5. 删除成功者写入审计日志。
 */
export async function deleteCandidates(
  candidates: Map<string, CleanCandidate>,
  ids: string[] | null,
  purge: boolean,
  opts?: import('./protected').ProtectedOptions & {
    /** 每成功删除一项即回调（用于清理过程实时进度推送） */
    onDeleted?: (c: CleanCandidate) => void
  },
): Promise<CleanResult> {
  const toDelete: CleanCandidate[] = ids
    ? ids
        .map((id) => candidates.get(id))
        .filter((c): c is CleanCandidate => !!c)
    : Array.from(candidates.values())

  const result: CleanResult = {
    deleted_count: 0,
    deleted_size: 0,
    skipped: [],
    errors: [],
  }
  const deleted: CleanCandidate[] = []

  // 移入回收站：经 trash-bin 定位 windows-trash.exe 直接执行
  // （不再直接用 trash 包，避免打包后 import.meta.url 解析失败）

  for (const c of toDelete) {
    // 防线：执行期再次校验受保护路径
    // （系统级清理项需本次显式勾选且路径落在声明目录内才放行）
    if (isProtected(c.path, opts)) {
      result.skipped.push({
        id: c.id,
        path: c.path,
        reason: '受保护路径，已拦截',
      })
      continue
    }
    // 仅删文件，目录跳过（更安全）
    let isDir = false
    try {
      isDir = fs.statSync(c.path).isDirectory()
    } catch {
      /* 文件可能已不存在，下方删除会报错并记录 */
    }
    if (isDir) {
      result.skipped.push({
        id: c.id,
        path: c.path,
        reason: '不支持删除目录，已跳过',
      })
      continue
    }
    try {
      if (purge) {
        fs.unlinkSync(c.path)
      } else {
        await moveToRecycleBin(c.path)
      }
      result.deleted_count += 1
      result.deleted_size += c.size
      deleted.push(c)
      opts?.onDeleted?.(c)
    } catch (e) {
      result.errors.push(
        `${c.path}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  if (deleted.length) logDeletion(deleted, purge)
  return result
}
