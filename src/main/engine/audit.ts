import fs from 'fs'
import os from 'os'
import path from 'path'
import { type CleanCandidate } from './model'

/** 审计日志目录：`%LOCALAPPDATA%/GrClean`（独立于所有清理规则，不可被触及）。 */
function grcleanDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(base, 'GrClean')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 审计日志路径：`%LOCALAPPDATA%/GrClean/audit.jsonl` */
function auditPath(): string {
  return path.join(grcleanDir(), 'audit.jsonl')
}

function append(entry: unknown): void {
  try {
    fs.appendFileSync(auditPath(), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* 审计失败不阻断主流程 */
  }
}

/** 追加写入一条删除审计记录（JSONL，每行一条）。 */
export function logDeletion(items: CleanCandidate[], purge: boolean): void {
  append({
    ts: Date.now(),
    action: purge ? 'purge' : 'trash',
    count: items.length,
    items: items.map((c) => c.path),
  })
}

/** 追加写入一条卸载触发审计记录（JSONL，每行一条）。 */
export function logUninstall(id: string, command: string): void {
  append({ ts: Date.now(), action: 'uninstall', id, command })
}
