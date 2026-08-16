#!/usr/bin/env node
/**
 * split-sessions.js — split a mixed stream of recovered dsh events (from
 * scan-zstd.js) into per-session JSONL files.
 *
 * Problem: after `rm -rf ~/.dsh`, the surviving zstd frames of MULTIPLE
 * session logs may sit adjacent on disk, so scan-zstd.js emits them as one
 * blob. Sessions are separated by:
 *
 *   1. `turn` resets — a `turn/start` whose turn number <= the previous
 *      turn means a new session (or a compaction restart) began there;
 *   2. large time gaps (optional, default off) — e.g. overnight pauses.
 *
 * A session boundary is placed at the FIRST event whose time is >= the
 * chosen boundary time; all earlier events go to the previous file.
 *
 * Usage:
 *   node split-sessions.js <events.jsonl> <boundary-iso-time> \
 *     [--out-dir DIR] [--prefix NAME]
 *
 * Example:
 *   node split-sessions.js /tmp/session-events.jsonl 2026-08-16T07:05:06Z
 *
 * Outputs: <out-dir>/<prefix>-A.jsonl, -B.jsonl, ... (sorted by boundary)
 */
'use strict'
const fs = require('fs')
const path = require('path')

const INPUT = process.argv[2]
const BOUNDARY = process.argv[3]
if (!INPUT || !BOUNDARY) {
  console.error('usage: node split-sessions.js <events.jsonl> <boundary-iso-time> [--out-dir DIR] [--prefix NAME]')
  process.exit(2)
}
const arg = name => { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined }
const OUT_DIR = arg('out-dir') || '.'
const PREFIX = arg('prefix') || 'sess'

const boundaryMs = Date.parse(BOUNDARY)
if (Number.isNaN(boundaryMs)) { console.error('invalid boundary time:', BOUNDARY); process.exit(2) }
fs.mkdirSync(OUT_DIR, { recursive: true })

const lines = fs.readFileSync(INPUT, 'utf8').split('\n').filter(Boolean)
const evts = []
for (const l of lines) {
  try { const j = JSON.parse(l); if (j && typeof j.time === 'number') evts.push(j) } catch (e) { /* skip */ }
}

// find turn resets as candidate boundaries, pick the one closest to the given time
const turns = evts.filter(j => j.type === 'turn/start' && j.data && typeof j.data.turn === 'number')
  .sort((a, b) => a.time - b.time)
let prev = null
const resets = []
for (const t of turns) {
  if (prev !== null && t.data.turn <= prev) resets.push(t)
  prev = t.data.turn
}
if (!resets.length) {
  console.error('no turn reset found — falling back to given time boundary only')
}
const boundary = resets.length
  ? resets.reduce((best, r) => Math.abs(r.time - boundaryMs) < Math.abs(best.time - boundaryMs) ? r : best, resets[0])
  : { time: boundaryMs }
console.error('boundary event:', new Date(boundary.time).toISOString(), 'turn', boundary.data && boundary.data.turn)

const A = evts.filter(j => j.time < boundary.time)
const B = evts.filter(j => j.time >= boundary.time)
const fileA = path.join(OUT_DIR, `${PREFIX}-A.jsonl`)
const fileB = path.join(OUT_DIR, `${PREFIX}-B.jsonl`)
fs.writeFileSync(fileA, A.map(j => JSON.stringify(j)).join('\n') + '\n')
fs.writeFileSync(fileB, B.map(j => JSON.stringify(j)).join('\n') + '\n')
console.log(`session A (before boundary): ${A.length} lines -> ${fileA}`)
console.log(`session B (after boundary):  ${B.length} lines -> ${fileB}`)
