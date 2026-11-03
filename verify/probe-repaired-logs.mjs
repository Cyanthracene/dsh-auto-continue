/**
 * Replay stored session logs through the kernel's own load-time validator.
 *
 * This is the acceptance test for `verify/repair-legacy-messages.mjs`: it reads
 * each log the way `dsh-session-persistence` reads it — decode every frame, then
 * `adoptSessionEvent()` every record — and reports the first refusal per file.
 * A file this tool accepts is a file DSH can resume.
 *
 * Point `DEEPSEEK_DSH_RUNTIME_PATH` at the kernel package tree (the directory
 * holding `node_modules/@deepseek-ai`) when the default locations miss.
 *
 * Usage: node verify/probe-repaired-logs.mjs <log|session dir> …
 */
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import process from 'node:process'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_NAME = 'session.v4.jsonl.zstd'

/**
 * Walk up from this file looking for an extracted kernel runtime.
 *
 * A fixed `../..` would be wrong: the plugin may sit at a different depth, and
 * climbing a fixed number of levels can land on an unrelated tree. The walk
 * stops at the filesystem root.
 * @returns the first ancestor holding `_kernel-root/dsh`, or undefined.
 */
async function findKernelRootAbove() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, '_kernel-root', 'dsh')
    try {
      await access(candidate, constants.R_OK)
      return candidate
    } catch { /* keep climbing */ }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Locate the kernel's `dsh-session`, so the real validator is used.
 * @returns the kernel module, or a record explaining why it is missing.
 */
async function loadKernelValidator() {
  const override = process.env.DEEPSEEK_DSH_RUNTIME_PATH
  const candidates = []
  if (override !== undefined && override.length > 0) candidates.push(override)
  const above = await findKernelRootAbove()
  if (above !== undefined) candidates.push(above)
  candidates.push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked'))
  for (const root of candidates) {
    if (root === '') continue
    const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
    try {
      await access(pkg, constants.R_OK)
      const imported = await import(pathToFileURL(pkg).href)
      if (typeof imported.adoptSessionEvent === 'function' && imported.KNOWN_SESSION_EVENT_TYPES !== undefined) {
        // The product's own load path: the function that produces the
        // "stored session … failed validation" refusal users see.
        let validateStoredEvents
        try {
          const persistence = await import(pathToFileURL(
            join(root, 'node_modules', '@deepseek-ai', 'dsh-session-persistence', 'lib', 'index.js'),
          ).href)
          if (typeof persistence.validateStoredEvents === 'function') validateStoredEvents = persistence.validateStoredEvents
        } catch { /* optional: event-level validation below still runs */ }
        return { ...imported, validateStoredEvents }
      }
      return { brokenCandidate: pkg }
    } catch { /* next candidate */ }
  }
  return { overridden: override !== undefined && override.length > 0 }
}

/** Decode every frame and return the records, plus any undecodable tail. */
function decode(raw) {
  const offsets = []
  for (let at = raw.indexOf(FRAME_MAGIC); at !== -1; at = raw.indexOf(FRAME_MAGIC, at + 1)) offsets.push(at)
  const records = []
  let badFrames = 0
  let trailing = 0
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
    try {
      for (const line of zstdDecompressSync(raw.subarray(offsets[i], end)).toString('utf8').split('\n')) {
        if (line.trim()) records.push(JSON.parse(line))
      }
    } catch {
      badFrames += 1
      trailing += end - offsets[i]
    }
  }
  return { records, frames: offsets.length, badFrames, trailing }
}

/**
 * Whether one decoded record is the log's header record.
 *
 * The first frame of a session log is a header (`type: "session"`), not an
 * event: the loader reads it as metadata and only validates the events after it.
 */
function isHeaderRecord(record) {
  return record.type === 'session' && record.seq === undefined
}

/**
 * Expand one CLI target into session logs.
 *
 * A file target is accepted only when it *is* a session log. Accepting any file
 * made "point it at the wrong path" print `frames=0 records=0
 * productPath=accepted` and exit 0: with no events to judge, even
 * `validateStoredEvents` accepts, so the run proved nothing while looking green.
 * @param target - log or directory named on the command line.
 * @returns the session logs under it, or throws naming the unusable file target.
 */
async function logsUnder(target) {
  const info = await stat(target)
  if (info.isFile()) {
    if (basename(target) !== LOG_NAME) {
      throw new Error(`${target} is not a ${LOG_NAME} log (a file target must be one)`)
    }
    return [target]
  }
  const found = []
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = join(target, entry.name)
    if (entry.isDirectory()) found.push(...await logsUnder(child))
    else if (entry.isFile() && entry.name === LOG_NAME) found.push(child)
  }
  return found
}

const kernel = await loadKernelValidator()
if (kernel.adoptSessionEvent === undefined) {
  const where = kernel.brokenCandidate !== undefined
    ? `${kernel.brokenCandidate} resolved but exposes no validator`
    : 'kernel runtime not found; set DEEPSEEK_DSH_RUNTIME_PATH to the tree holding node_modules/@deepseek-ai'
  console.error(`FAIL: ${where}`)
  // 2 stays reserved for "you named a runtime that is not there".
  process.exit(kernel.overridden === true && kernel.brokenCandidate === undefined ? 2 : 1)
}

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('usage: node verify/probe-repaired-logs.mjs <log|dir> …')
  process.exit(2)
}

let files = 0
let refused = 0
let continuations = 0
let emptyLogs = 0
const badFrameFiles = []

for (const target of targets) {
  let logs
  try {
    logs = await logsUnder(target)
  } catch (error) {
    console.error(`FAIL: ${String(error?.message ?? error)}`)
    process.exitCode = 2
    continue
  }
  for (const log of logs) {
    const raw = await readFile(log)
    const { records, frames, badFrames, trailing } = decode(raw)
    files += 1
    const sessionId = basename(dirname(log))
    let failure
    let adopted = 0
    let rows = 0
    // An undecodable frame is not a detail to print: the log is append-only, so a
    // frame that will not decompress means the file cannot be read back whole,
    // and a partial trailing frame is the normal shape of a write that was cut
    // short. Either way this is not a file to certify as resumable.
    if (badFrames > 0) {
      badFrameFiles.push(sessionId)
      failure = `${badFrames} frame(s) failed to decompress (${trailing} trailing byte(s))`
    }
    // A log with no events is not a pass: with nothing to judge, the validator
    // accepts, so "0 records, productPath=accepted" is a vacuous green.
    if (failure === undefined && records.length <= 1) {
      emptyLogs += 1
      failure = `no events (${records.length} record(s) decoded)`
    }
    for (const record of records) {
      if (failure !== undefined) break
      if (isHeaderRecord(record)) continue
      const event = record.event ?? record
      if (event.type === 'user/message' && (event.data ?? record.data)?.source?.kind === 'auto-continue') rows += 1
      if (!kernel.KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
        failure = `unknown event type "${event.type}" at seq ${event.seq}`
        break
      }
      try {
        kernel.adoptSessionEvent(event)
        adopted += 1
      } catch (error) {
        failure = `seq ${event.seq} (${event.type}): ${String(error?.message ?? error)}`
        break
      }
    }

    // Product-path check: hand the same records to the loader's own validator,
    // which is the code that raised the user-visible refusal.
    let productPath = 'skipped'
    if (failure === undefined && typeof kernel.validateStoredEvents === 'function') {
      const header = records.find(isHeaderRecord)
      const events = records.filter((r) => !isHeaderRecord(r)).map((r) => r.event ?? r)
      try {
        kernel.validateStoredEvents({ id: header?.id ?? sessionId }, events, log)
        productPath = 'accepted'
      } catch (error) {
        failure = `validateStoredEvents: ${String(error?.message ?? error)}`
        productPath = 'refused'
      }
    }
    continuations += rows
    if (failure === undefined) {
      console.log(`ok     ${sessionId}  frames=${frames} records=${records.length} adopted=${adopted} auto-continue rows=${rows} productPath=${productPath}`)
    } else {
      refused += 1
      console.log(`REFUSE ${sessionId}  ${failure}`)
    }
  }
}

if (files === 0) {
  console.error('FAIL: no ' + LOG_NAME + ' log was found under the given target(s) — nothing was verified')
  process.exitCode = 2
}

if (files > 0) {
  console.log('')
  if (refused === 0) {
    console.log(`OK: ${files} log(s) accepted by the kernel validator; ${continuations} auto-continue row(s) present`)
  } else {
    console.log(`FAILED: ${refused} of ${files} log(s) refused`)
    if (badFrameFiles.length > 0) console.log(`  with undecodable frames: ${badFrameFiles.join(', ')}`)
    if (emptyLogs > 0) console.log(`  with no events: ${emptyLogs}`)
    process.exitCode = 1
  }
}
