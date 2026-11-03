/**
 * Scan every session log for tonight's window and report, per session: turn/end
 * reasons, any error-ish events, and the tail of the log (an abrupt end is the
 * signature of a crash rather than a clean stop). Read-only.
 *
 * Usage: node verify/tonight.mjs <dsh-home> [sinceIso]
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
    try { return zstdDecompressSync(raw).toString('utf8') } catch { return raw.toString('utf8') }
  }
  const parts = []
  for (let i = 0; i < offsets.length; i++) {
    const slice = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length)
    try { parts.push(zstdDecompressSync(slice).toString('utf8')) } catch { /* partial tail */ }
  }
  return parts.join('\n')
}

const home = process.argv[2]
const since = process.argv[3] ? Date.parse(process.argv[3]) : 0
const sessionsDir = path.join(home, 'sessions')
const out = []

for (const project of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const dir = path.join(sessionsDir, project.name)
  for (const session of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const file = path.join(dir, session.name, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    const stat = fs.statSync(file)
    if (stat.mtimeMs < since) continue
    let text
    try { text = readLog(file) } catch { continue }
    const reasons = new Map()
    const errors = []
    const timeline = []
    let last = null
    let count = 0
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      count++
      const event = record.event ?? record
      const type = String(event.type ?? record.type ?? '')
      const data = event.data ?? record.data ?? {}
      const time = event.time ?? record.time
      last = { type, time }
      if (type === 'turn/end') {
        const k = String(data?.reason?.kind)
        reasons.set(k, (reasons.get(k) ?? 0) + 1)
        timeline.push({ time, text: `turn/end ${k}` })
      }
      if (/error|abort|fail|crash|disposed|interrupt/i.test(type)) {
        errors.push({ time, type, detail: JSON.stringify(data).slice(0, 200) })
      }
    }
    const first = text.split('\n').find((l) => l.trim().length > 0)
    let firstTime = null
    try { firstTime = (JSON.parse(first).event ?? JSON.parse(first)).time } catch { /* ignore */ }
    out.push({
      session: session.name.slice(0, 24),
      bytes: stat.size,
      records: count,
      firstTime,
      lastTime: last?.time ?? null,
      lastType: last?.type ?? null,
      reasons: Object.fromEntries([...reasons].map(([k, v]) => [k || 'none', v])),
      errors: errors.slice(0, 6),
      errorCount: errors.length,
    })
  }
}

out.sort((a, b) => (a.firstTime ?? 0) - (b.firstTime ?? 0))
for (const row of out) {
  const t = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : '--:--:--')
  console.log(`\n=== ${row.session}  ${(row.bytes / 1024).toFixed(0)} KB  ${row.records} records`)
  console.log(`    ${t(row.firstTime)} -> ${t(row.lastTime)}   last=${row.lastType}`)
  console.log(`    endings: ${JSON.stringify(row.reasons)}`)
  console.log(`    errors: ${row.errorCount}`)
  for (const e of row.errors) console.log(`      [${t(e.time)}] ${e.type} ${e.detail}`)
}
console.log(`\nsessions in window: ${out.length}`)
