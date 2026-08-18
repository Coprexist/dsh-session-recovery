// lib/index.js — dsh plugin entry: registers the /session-repair command so
// the repair toolkit is usable from the dsh web frontend (no SSH needed).
//
// The command mirrors scripts/repair-session.js:
//   /session-repair                          repair the current session
//   /session-repair <session-id-or-path>     repair another session
//   /session-repair --dry-run [target]       analyze only (writes nothing)
//   /session-repair --apply [target]         also overwrite the original file
//
// Safety: by default only a NEW file (<file>.repaired + a backup) is written;
// --apply is refused for the live session hosting the command.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repairFile, resolveTarget, findSessionFile, summarize } from './repair.js'

export const name = 'dsh-session-repair'
export const inject = ['commands']

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// Arrow (not function declaration): cordis 4 treats any apply with a prototype
// as a class constructor and discards its return value (see dsh-mneme).
export const apply = (ctx) => {
  const disposers = []
  if (ctx.commands) {
    disposers.push(ctx.commands.register({
      name: 'session-repair',
      description: '诊断/修复 dsh 会话文件（续接报错：inbox splice / tool 配对）。用法：/session-repair [--dry-run] [--apply] [会话id或路径]',
      input: { hint: '[--dry-run] [--apply] [session-id or path]' },
      handler: async (invocation) => {
        const tokens = (invocation.rawInput || '').trim().split(/\s+/).filter(Boolean)
        const dryRun = tokens.includes('--dry-run')
        const applyFlag = tokens.includes('--apply')
        const target = tokens.filter(t => !t.startsWith('--')).pop() || invocation.agent.session.id
        try {
          const file = resolveTarget(target, dshHome())
          if (!file) {
            return {
              kind: 'error',
              text: `找不到会话文件：${target}\n已搜索 ${path.join(dshHome(), 'sessions')}\n用法：/session-repair [--dry-run] [--apply] [会话id或路径]`,
            }
          }
          const r = repairFile(file, { dryRun })
          const lines = [summarize(r)]
          if (dryRun) {
            lines.push('（仅分析，未写入任何文件）')
          } else {
            lines.push(`修复文件：${r.outFile}`)
            lines.push(`备份文件：${r.backupFile}`)
            if (applyFlag) {
              const currentId = invocation.agent.session.id
              const currentFile = findSessionFile(currentId, dshHome())
              if (currentFile && path.resolve(currentFile) === path.resolve(file)) {
                lines.push('⚠️ 目标是当前正在运行的会话，拒绝覆盖。请从其他会话执行 /session-repair --apply <id>，或停止 dsh 后手动替换。')
              } else {
                fs.copyFileSync(r.outFile, file)
                lines.push('✅ 已覆盖原文件，重启 dsh-web 后生效（systemctl restart dsh-web）')
              }
            } else {
              lines.push('ℹ️ 未覆盖原文件（默认安全）。确认无误后执行 /session-repair --apply <id>，或手动替换。')
            }
          }
          const details = r.report
            .filter(l => /^  \[/.test(l) || /^WARN/.test(l) || /inbox after|verify:|dropped|degraded/.test(l))
            .slice(0, 25)
          if (details.length) lines.push('---', ...details)
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: `修复失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }))
  }
  return () => {
    for (const d of disposers) if (typeof d === 'function') d()
  }
}
