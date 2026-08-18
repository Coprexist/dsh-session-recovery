#!/usr/bin/env node
/**
 * rebuild-session.js — rebuild an official-format dsh session.jsonl.zstd
 * from a JSONL of recovered events (see scan-zstd.js).
 *
 * DSH's session validation rules (see dsh-session-persistence-jsonl + dsh-session):
 *   1. header line first (type:"session"), then one event per line
 *   2. each event's seq must equal its index (contiguous from 0)
 *   3. sourceEventSeqs / messageSeqs must reference events physically earlier
 *   4. surfaceOp must be a string ("append" / "replace" / ...) or a valid object
 *   5. physical encoding: one zstd frame per line, checksummed
 *
 * This script:
 *   - sorts events by time
 *   - renumbers seq to 0..N-1
 *   - deep-fixes every sourceEventSeqs/messageSeqs (drops refs to lost events)
 *   - normalizes object surfaceOp to string "append"
 *   - writes per-line zstd frames with checksum
 *
 * Usage:
 *   node scripts/rebuild-session.js --input events.jsonl --id <session-id> \
 *     --created-at <ms> --cwd <workspace-path> --out-dir <sessions-dir>
 *
 * Writes <out-dir>/<id>/session.jsonl.zstd
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}
const INPUT = arg('input') || arg('i')
const ID = arg('id')
const CREATED_AT = Number(arg('created-at') || arg('createdAt') || Date.now())
const CWD = arg('cwd') || process.cwd()
const OUT_DIR = arg('out-dir') || arg('out') || process.cwd()

if (!INPUT || !ID) {
  console.error('usage: node rebuild-session.js --input <jsonl> --id <session-id> [--created-at <ms>] [--cwd <path>] [--out-dir <dir>]')
  process.exit(2)
}

const lines = fs.readFileSync(INPUT, 'utf8').split('\n').filter(Boolean)
// drop any recovered header line (type:"session") — we rebuild it
const evts = lines.filter(l => { try { return JSON.parse(l).type !== 'session' } catch (e) { return true } })
const parsed = evts.map(l => JSON.parse(l)).sort((a, b) => a.time - b.time)

// pass 1: old seq -> new seq map (contiguous by time order)
const seqMap = new Map()
let seq = 0
for (const j of parsed) { if (typeof j.seq === 'number') { seqMap.set(j.seq, seq); j._newSeq = seq; seq++ } }

let refsDropped = 0, opFixed = 0

/** Deep-walk an event and fix every sourceEventSeqs / messageSeqs array. */
function fixRefs(obj, newIdx) {
  if (!obj || typeof obj !== 'object') return
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if ((k === 'sourceEventSeqs' || k === 'messageSeqs') && Array.isArray(v)) {
      const before = v.length
      obj[k] = v.filter(s => seqMap.has(s) && seqMap.get(s) < newIdx).map(s => seqMap.get(s))
      refsDropped += before - obj[k].length
      if (obj[k].length === 0) delete obj[k]
    } else if (v && typeof v === 'object') {
      fixRefs(v, newIdx)
    }
  }
}

const fixed = parsed.map(j => {
  // surfaceOp: object form -> string "append" (replace semantics need refs we can't guarantee)
  if (j.surfaceOp && typeof j.surfaceOp === 'object') {
    j.surfaceOp = 'append'
    opFixed++
  }
  fixRefs(j, j._newSeq)
  j.seq = j._newSeq
  delete j._newSeq
  return JSON.stringify(j)
})

const header = { type: 'session', version: 0, id: ID, createdAt: CREATED_AT, cwd: CWD, delegationDepth: 0, agentPreset: 'standard' }
const all = [JSON.stringify(header), ...fixed]
const frames = all.map(l => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }))

const dir = path.join(OUT_DIR, ID)
fs.mkdirSync(dir, { recursive: true })
const outFile = path.join(dir, 'session.jsonl.zstd')
fs.writeFileSync(outFile, Buffer.concat(frames))
console.log(`rebuilt ${ID}: ${all.length} lines -> ${outFile} (${(Buffer.concat(frames).length / 1024).toFixed(1)} KB)`)
console.log(`  refs dropped: ${refsDropped}, surfaceOp fixed: ${opFixed}`)
