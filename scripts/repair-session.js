#!/usr/bin/env node
/**
 * repair-session.js — validate + repair a dsh session.jsonl.zstd so that it
 * resumes cleanly and produces a provider-valid transcript.
 *
 * Thin CLI wrapper over lib/repair.js (the same core the /session-repair dsh
 * command plugin uses). See lib/repair.js for the full rule set and rationale:
 *   - rewrites invalid agent/inbox/spliced events to the closest valid splice
 *   - drops duplicate/orphaned tool results (keeps the LAST occurrence,
 *     which is the compaction rewrite)
 *   - synthesizes error tool results for assistant tool calls with no result
 *   - renumbers seq, remaps references and replace ranges, strips surface
 *     metadata from non-surface events, rewrites per-line checksummed zstd
 *
 * Usage:
 *   node scripts/repair-session.js <session.jsonl.zstd> [--raw sess-A.jsonl] [--dry-run] [--out file]
 *
 *   --raw        rebuild faithfully from the recovered raw JSONL (preserves
 *                compaction REPLACE semantics); otherwise repairs the current
 *                file in place.
 *   --dry-run    analyze and report only; write nothing.
 *
 * Output: <file>.repaired (new file) + <file>.bak-<ts> (backup of input).
 */
import { repairFile } from '../lib/repair.js'

const args = process.argv.slice(2)
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined }
const FILE = args[0]
const RAW = opt('raw')
const DRY = args.includes('--dry-run')
const OUT = opt('out')
if (!FILE) {
  console.error('usage: node scripts/repair-session.js <session.jsonl.zstd> [--raw sess-A.jsonl] [--dry-run] [--out file]')
  process.exit(2)
}

try {
  const result = repairFile(FILE, { raw: RAW, dryRun: DRY, out: OUT })
  for (const line of result.report) console.log(line)
} catch (error) {
  console.error('FAILED:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
