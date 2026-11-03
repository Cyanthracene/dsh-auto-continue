/**
 * Repair stored `user/message` rows this plugin wrote without an identity.
 *
 * ## What it fixes
 *
 * Before the `id`/`role` fix in `lib/index.js`, `continuationMessage()` returned
 * `{ content, source }`, so every auto-continue row landed in the durable log
 * without `id` and without `role`. The kernel validates stored events on load
 * (`adoptSessionEvent()` via `dsh-session-persistence`'s `validateStoredEvents`)
 * and refuses such a session outright:
 *
 *     stored session "session-…" failed validation:
 *     Error: session event at seq 68 lacks an identified message
 *
 * This tool rewrites only those rows: it adds a fresh `id` and `role: "user"`,
 * leaves every other byte of every other frame untouched, and re-compresses only
 * the frames it changed.
 *
 * ## Safety
 *
 *  - Every log is copied to `<rollback dir>/<session id>.session.v4.jsonl.zstd`
 *    **before** the original is replaced; the original is only replaced after the
 *    whole repaired file is written next to it.
 *  - `--dry-run` decodes and reports without writing anything.
 *  - The write is a same-directory rename, so a crash mid-run leaves either the
 *    old file or the new one, never a half-written log.
 *  - Verify with `verify/probe-repaired-logs.mjs`, which replays the repaired
 *    files through the kernel's own validator.
 *
 * ## Usage
 *
 * ```sh
 * node tools/repair-sessions.mjs --dry-run <log|session dir> …
 * node tools/repair-sessions.mjs <log|session dir> …
 * ```
 *
 * A directory argument is walked for `session.v4.jsonl.zstd`. Backups are written
 * to `<workspace>/_dsh-auto-continue-backups/<session>.<timestamp>.session.v4.jsonl.zstd`,
 * or to `DSH_AUTO_CONTINUE_ROLLBACK_DIR` when that is set; an existing backup is
 * never overwritten.
 */
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import process from 'node:process'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_NAME = 'session.v4.jsonl.zstd'

/** Fields the kernel's `user/message` validation requires of an identified message. */
const SOURCE_KIND = 'auto-continue'

// ── frame plumbing ──────────────────────────────────────────────────────────

/** Offsets of every zstd frame in a multi-frame log. */
function frameOffsets(raw) {
  const offsets = []
  for (let at = raw.indexOf(FRAME_MAGIC); at !== -1; at = raw.indexOf(FRAME_MAGIC, at + 1)) offsets.push(at)
  return offsets
}

/**
 * Split a log into its frames, keeping the bytes of frames that decode cleanly.
 * A trailing partial frame (a crash mid-write) is preserved verbatim.
 */
function splitFrames(raw) {
  const offsets = frameOffsets(raw)
  const frames = []
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
    const slice = raw.subarray(start, end)
    let text
    try {
      text = zstdDecompressSync(slice).toString('utf8')
    } catch {
      text = undefined
    }
    frames.push({ start, end, slice, text })
  }
  return frames
}

/**
 * Rewrite one frame's records. Returns the re-compressed bytes and how many
 * rows were repaired, or undefined when the frame is already clean.
 */
function repairFrame(text) {
  const lines = text.split('\n')
  let changed = false
  let rows = 0
  const repaired = lines.map((line) => {
    if (line.trim().length === 0) return line
    let record
    try {
      record = JSON.parse(line)
    } catch {
      return line
    }
    const event = record.event ?? record
    if (event.type !== 'user/message') return line
    const data = event.data ?? record.data
    if (data === undefined || data === null || typeof data !== 'object') return line
    if (data.source?.kind !== SOURCE_KIND) return line
    const missingId = typeof data.id !== 'string' || data.id === ''
    const missingRole = data.role !== 'user'
    if (!missingId && !missingRole) return line
    if (missingId) data.id = randomUUID()
    if (missingRole) data.role = 'user'
    changed = true
    rows += 1
    return JSON.stringify(record)
  })
  if (!changed) return undefined
  return { bytes: zstdCompressSync(Buffer.from(repaired.join('\n'), 'utf8')), rows }
}

// ── target discovery ────────────────────────────────────────────────────────

/** Expand a CLI target into the session logs it names. */
async function logsUnder(target) {
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) throw new Error(`no such path: ${target}`)
  if (info.isFile()) return [resolve(target)]
  const found = []
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = join(target, entry.name)
    if (entry.isDirectory()) found.push(...await logsUnder(child))
    else if (entry.isFile() && entry.name === LOG_NAME) found.push(resolve(child))
  }
  return found
}

// ── main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const targets = argv.filter((a) => a !== '--dry-run')

if (targets.length === 0) {
  console.error('usage: node tools/repair-sessions.mjs [--dry-run] <log|dir> …')
  process.exit(2)
}

/**
 * Where the pre-repair copies go.
 *
 * Chosen by walking up to the development workspace rather than by counting
 * `..` segments, so the tool keeps its backups next to the checkout no matter
 * which directory it is invoked from. `DSH_AUTO_CONTINUE_ROLLBACK_DIR` overrides
 * it, and the fallback is the user's own home so a copy inside a read-only
 * install still has somewhere to write.
 */
function defaultRollbackDir() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    // The development workspace is recognisable by either of these siblings.
    for (const marker of ['_kernel-root', '_dsh-auto-continue-backups']) {
      try {
        if (existsSync(join(dir, marker))) return join(dir, '_dsh-auto-continue-backups')
      } catch { /* keep climbing */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(homedir(), '.dsh-auto-continue-backups')
}

const rollbackDir = process.env.DSH_AUTO_CONTINUE_ROLLBACK_DIR ?? defaultRollbackDir()
const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')

let repairedFiles = 0
let repairedRows = 0
let cleanFiles = 0

for (const target of targets) {
  for (const log of await logsUnder(target)) {
    const raw = await readFile(log)
    const frames = splitFrames(raw)
    const sessionId = basename(dirname(log))
    let rows = 0
    let rebuilt = []
    let changedFrames = 0

    for (const frame of frames) {
      if (frame.text === undefined) {
        rebuilt.push(frame.slice)
        continue
      }
      const outcome = repairFrame(frame.text)
      if (outcome === undefined) {
        rebuilt.push(frame.slice)
        continue
      }
      rows += outcome.rows
      changedFrames += 1
      rebuilt.push(outcome.bytes)
    }

    if (rows === 0) {
      cleanFiles += 1
      console.log(`clean  ${sessionId}  (${frames.length} frames, nothing to repair)`)
      continue
    }

    console.log(`REPAIR ${sessionId}  frames ${changedFrames}/${frames.length}, rows ${rows}  ${log}`)
    if (dryRun) continue

    await mkdir(rollbackDir, { recursive: true })
    // The backup is stamped, and never overwritten. A fixed name meant a second
    // run copied the *already repaired* file over the pre-repair original, which
    // is the one artifact this tool exists to preserve.
    let backup = join(rollbackDir, `${sessionId}.${stamp}.session.v4.jsonl.zstd`)
    for (let attempt = 1; existsSync(backup); attempt++) {
      backup = join(rollbackDir, `${sessionId}.${stamp}.${attempt}.session.v4.jsonl.zstd`)
    }
    await copyFile(log, backup)
    const staged = `${log}.repaired-${stamp}`
    await writeFile(staged, Buffer.concat(rebuilt))
    await rename(staged, log)
    console.log(`       backup -> ${backup}`)
    repairedFiles += 1
    repairedRows += rows
  }
}

console.log('')
console.log(dryRun
  ? `dry run: ${cleanFiles} clean, would repair rows in the files marked REPAIR`
  : `done: ${repairedFiles} file(s) repaired (${repairedRows} rows), ${cleanFiles} already clean`)
