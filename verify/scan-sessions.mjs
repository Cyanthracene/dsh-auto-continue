/**
 * Scan every session log under a DSH home for the two facts this plugin turns
 * on: turns that ended at the output ceiling, and continuation rows in the
 * transcript. Read-only.
 *
 * Usage:
 *   node verify/scan-sessions.mjs <dsh-home> [--since ISO]
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const FRAME_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

function readLog(target) {
  const raw = fs.readFileSync(target)
  const offsets = []
  for (let at = raw.indexOf(FRAME_MAGIC, 0); at !== -1; at = raw.indexOf(FRAME_MAGIC, at + 4)) offsets.push(at)
  if (offsets.length <= 1) {
    try {
      return zstdDecompressSync(raw).toString('utf8')
    } catch {
      return raw.toString('utf8')
    }
  }
  const parts = []
  for (let i = 0; i < offsets.length; i++) {
    const slice = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length)
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {
      /* trailing partial frame */
    }
  }
  return parts.join('\n')
}

const home = process.argv[2]
const sinceIndex = process.argv.indexOf('--since')
const since = sinceIndex === -1 ? 0 : Date.parse(process.argv[sinceIndex + 1])
if (!home) {
  console.error('usage: node verify/scan-sessions.mjs <dsh-home> [--since ISO]')
  process.exit(2)
}

const roots = new Set()
const sessionsDir = path.join(home, 'sessions')
for (const project of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const dir = path.join(sessionsDir, project.name)
  for (const session of fs.readdirSync(dir, { withFileTypes: true })) {
    if (session.isDirectory()) roots.add(path.join(dir, session.name))
  }
}

let scanned = 0
const findings = []
for (const dir of roots) {
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(file)) continue
  const stat = fs.statSync(file)
  if (stat.mtimeMs < since) continue
  scanned += 1
  let text
  try {
    text = readLog(file)
  } catch (error) {
    console.log(`  ! ${path.basename(dir)}: ${error.message}`)
    continue
  }
  let ceiling = 0
  let autoRows = 0
  let turns = 0
  let humans = 0
  const endings = new Map()
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const event = record.event ?? record
    const type = event.type ?? record.type
    const data = event.data ?? record.data ?? {}
    if (type === 'turn/start') turns += 1
    if (type === 'turn/end') {
      const kind = data?.reason?.kind ?? '(none)'
      endings.set(kind, (endings.get(kind) ?? 0) + 1)
      if (kind === 'max-tokens') ceiling += 1
    }
    if (type === 'user/message') {
      if (data?.source?.kind === 'user') humans += 1
      if (data?.source?.kind === 'auto-continue') autoRows += 1
    }
  }
  findings.push({ id: path.basename(dir), mtime: stat.mtime, turns, humans, ceiling, autoRows, endings })
}

findings.sort((a, b) => b.mtime - a.mtime)
console.log(`scanned ${scanned} session log(s) under ${sessionsDir}\n`)
console.log('mtime             turns  human  CEILING  auto-continue  session')
for (const row of findings) {
  console.log(
    `${row.mtime.toISOString().slice(5, 16).replace('T', ' ')}  ${String(row.turns).padStart(5)}  ${String(row.humans).padStart(5)}  ${String(row.ceiling).padStart(7)}  ${String(row.autoRows).padStart(13)}  ${row.id}`,
  )
}
const totalCeiling = findings.reduce((sum, row) => sum + row.ceiling, 0)
const totalAuto = findings.reduce((sum, row) => sum + row.autoRows, 0)
console.log(`\ntotals: ceiling endings=${totalCeiling}  auto-continue rows=${totalAuto}`)
