/**
 * Measure, for every session log, the gap between a turn/end and the next
 * turn/start, split by the ending reason. Read-only.
 *
 * Usage: node verify/gap-stats.mjs <dsh-home>
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
const rows = []
const sessionsDir = path.join(home, 'sessions')
for (const project of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const dir = path.join(sessionsDir, project.name)
  for (const session of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const file = path.join(dir, session.name, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    let text
    try { text = readLog(file) } catch { continue }
    const events = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      const event = record.event ?? record
      const type = event.type ?? record.type
      const data = event.data ?? record.data ?? {}
      const time = event.time ?? record.time
      if ((type === 'turn/end' || type === 'turn/start' || type === 'user/message') && typeof time === 'number') {
        events.push({ type, time, reason: data?.reason?.kind, source: data?.source?.kind, turn: data?.turn, seq: event.seq })
      }
      if (type === 'agent/inbox/spliced' && typeof time === 'number') {
        events.push({ type, time, inserted: (data?.inserted ?? []).map((m) => m?.source?.kind).join(','), target: data?.target, start: data?.start, seq: event.seq })
      }
    }
    // pair each turn/end with the next turn/start after it
    for (let i = 0; i < events.length; i++) {
      if (events[i].type !== 'turn/end') continue
      let nextIndex = -1
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].type === 'turn/start') { nextIndex = j; break }
      }
      if (nextIndex === -1) continue
      const next = events[nextIndex]
      // Was there a followup splice between the ending and that start, and when?
      //
      // Scan by *index*, not by `events.indexOf(next)`: `next` is an element of a
      // freshly built array and `indexOf` compares object identity, so the search
      // range was always empty and every row reported a null wait — which made
      // the one column this tool exists for permanently blank. The slice is
      // `i + 1 .. nextIndex` because the ending itself must not match.
      const splice = events
        .slice(i + 1, nextIndex)
        .find((e) => e.type === 'agent/inbox/spliced' && e.inserted === 'auto-continue')
      rows.push({
        session: session.name.slice(0, 12),
        reason: events[i].reason,
        turn: events[i].turn,
        gapMs: next.time - events[i].time,
        // splice -> turn/start gap: how long the queued continuation waited
        waitMs: splice === undefined ? null : next.time - splice.time,
        // how long the plugin took to get the continuation into the inbox at all
        armMs: splice === undefined ? null : splice.time - events[i].time,
        startPos: splice?.start,
      })
    }
  }
}

// Only two kinds of row are worth printing: an ending that hit the ceiling (the
// plugin's trigger), and any ending that got a continuation. Everything else is
// an ordinary human turn, and there are thousands of those — enough to bury the
// handful of rows this tool exists to show.
const interesting = rows.filter((r) => r.reason === 'max-tokens' || r.waitMs !== null)
interesting.sort((a, b) => (b.waitMs ?? -1) - (a.waitMs ?? -1))
console.log('endReason    turn   arm(end->splice)  queueWait(splice->start)  gap(end->start)  startPos  session')
for (const row of interesting) {
  console.log(
    `${String(row.reason).padEnd(12)} ${String(row.turn ?? '-').padStart(4)}   ${String(row.armMs ?? '-').padStart(14)}  ${String(row.waitMs ?? '-').padStart(22)}  ${String(row.gapMs).padStart(14)}  ${String(row.startPos ?? '-').padStart(8)}  ${row.session}`,
  )
}
const waits = rows.filter((r) => r.waitMs !== null).map((r) => r.waitMs)
if (waits.length === 0) {
  console.log('\nauto-continue queue waits: none found in these logs')
} else {
  console.log(`\nauto-continue queue waits: n=${waits.length} min=${Math.min(...waits)} max=${Math.max(...waits)}`)
}
const ceilings = rows.filter((r) => r.reason === 'max-tokens')
console.log(`ceiling endings followed by a turn: n=${ceilings.length}`)
console.log(`  of those, a continuation was queued: ${ceilings.filter((r) => r.waitMs !== null).length}`)
// The stall this tool was written to catch: the plugin queued it, but nothing
// opened the next turn until something unrelated did.
const stalled = ceilings.filter((r) => (r.waitMs ?? -1) > 5000)
console.log(`  of those, queue wait > 5000 ms: ${stalled.length}`)
for (const row of stalled) {
  console.log(`    turn ${row.turn} waited ${row.waitMs} ms  (${row.session})`)
}
