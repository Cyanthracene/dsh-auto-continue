/**
 * Regression locks for two defects found in the wake loop of lib/index.js, run
 * against the real plugin (not a re-implementation).
 *
 * Every assertion here carries a positive control. Without one, the cheapest way
 * to satisfy "no stale timer handles" is to delete the wake loop entirely, and
 * the cheapest way to satisfy "no throw escaped" is to never poll — so each
 * defect check is paired with a check that the loop actually ran and actually
 * delivered the continuation.
 *
 * ## Defect A — the wake loop deleted the wrong timer handle
 *
 * `runWake()`'s `poll` did `state.timers.delete(timeout)`, where `timeout` was the
 * single handle `runWake` itself created. Every handle the loop rescheduled was
 * added to `state.timers` but never deleted, so the set accumulated one
 * already-fired handle per poll (measured: 13 stale handles after 14 schedules).
 * Because `runWake` reads `size > 0` as "a loop is already running", a poll that
 * exited before rescheduling left the set non-empty with no live timer, and the
 * loop could never be restarted for that agent — auto-continue would go silently
 * dead for the session. Locked by: stale-handle count is zero, and a wake armed
 * after a failed poll still delivers.
 *
 * ## Defect B — a throw escaped the timer callback
 *
 * The plugin's own comment says "nothing may escape a timer callback, which would
 * take the process down", but only the inner per-wake block was wrapped. A throw
 * from `agent.status` — read on the `due.length > 0 && agent.status === 'idle'`
 * test — left `poll` with no catch at all, and an `uncaughtException` in a timer
 * callback terminates the host process. Locked by: zero escapes, the failure is
 * reported, and the state is left able to arm the next wake.
 *
 * Usage: node verify/probe-defects.mjs
 */
import process from 'node:process'

const mod = await import('../lib/index.js')

// ── assertions ──────────────────────────────────────────────────────────────

let checks = 0
let failures = 0

function check(label, condition, detail) {
  checks++
  if (condition) {
    console.log(`  ok   ${label}${detail === undefined ? '' : `   [${detail}]`}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : `   [${detail}]`}`)
  }
}

// ── instrument the timer layer ──────────────────────────────────────────────

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

/** handle -> true once the callback has run. */
const fired = new Set()
let created = 0
let staleClears = 0

globalThis.setTimeout = (fn, ms, ...rest) => {
  const handle = realSetTimeout(() => {
    fired.add(handle)
    return fn(...rest)
  }, ms)
  created++
  return handle
}
globalThis.clearTimeout = (handle) => {
  // A handle cleared *after* it already ran is proof the loop held a reference it
  // should have dropped when that poll fired.
  if (fired.has(handle)) staleClears++
  return realClearTimeout(handle)
}

const resetTimers = () => {
  created = 0
  staleClears = 0
}

// ── a minimal host, shaped like the real services the plugin consumes ───────

function makeHost() {
  const listeners = { session: [], disposed: [] }
  const session = { id: 'session-1', header: { id: 'session-1', isSeeded: false, version: 1, createdAt: 0 } }
  let statusReads = 0
  let statusThrows = false
  let status = 'idle'
  const followups = []
  const agent = {
    id: 'session-1',
    session,
    get status() {
      statusReads++
      if (statusThrows && statusReads > 1) throw new Error('probe: status getter exploded')
      return status
    },
    inbox: { nextTurn: [], nextStep: [] },
    followup(payload) {
      this.inbox.nextTurn.push(payload)
      followups.push(payload)
    },
  }
  const logger = { warnings: [], warn(line) { this.warnings.push(String(line)) } }
  const ctx = {
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
    sessions: { list: () => [session] },
    logger,
    on(type, handler) {
      if (type === 'session/event') listeners.session.push(handler)
      if (type === 'agent/disposed') listeners.disposed.push(handler)
    },
    effect(generator) {
      const iterator = generator()
      let step = iterator.next()
      const cleanups = []
      while (!step.done) {
        if (typeof step.value === 'function') cleanups.push(step.value)
        step = iterator.next()
      }
      return { dispose: () => cleanups.forEach((f) => f()) }
    },
  }
  return {
    ctx,
    session,
    logger,
    followups,
    get statusReads() { return statusReads },
    setStatus(value) { status = value },
    armStatusThrow(value) { statusThrows = value },
    append(event) {
      for (const handler of [...listeners.session]) handler(session, event)
    },
    dispose() {
      for (const handler of [...listeners.disposed]) handler({ agent })
    },
  }
}

const wait = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const ceiling = (turn) => ({ type: 'turn/end', seq: turn, data: { turn, reason: { kind: 'max-tokens' } } })

// ── Defect A: the loop must delete its own handle, and must not wedge ───────

async function lockTimerBookkeeping() {
  console.log('Defect A — the wake loop deletes its own timer handle')
  // `delayMs` keeps the wake from being due, forcing the loop to poll (and so
  // reschedule) many times before it may send. One reschedule = one handle.
  const host = makeHost()
  resetTimers()
  mod.apply(host.ctx, { enabled: true, promptText: 'continue', maxContinues: 5, delayMs: 400 })
  host.append(ceiling(1))
  await wait(700)

  check('the wake loop really polled more than once', created >= 3, `timers created = ${created}`)
  check('the delayed continuation was delivered exactly once', host.followups.length === 1,
    `followups = ${host.followups.length}`)
  check('no already-fired handle was left in state.timers', staleClears === 0,
    `stale clears = ${staleClears}`)
  host.dispose()
}

// ── Defect B: a throw must not escape, and must not wedge the state ─────────

async function lockTimerCallbackGuard() {
  console.log('\nDefect B — a throw inside a poll is contained, and does not wedge the state')
  const escaped = []
  const restore = process.listeners('uncaughtException')
  for (const l of restore) process.removeListener('uncaughtException', l)
  process.on('uncaughtException', (error) => { escaped.push(error) })

  const host = makeHost()
  try {
    mod.apply(host.ctx, { enabled: true, promptText: 'continue', maxContinues: 5, delayMs: 0 })
    // Keep the driver busy so the `due.length > 0 && agent.status === 'idle'` test
    // is reached and reads `agent.status` on a poll after the first one.
    host.setStatus('running')
    host.armStatusThrow(true)
    host.append(ceiling(1))
    await wait(150)
  } finally {
    process.removeAllListeners('uncaughtException')
    for (const l of restore) process.on('uncaughtException', l)
  }

  check('the due/idle branch was reached (proves the loop ran)', host.statusReads >= 2,
    `status reads = ${host.statusReads}`)
  check('the throw did not escape the timer callback', escaped.length === 0,
    escaped.length === 0 ? 'contained' : escaped[0].message)
  check('the failure was reported through the logger',
    host.logger.warnings.some((w) => w.includes('wake loop failed')),
    host.logger.warnings.length === 0 ? 'no warnings' : host.logger.warnings[0].slice(0, 60))

  // The severe consequence of Defect A: if the failed poll left `state.timers`
  // non-empty with no live timer, `runWake` would early-return forever and no
  // later ceiling could ever be continued for this agent.
  host.armStatusThrow(false)
  host.setStatus('idle')
  host.append(ceiling(2))
  await wait(150)
  check('a later ceiling still arms a continuation after the failed poll',
    host.followups.length === 1, `followups = ${host.followups.length}`)
  host.dispose()
}

await lockTimerBookkeeping()
await lockTimerCallbackGuard()

console.log('\n' + '='.repeat(72))
if (failures === 0) {
  console.log(`OK: all ${checks} locks held`)
} else {
  console.log(`FAILED: ${failures} of ${checks} locks broke — a defect has regressed`)
}
process.exitCode = failures === 0 ? 0 : 1
