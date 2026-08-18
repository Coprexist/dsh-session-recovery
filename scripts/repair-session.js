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
 *   node scripts/repair-session.js <session.jsonl.zstd> [--raw sess-A.jsonl] [--dry-run] [--out file] [--compact]
 *
 *   --raw        rebuild faithfully from the recovered raw JSONL (preserves
 *                compaction REPLACE semantics); otherwise repairs the current
 *                file in place.
 *   --dry-run    analyze and report only; write nothing.
 *   --compact    restore compaction semantics: drop messages that a compaction
 *                replace already shadowed (their seqs are recorded in the
 *                surviving event's sourceEventSeqs), shrinking the transcript
 *                back to the compacted view. Use when resume fails with
 *                "maximum context length exceeded".
 *   --max-tokens <N>
 *                fallback guard: after compaction, if the estimated transcript
 *                still exceeds N tokens, trim the OLDEST messages until it
 *                fits (the newest message is always kept). Guarantees a
 *                resumed session can build a request.
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
const COMPACT = args.includes('--compact')
const MAX_TOKENS = opt('max-tokens') === undefined ? undefined : Number(opt('max-tokens'))
if (!FILE) {
  console.error('usage: node scripts/repair-session.js <session.jsonl.zstd> [--raw sess-A.jsonl] [--dry-run] [--out file] [--compact] [--max-tokens N]')
  process.exit(2)
}

try {
  const result = repairFile(FILE, { raw: RAW, dryRun: DRY, out: OUT, compact: COMPACT, maxTokens: MAX_TOKENS })
  for (const line of result.report) console.log(line)
} catch (error) {
  console.error('FAILED:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
