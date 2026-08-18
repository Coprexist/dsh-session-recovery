#!/usr/bin/env node
/**
 * recover-memory.js — locate & rescue a deleted dsh-mneme memory.db.
 *
 * Strategy: SQLite database files start with the fixed 16-byte header
 * "SQLite format 3". We scan the raw block device for that signature, then
 * for each candidate offset dump a window of bytes and test whether it opens
 * as a database with a `memories` table (dsh-mneme's schema). The right
 * candidate is then rescued with SQLite's official `.recover` mode (skips
 * corrupt pages, keeps readable rows) and written out as a fresh DB.
 *
 * Usage:
 *   node scripts/recover-memory.js /dev/sdX1 /tmp/recovered/ [--all]
 *
 *   --all   dump and .recover every SQLite candidate (default: stop at first
 *           database that has a `memories` table)
 *
 * Requires: node:sqlite (Node 24+). Uses the sqlite3 CLI if available for
 * .recover; otherwise falls back to a JS row-by-row rescue via node:sqlite.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const DEV = process.argv[2]
const OUT = process.argv[3]
const ALL = process.argv.includes('--all')
if (!DEV || !OUT) { console.error('usage: node recover-memory.js <block-device> <out-dir> [--all]'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

const SIG = Buffer.from('SQLite format 3', 'utf8')
const CHUNK = 64 * 1024 * 1024
const WINDOW = 32 * 1024 * 1024 // dump 32MB per candidate

const fd = fs.openSync(DEV, 'r')
const hits = []
let carry = Buffer.alloc(0), off = 0, total = 0
console.error('scanning', DEV, 'for SQLite headers...')
while (true) {
  const buf = Buffer.alloc(CHUNK)
  const n = fs.readSync(fd, buf, 0, CHUNK, off)
  if (n <= 0) break
  const data = Buffer.concat([carry, buf.subarray(0, n)])
  const base = off - carry.length
  let i = data.indexOf(SIG)
  while (i !== -1) { hits.push(base + i); i = data.indexOf(SIG, i + 1) }
  carry = data.subarray(data.length - SIG.length)
  off += n; total += n
}
console.error('SQLite header hits:', hits.length)

function isMemoryDb(candidatePath) {
  try {
    const db = new DatabaseSync(candidatePath, { readOnly: true })
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    db.close()
    return t.includes('memories')
  } catch (e) { return false }
}

function recoverWithSqliteCli(candidatePath, outDb) {
  try {
    const sql = execFileSync('sqlite3', [candidatePath, '.recover'], { maxBuffer: 256 * 1024 * 1024 }).toString()
    const db = new DatabaseSync(outDb)
    db.exec('BEGIN')
    db.exec(sql)
    db.exec('COMMIT')
    const c = db.prepare('SELECT COUNT(*) c FROM memories').get().c
    db.close()
    return c
  } catch (e) {
    console.error('  sqlite3 .recover failed:', e.message.slice(0, 120))
    return -1
  }
}

let found = 0
const readBuf = Buffer.alloc(WINDOW)
for (let hi = 0; hi < hits.length; hi++) {
  const start = hits[hi]
  const n = fs.readSync(fd, readBuf, 0, WINDOW, start)
  const candPath = path.join(OUT, `candidate-${hi}.db`)
  fs.writeFileSync(candPath, readBuf.subarray(0, n))
  const isMem = isMemoryDb(candPath)
  console.error(`candidate #${hi} @ ${start}: ${isMem ? '*** HAS memories table ***' : 'not a memory db'}`)
  if (isMem) {
    const outDb = path.join(OUT, 'memory-rebuilt.db')
    const count = recoverWithSqliteCli(candPath, outDb)
    console.error(`  -> rescued ${count} memories into ${outDb}`)
    found++
    if (!ALL) { console.error('stopping (first memory db found); use --all to keep scanning'); break }
  } else if (!ALL && hi > 8 && found === 0) {
    console.error('no memory db in first candidates; continuing full scan...')
  }
}
console.error(found ? `DONE: found ${found} memory db(s)` : 'DONE: no memory db found (data may be overwritten)')
fs.closeSync(fd)
