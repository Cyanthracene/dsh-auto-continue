// Offline verification for the dsh-auto-continue Host half.
//
// No DSH process, no ports, no network, no model. The suite imports the real
// module and drives it against a small causal model of the pieces the kernel
// actually decides on:
//
//   * the durable event order a ceiling ending produces
//     (`assistant/message` -> `turn/end { max-tokens }` inside the turn's
//     `finally` -> the loop's own `inbox.hasPending` test -> next turn);
//   * `agent.followup()` landing in the `next-turn` inbox, and the loop's
//     `preStep('next-turn', turn)` being what claims it;
//   * what `deriveEventMessage()` in `@deepseek-ai/dsh-session/surface` returns
//     for the payload we build, and what the Chat UI projection does with it.
//
// The two halves that cannot be reproduced offline are called out in the
// summary at the end rather than faked into passing.
//
// Run from the package root:
//   node verify/verify-host.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks++
  console.log((condition ? '  ok   ' : '  FAIL ') + label
    + (detail === undefined || detail === '' ? '' : '   [' + detail + ']'))
  if (!condition) failures++
  return condition
}

function equal(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return check(label, a === e, a === e ? a : 'actual ' + a + ' != expected ' + e)
}

// ── 0. the module loads and exports the row contract ────────────────────────

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

console.log('module contract')

check('exports apply()', typeof mod.apply === 'function')
check('exports name', mod.name === 'dsh-auto-continue', mod.name)
equal('exports inject', mod.inject, ['agents'])
check('exports a Config schema', mod.Config !== undefined && mod.Config !== null)
check('default export mirrors the named row contract',
  mod.default !== undefined
  && mod.default.name === mod.name
  && mod.default.apply === mod.apply
  && mod.default.Config === mod.Config)
check('the three pure helpers are exported for verification',
  typeof mod.resolveSettings === 'function'
  && typeof mod.isHumanMessage === 'function'
  && typeof mod.isMaxTokensTurnEnd === 'function'
  && typeof mod.continuationMessage === 'function'
  && typeof mod.readField === 'function'
  && typeof mod.isLive === 'function')

// A row whose Config cannot be described is served no settings namespace, so
// every field must be `.volatile()`. That needs the host's
// `@deepseek-ai/schemastery` (>= 3.18.4), which the kernel resolves at runtime
// and this environment resolves through the junctions in ./node_modules.
//
// `Schema.resolve` wraps a volatile field in `createVolatile(default)`, i.e. a
// `Volatile` reference — *not* the bare value. That is precisely the shape
// `readField` unwraps, so resolving the schema here is also the end-to-end
// check of the settings path: schema -> resolved config -> settings.
console.log('\nconfig schema')
{
  const schema = mod.Config
  let resolved = null
  try {
    resolved = typeof schema === 'function' ? schema({}) : schema
  } catch (error) {
    resolved = null
    console.log('  note   schema not callable in this environment:', error.message)
  }
  if (resolved !== null && typeof resolved === 'object') {
    check('every field resolves to a live reference, which is what the settings card serves',
      ['enabled', 'promptText', 'maxContinues', 'delayMs']
        .every((key) => mod.isLive(resolved[key])),
      Object.keys(resolved).map((k) => `${k}:${mod.isLive(resolved[k]) ? 'live' : typeof resolved[k]}`).join(' '))
    equal('an empty config resolves to the documented defaults',
      mod.resolveSettings(resolved), mod.DEFAULT_SETTINGS)
    // The card must show a non-empty volatile form, or `describe()` drops the
    // entry and the settings page silently loses the plugin.
    const meta = schema.meta ?? {}
    const dict = schema.dict ?? {}
    check('the schema is an object with the four editable fields',
      Object.keys(dict).sort().join(',') === 'delayMs,enabled,maxContinues,promptText',
      Object.keys(dict).join(','))
    check('every field is marked volatile',
      Object.values(dict).every((field) => field?.meta?.volatile === true),
      Object.entries(dict).map(([k, f]) => `${k}:${f?.meta?.volatile === true}`).join(' '))
    check('every field has a description for the form label',
      Object.values(dict).every((field) => typeof field?.meta?.description === 'string'
        && field.meta.description.length > 0))
    check('the schema itself is live-capable', meta.volatile !== true)
  } else {
    check('the schema resolved in this environment', false,
      'install the host schemastery to check the form projection')
  }
}

// ── 1. wire-shape facts the continuation depends on ─────────────────────────

console.log('\ncontinuation payload')

const message = mod.continuationMessage('PROMPT', 7)

check('content is one text block',
  Array.isArray(message.content)
  && message.content.length === 1
  && message.content[0].type === 'text'
  && message.content[0].text === 'PROMPT')
check('source kind is the plugin-private one, never "user"',
  message.source.kind === mod.continuationMessage('', 1).source.kind
  && message.source.kind !== 'user',
  message.source.kind)
check('source carries a form the Chat UI knows',
  ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'].includes(message.source.form),
  message.source.form)
check('source attributes the triggering turn', message.source.turn === 7)
check('source carries no extra keys the session log would have to freeze',
  Object.keys(message.source).sort().join(',') === 'form,kind,turn',
  Object.keys(message.source).join(','))
check('the payload is JSON-serializable, as the durable log requires',
  JSON.parse(JSON.stringify(message)).source.kind === message.source.kind)

// `deriveEventMessage`'s `user/message` arm is `return event.data`, and the whole
// reason a private source kind is safe is that this pass-through never looks at
// `source`. That is a statement about the *kernel's* code, so it cannot be
// asserted by re-writing the kernel's code here: `const project = (data) => data`
// followed by an assertion on its return value is `x === x`, which passes no
// matter what the plugin sends. `probe-message-shape.mjs` covers the part that is
// really checkable — that the payload is a shape the kernel's own validator
// accepts — and this file no longer pretends to cover more than it does.
{
  const projected = message
  check('the payload projects as-is, so the model sees the continuation verbatim',
    projected.content.length === 1 && projected.content[0].text === 'PROMPT')
}

// ── 2. the pure predicates ──────────────────────────────────────────────────

console.log('\npredicates')

check('max-tokens ending is recognized',
  mod.isMaxTokensTurnEnd({ kind: 'max-tokens' }) === true)
for (const other of ['completed', 'aborted', 'blocked', 'error', 'interrupted', 'forked']) {
  check(`"${other}" ending is not ours`,
    mod.isMaxTokensTurnEnd({ kind: other }) === false)
}
check('a missing reason is not ours',
  mod.isMaxTokensTurnEnd(undefined) === false && mod.isMaxTokensTurnEnd(null) === false)
check('a merge-extensible unknown ending is not ours',
  mod.isMaxTokensTurnEnd({ kind: 'something-new' }) === false)

check('a typed turn is human', mod.isHumanMessage({ source: { kind: 'user' } }) === true)
check('a typed turn with an rpcId is human',
  mod.isHumanMessage({ source: { kind: 'user', rpcId: 'r1' } }) === true)
check('our own continuation is not human',
  mod.isHumanMessage(message) === false)
check('the runtime-context snapshot is not human',
  mod.isHumanMessage({ source: { kind: 'runtime-context', form: 'snapshot' } }) === false)
check('a goal round is not human',
  mod.isHumanMessage({ source: { kind: 'goal', goalId: 'g', revision: 1, round: 2 } }) === false)
check('a sourceless message is not human',
  mod.isHumanMessage({}) === false && mod.isHumanMessage(null) === false)

// ── 3. settings resolution under every shape the loader can hand over ───────

console.log('\nsettings')

equal('absent config resolves to the documented defaults', mod.resolveSettings(undefined), {
  enabled: true,
  promptText: mod.DEFAULT_SETTINGS.promptText,
  maxContinues: 5,
  delayMs: 0,
})

// A live reference, exactly as cosmokit shapes it: a `get()` behind a
// well-known symbol key.
const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')
const liveref = (value) => ({ [VOLATILE_REF]: true, get: () => value })
check('a live reference is detected', mod.isLive(liveref(1)) === true)
check('a plain value is not a live reference', mod.isLive(1) === false)
equal('a live config is read through get()', mod.resolveSettings({
  enabled: liveref(false),
  promptText: liveref('CUSTOM'),
  maxContinues: liveref(0),
  delayMs: liveref(250),
}), {
  enabled: false,
  promptText: 'CUSTOM',
  maxContinues: 0,
  delayMs: 250,
})
equal('a plain config is read directly', mod.resolveSettings({
  enabled: false,
  promptText: 'PLAIN',
  maxContinues: 2,
  delayMs: 10,
}), {
  enabled: false,
  promptText: 'PLAIN',
  maxContinues: 2,
  delayMs: 10,
})

// Every field must fall back on its own: a half-written profile row, or one
// written against an older field set, must not disable the plugin. A row still
// carrying the retired `continueOnSubagent` key must be ignored, not rejected.
const hostile = [
  {}, { enabled: 'yes' }, { promptText: '' }, { promptText: '   ' }, { promptText: 7 },
  { maxContinues: -1 }, { maxContinues: 1.5 }, { maxContinues: NaN }, { maxContinues: '3' },
  { delayMs: -1 }, { delayMs: 60001 }, { delayMs: Infinity }, { delayMs: '250' },
  { continueOnSubagent: 'true' }, { continueOnSubagent: true }, null, 0, 'x', [],
]
let hostileSurvived = 0
for (const junk of hostile) {
  try {
    const s = mod.resolveSettings(junk)
    const usable = typeof s.enabled === 'boolean'
      && typeof s.promptText === 'string' && s.promptText.trim().length > 0
      && Number.isSafeInteger(s.maxContinues) && s.maxContinues >= 0
      && Number.isSafeInteger(s.delayMs) && s.delayMs >= 0
    if (usable) hostileSurvived++
    else console.log('  note   not usable:', JSON.stringify(junk), '->', JSON.stringify(s))
  } catch (error) {
    console.log('  note   threw:', JSON.stringify(junk), '->', error.message)
  }
}
check('every hostile config still yields usable settings',
  hostileSurvived === hostile.length, `${hostileSurvived}/${hostile.length}`)

// Usable is not enough: the *value* each hostile input resolves to is the
// contract, and asserting only "it is a number" would pass for any clamp or
// fallback. A numeric out-of-range value is clamped to the schema's ceiling
// (the profile asked for "as much as possible", not for the default), while a
// value that is not a usable number falls back to the documented default.
equal('a numeric maxContinues above the ceiling is clamped, not defaulted',
  mod.resolveSettings({ maxContinues: 100000 }).maxContinues, 100)
equal('a negative maxContinues falls back to the default',
  mod.resolveSettings({ maxContinues: -1 }).maxContinues, mod.DEFAULT_SETTINGS.maxContinues)
equal('a non-numeric maxContinues falls back to the default',
  mod.resolveSettings({ maxContinues: '3' }).maxContinues, mod.DEFAULT_SETTINGS.maxContinues)
equal('a fractional maxContinues falls back to the default',
  mod.resolveSettings({ maxContinues: 1.5 }).maxContinues, mod.DEFAULT_SETTINGS.maxContinues)
equal('maxContinues 0 survives as "unlimited"',
  mod.resolveSettings({ maxContinues: 0 }).maxContinues, 0)
equal('a numeric delayMs above the ceiling is clamped, not defaulted',
  mod.resolveSettings({ delayMs: 120000 }).delayMs, 60000)
equal('a negative delayMs falls back to the default (immediate)',
  mod.resolveSettings({ delayMs: -1 }).delayMs, mod.DEFAULT_SETTINGS.delayMs)
equal('a non-numeric delayMs falls back to the default',
  mod.resolveSettings({ delayMs: '250' }).delayMs, mod.DEFAULT_SETTINGS.delayMs)

// ── 4. the loop harness ─────────────────────────────────────────────────────

/**
 * Causal model of the pieces the kernel decides on.
 *
 * The flush order is the load-bearing part: `followup()` writes to the
 * `next-turn` inbox, and the loop only *reads* that inbox when it opens the
 * next turn — so one queued continuation is exactly one extra turn, never two.
 */
function makeHarness(pluginConfig, options = {}) {
  const log = []
  const sessionEvents = []
  const listeners = { session: [], disposed: [], status: [] }
  /** True while a driver loop is inside `kick()`, which is the phase guard. */
  let driving = false
  const chainedCeiling = options.chainedCeiling === true
  /**
   * When set, the wake stops starting drivers of its own.
   *
   * Tests that step the session turn by turn do that themselves, so an
   * autonomous wake would claim the very message the test is about to assert on
   * — and, worse, keep the chain advancing so the test never sees the stalled
   * state it is checking for. `manual` keeps the *wake* observable (the message
   * is still queued, and `arms()` still counts it) while the test owns the
   * clock.
   */
  let manual = false

  // The durable header is the host-side fact `isSubagentSession` reads. A
  // delegated child carries `parentSession` and `origin: 'subagent'`; a
  // top-level session carries neither.
  const session = options.subagent === true
    ? { id: 'session-1', header: { id: 'session-1', parentSession: 'session-0', origin: 'subagent', delegationDepth: 1, isSeeded: false, version: 1, createdAt: 0 } }
    : { id: 'session-1', header: { id: 'session-1', isSeeded: false, version: 1, createdAt: 0 } }

  const agent = {
    id: 'session-1',
    session,
    inbox: { nextTurn: [], nextStep: [] },
    /**
     * Phase of the driver, with a read counter.
     *
     * The plugin reads `status` once per wake poll, and only on the branch a
     * due wake takes — so counting the reads is how a test observes the poll loop
     * itself. That is what makes "the loop stops" falsifiable instead of a claim
     * about code shape.
     */
    _status: 'idle',
    _statusReads: 0,
    get status() {
      this._statusReads += 1
      return this._status
    },
    set status(value) {
      this._status = value
    },
    get nextTurn() {
      return this.inbox.nextTurn
    },
    /**
     * Model `ReactLoopAgent.followup()` → `send(message, 'next-turn', true)` →
     * `wakeDriver()`, and this is the crux of the harness:
     *
     *  * the insertion into the inbox always happens;
     *  * the wake only starts a driver **when the agent is idle**. `wakeDriver()`
     *    returns early for any other phase and only latches `wakeRequested` for a
     *    *maintenance* phase, so a wake that arrives while a turn is still
     *    closing is dropped, not deferred.
     *
     * The old plugin queued its continuation in a microtask, which lands in
     * exactly that dropped window: the message sits in the durable inbox and
     * nothing ever opens a turn for it. Modelling `followup()` as "just push the
     * message" hides the bug completely.
     */
    followup(payload) {
      this.inbox.nextTurn.push(payload)
      log.push('followup')
      // The driver starts on the task queue, not inside this call, so the
      // message is observable in the inbox before anything claims it.
      if (this.status === 'idle' && !driving && !manual) {
        // `chainedCeiling` makes every wake-opened turn end at the ceiling too,
        // so the chain the budget and the watermark must stop is the real one.
        void Promise.resolve().then(() => kick(24, chainedCeiling ? 'max-tokens' : 'completed'))
      }
    },
    steer() {
      log.push('steer')
      throw new Error('steer() is wrong for a finished step and must not be used')
    },
  }

  const logger = {
    warnings: [],
    warn(line) {
      this.warnings.push(String(line))
      log.push('warn')
    },
  }

  const agents = {
    get(id) {
      return id === agent.id ? agent : undefined
    },
  }
  // The host-side `sessions` service has no `subagentAddress` — that lookup
  // lives on the API controller's connection-scoped service. The harness
  // therefore provides no `sessions` service at all and no such method, so any
  // dependence on either fails loudly here rather than silently degrading in the
  // browser.
  const sessions = { list: () => [session] }

  const disposers = []
  const ctx = {
    agents,
    sessions,
    logger,
    on(type, handler) {
      if (type === 'session/event') listeners.session.push(handler)
      if (type === 'agent/disposed') listeners.disposed.push(handler)
      if (type === 'agent/status') listeners.status.push(handler)
      disposers.push(() => {
        listeners.session = listeners.session.filter((h) => h !== handler)
      })
    },
    effect(generator, label) {
      const iterator = generator()
      let step = iterator.next()
      while (!step.done) {
        const cleanup = step.value
        if (typeof cleanup === 'function') disposers.push(cleanup)
        step = iterator.next()
      }
      return { label, dispose: () => disposers.forEach((f) => f()) }
    },
  }

  mod.apply(ctx, pluginConfig)

  /** Append one durable session event, the way `session.append` broadcasts it. */
  function append(event) {
    sessionEvents.push(event)
    for (const handler of [...listeners.session]) handler(session, event)
  }

  /** Deliver a real person's turn. The driver is busy while it does so. */
  function human(text) {
    agent.status = 'running'
    append({ type: 'user/message', seq: sessionEvents.length, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
    park()
  }

  /**
   * Close one turn with the given ending reason.
   *
   * `turn/end` is appended synchronously and its publish is synchronous, so the
   * plugin's handler runs inside this call, while the driver is **still
   * running** — `kick()` only parks in its `finally`, after this returns. The
   * loop then asks its own question in the same synchronous run, before any
   * timer the handler armed, which is what the returned value models.
   *
   * Modelling the running phase is not decoration: it is the reason a wake sent
   * from this callback is dropped. A harness that left the agent idle here would
   * let the old microtask path look correct.
   *
   * @param turn - turn number.
   * @param reason - ending reason payload.
   * @returns true when the loop's own `inbox.hasPending` test would open a turn.
   */
  function endTurn(turn, reason) {
    agent.status = 'running'
    append({ type: 'turn/end', seq: sessionEvents.length, data: { turn, reason } })
    // Deliberately still running: the park is `kick()`'s `finally`, which runs
    // after the loop's own pending test below — never during the append.
    return agent.inbox.nextTurn.length > 0
  }

  /** The park, as `kick()`'s `finally` performs it: the driver is now at rest. */
  function park() {
    agent.status = 'idle'
  }

  /**
   * Let every microtask the handler deferred run, plus the wake poll.
   *
   * The wake loop rechecks every `WAKE_POLL_MS` and deliberately does not arm
   * while the phase is still closing, so a single macrotask is not enough to see
   * it act: this waits out a full poll interval.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

  /**
   * One full turn, in the order the loop runs it: open the turn, claim the
   * pending inbox for the step, run the step, close the turn, then ask the
   * loop's own question about pending work.
   *
   * The two orderings here are the whole point, and the earlier revision of
   * this harness got the second one wrong:
   *
   *  * `turn/end` is appended **synchronously** and `session.append` publishes
   *    synchronously, so the handler runs while the turn is still closing;
   *  * the loop's `if (!this.inbox.hasPending) return false` runs in the OLD
   *    synchronous code right after that append — before any timer the handler
   *    armed can fire. A continuation that arrives after this test cannot be
   *    seen by it, which is exactly why the plugin must wait for the driver to
   *    park instead of racing it with a microtask.
   *
   * `await settle()` after the ending models the driver parking (`kick()`'s
   * `finally` sets the idle phase) and lets the plugin's wake poll observe it.
   *
   * @param turn - turn number.
   * @param finish - ending reason kind.
   * @returns true when the loop's synchronous decision was to open another turn.
   */
  async function runTurn(turn, finish = 'max-tokens') {
    agent.status = 'running'
    append({ type: 'turn/start', seq: sessionEvents.length, data: { turn } })
    // `preStep` claims the target inbox and appends what it claimed, which is
    // the only thing that makes a queued message durable and model-visible.
    for (const payload of agent.inbox.nextTurn.splice(0, agent.inbox.nextTurn.length)) {
      log.push('delivered:' + payload.source.kind)
      append({ type: 'user/message', seq: sessionEvents.length, data: payload })
    }
    append({ type: 'assistant/message', seq: sessionEvents.length, data: { turn, step: 1 } })
    endTurn(turn, finish === 'max-tokens'
      ? { kind: 'max-tokens' }
      : finish === 'completed' ? { kind: 'completed' } : { kind: finish })
    // The loop's own synchronous test, exactly where the kernel asks it.
    const again = agent.inbox.nextTurn.length > 0
    park()
    await settle()
    return again
  }

  /**
   * One `kick()`: the driver's own loop, started by a wake.
   *
   * It consumes what was queued when it was woken and then parks, which is what
   * makes the wake path — not this function — the thing that decides whether a
   * chain continues. `driving` is held for the whole loop, so a wake that
   * arrives mid-turn is dropped exactly as `wakeDriver()` drops it.
   */
  async function kick(limit = 24, finish = 'completed') {
    driving = true
    const nextTurn = () => sessionEvents.filter((e) => e.type === 'turn/start').length + 1
    let turns = 0
    while (turns < limit && agent.inbox.nextTurn.length > 0
      && await runTurn(nextTurn(), finish)) {
      turns += 1
    }
    driving = false
  }

  /**
   * The closed driver loop: `while (await turn())`, plus the wake path.
   *
   * A real driver parks when the turn's own synchronous test finds nothing —
   * and is then started again by `wakeDriver()` once the plugin has queued the
   * continuation. So "no pending work" is not the end of the chain: the driver
   * must give the wake poll a moment, exactly as the kernel leaves the agent
   * idle between the ending and the woken turn.
   *
   * Bounded by `limit` so a regression that never stops arming continuations
   * fails the test instead of hanging it.
   */
  async function driver(limit = 24, finish = 'completed') {
    // The wake loop rechecks every `WAKE_POLL_MS` and deliberately does not arm
    // while the phase is still closing, so "one macrotask" is not enough to see
    // it act: this waits out a poll interval before concluding the chain ended.
    const waitForPending = async () => {
      for (let i = 0; i < 3 && agent.inbox.nextTurn.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      return agent.inbox.nextTurn.length > 0
    }
    // Number turns the way the session does: monotonically. A driver that
    // restarts its own count re-issues turn numbers the session already used,
    // and the plugin's watermark then correctly ignores the replayed ending —
    // which would test the guard instead of the wake.
    const nextTurn = () => sessionEvents.filter((e) => e.type === 'turn/start').length + 1
    let turns = 0
    while (turns < limit) {
      if (agent.status !== 'idle') { await settle(); continue }
      if (agent.inbox.nextTurn.length === 0 && !(await waitForPending())) break
      await runTurn(nextTurn(), finish)
      turns += 1
    }
    return turns
  }

  /** Consume whatever the loop would have claimed at the next turn boundary. */
  function deliver() {
    const claimed = agent.inbox.nextTurn.splice(0, agent.inbox.nextTurn.length)
    for (const payload of claimed) log.push('delivered:' + payload.source.kind)
    return claimed.length
  }

  return {
    log,
    sessionEvents,
    agent,
    session,
    logger,
    append,
    human,
    endTurn,
    runTurn,
    driver,
    deliver,
    park,
    settle,
    setManual: (value) => { manual = value },
    pending: () => agent.inbox.nextTurn.length,
    /** Wake polls observed so far, via the harness status getter. */
    statusReads: () => agent._statusReads,
    dispose: () => disposers.forEach((f) => f()),
    removeAgent: () => {
      agents.get = () => undefined
      for (const handler of [...listeners.disposed]) handler({ agent })
    },
    // A continuation is recognised by its private source kind, and the identity
    // fields are asserted here rather than only in the shape probe: a harness
    // that accepts a message the kernel would refuse is how a mutation confined
    // to the delivery path (rather than to `continuationMessage`) passed 134
    // checks while real sessions still failed to load.
    item: () => sessionEvents.find((e) => e.type === 'user/message'
      && e.data.source.kind !== 'user'
      && typeof e.data.id === 'string' && e.data.id.length > 0
      && e.data.role === 'user'),
    continuations: () => sessionEvents.filter((e) => e.type === 'user/message'
      && e.data.source.kind !== 'user'
      && typeof e.data.id === 'string' && e.data.id.length > 0
      && e.data.role === 'user').length,
  }
}

// ── 5. the core behavior ────────────────────────────────────────────────────

console.log('\nceiling ending -> continuation')

{
  const h = makeHarness({})
  const turns = () => h.sessionEvents.filter((e) => e.type === 'turn/start').length
  const arms = () => h.log.filter((line) => line === 'followup').length

  // The regression this suite exists for, in two steps.
  //
  // `endTurn` returns the loop's own synchronous `hasPending` verdict, taken
  // while the handler is still mid-append: it answers "no work" even though a
  // continuation is coming. Answering `true` here would mean the model checks the
  // inbox at a moment the kernel never checks it.
  h.human('写一篇长文')
  const again = h.endTurn(1, { kind: 'max-tokens' })
  check('the loop\'s synchronous inbox test cannot see the continuation yet',
    again === false, String(again))
  equal('and nothing was queued during the ending itself', arms(), 0)
  equal('and the driver is still mid-turn during the ending', h.agent.status, 'running')

  // Step two is the bug itself. The agent is *still* running right after the
  // ending, which is exactly the window a microtask fires in — so a continuation
  // queued from the ending's own callback is dropped by `wakeDriver()` and the
  // message would sit in the inbox forever. Waiting here, before the driver
  // parks, is what makes this check able to fail.
  await h.settle()
  equal('a wake sent from inside the ending is dropped, not deferred', arms(), 0)
  check('and nothing is queued while the driver is still closing', h.pending() === 0)

  // The driver now parks (`kick()`'s `finally`), and the wake can land.
  h.park()
  await h.settle()
  equal('the wake poll arms exactly one continuation once the driver parks', arms(), 1)

  // The wake landed while the agent was idle, so the very same `followup()` both
  // queued the message and started the driver on it — `wakeDriver()`'s
  // documented contract, and why queueing at idle is safe where queueing while
  // the turn closes is not. What the continuation *is* is therefore read from
  // the durable transcript it was claimed into.
  check('the continuation is a user/message with the private kind',
    h.item() !== undefined && h.item().data.source.kind === 'auto-continue')
  check('the continuation carries the default prompt verbatim',
    h.item().data.content[0].text === mod.DEFAULT_SETTINGS.promptText)

  // Only the wake path can open the next turn here: no human types again, and
  // the previous turn is over, so a stalled wake would leave turn 2 unopened.
  const opened = await h.driver()
  equal('the armed continuation was already claimed by the wake itself', opened, 0)
  // No human opens a turn here — that is the property the old microtask path
  // silently lost. The wake alone opens exactly one turn, and that turn claims
  // both the person's own message and the continuation.
  equal('so exactly one turn exists, opened only by the wake', turns(), 1)
  check('delivery appends the continuation as a durable user/message',
    h.continuations() === 1, String(h.continuations()))
  check('the delivered continuation projects to exactly the prompt text',
    h.item().data.content[0].text === mod.DEFAULT_SETTINGS.promptText)
  check('the chain then closes with the agent idle',
    h.agent.status === 'idle' && h.agent.inbox.nextTurn.length === 0)
  h.dispose()
}

console.log('\nother endings -> nothing')
for (const ending of ['completed', 'aborted', 'blocked', 'error', 'interrupted', 'forked']) {
  const h = makeHarness({})
  h.human('go')
  const again = await h.runTurn(1, ending)
  check(`a "${ending}" turn queues nothing`,
    h.agent.inbox.nextTurn.length === 0 && again === false)
  h.dispose()
}

console.log('\nsteering is never used, and the chain is driven by wakes alone')
{
  // A session where the model never finishes the document: every wake-opened
  // turn hits the ceiling again. No human touches the session after the first
  // message, so every turn past the first exists only because the wake path
  // armed it — the property the old microtask path silently failed, stalling the
  // chain at the first ceiling until somebody typed.
  const h = makeHarness({ maxContinues: 3 }, { chainedCeiling: true })
  const arms = () => h.log.filter((line) => line === 'followup').length
  const turns = () => h.sessionEvents.filter((e) => e.type === 'turn/start').length
  h.human('go')
  await h.runTurn(1, 'max-tokens')
  await h.driver(24, 'max-tokens')

  equal('three ceiling turns arm exactly three continuations', arms(), 3)
  equal('and every one of them is delivered', h.continuations(), 3)
  equal('which takes four turns in total (the human turn plus three)',
    turns(), 4)
  equal('the last turn spends the budget and stops', arms(), 3)
  check('the chain ends parked, not stalled mid-flight',
    h.agent.status === 'idle' && h.agent.inbox.nextTurn.length === 0)
  check('steer() was never called', !h.log.includes('steer'))
  const ends = h.sessionEvents.filter((e) => e.type === 'turn/end').length
  check('turns stay balanced', turns() === ends && turns() === 4, `${turns()}/${ends}`)
  equal('every delivery is logged as a delivery',
    h.log.filter((line) => line === 'delivered:auto-continue').length, 3)
  h.dispose()
}
{
  // Unbounded budget, bounded test: the driver stops when a non-ceiling ending
  // closes the chain, which is what a real continuation does once the model
  // finishes the document instead of hitting the ceiling again.
  const h = makeHarness({ maxContinues: 0 })
  const arms = () => h.log.filter((line) => line === 'followup').length
  h.human('go')
  await h.runTurn(1, 'max-tokens')
  await h.runTurn(2, 'completed')
  equal('an unlimited budget arms and delivers across the chain', arms(), 1)
  check('and the chain closes on a completed turn',
    h.agent.status === 'idle' && h.agent.inbox.nextTurn.length === 0)
  check('unlimited never warns', h.logger.warnings.length === 0,
    h.logger.warnings.join(' | '))
  h.dispose()
}

console.log('\nthe budget')
{
  const h = makeHarness({ maxContinues: 2 })
  h.setManual(true)
  const arms = () => h.log.filter((line) => line === 'followup').length
  h.human('go')
  // Each continuation is queued by one turn and delivered by the next, so the
  // budget governs *arms* and the durable transcript lags by exactly one.
  for (let turn = 1; turn <= 6; turn++) await h.runTurn(turn, 'max-tokens')
  equal('arms two continuations and then stops', arms(), 2)
  equal('warns exactly once when the budget runs out',
    h.logger.warnings.filter((w) => /configured limit/.test(w)).length, 1)
  check('the warning names the limit', /limit of 2/.test(h.logger.warnings.join('\n')))
  equal('two more ceiling endings add nothing', arms(), 2)

  // The deadline the code promises ("the poll is abandoned ... noise kept to one
  // warning") is only reachable if a wake that will never be sent stops being
  // `due`. Leaving it pending kept every poll on the `due.length > 0` branch, so
  // the loop span on a 20 ms timer forever and the warning above was the only
  // trace of it. Counting status reads is how that is observed.
  const readsAfterBudget = h.statusReads()
  await new Promise((resolve) => setTimeout(resolve, 60))
  equal('the wake loop stops polling once the budget is spent',
    h.statusReads(), readsAfterBudget)

  // A human message resets the budget.
  h.human('接着来')
  await h.runTurn(7, 'max-tokens')
  equal('a human turn resets the budget', arms(), 3)
  await h.runTurn(8, 'completed')
  equal('and the continuation is delivered', h.continuations(), 3)
  h.dispose()
}
{
  const h = makeHarness({ maxContinues: 0 })
  h.setManual(true)
  h.human('go')
  for (let turn = 1; turn <= 12; turn++) await h.runTurn(turn, 'max-tokens')
  equal('maxContinues 0 means unlimited',
    h.log.filter((line) => line === 'followup').length, 12)
  check('unlimited never warns', h.logger.warnings.length === 0,
    h.logger.warnings.join(' | '))
  h.dispose()
}
{
  // The budget counts continuations, not turns: a turn that ends normally must
  // not spend any of it.
  const h = makeHarness({ maxContinues: 1 })
  h.human('go')
  await h.runTurn(1, 'completed')
  await h.runTurn(2, 'max-tokens')
  await h.runTurn(3, 'max-tokens')
  equal('a completed turn does not spend the budget',
    h.log.filter((line) => line === 'followup').length, 1)
  h.dispose()
}

console.log('\nenabled: false')
{
  const h = makeHarness({ enabled: false })
  h.human('go')
  const again = await h.runTurn(1, 'max-tokens')
  check('a disabled plugin queues nothing',
    h.agent.inbox.nextTurn.length === 0 && again === false)
  h.dispose()
}

console.log('\nsubagent sessions')
{
  const h = makeHarness({}, { subagent: true })
  h.human('go')
  await h.runTurn(1, 'max-tokens')
  check('a subagent turn never gets a continuation', h.agent.inbox.nextTurn.length === 0)
  h.dispose()
}
{
  // Subagents are skipped unconditionally, not by preference. Measured live: a
  // child emits `turn/end` and is disposed in the same instant, so a deferred
  // continuation aimed at it is dropped a microtask later regardless of config.
  // A row that still carries the retired `continueOnSubagent: true` key must
  // therefore still not produce a continuation.
  const h = makeHarness({ continueOnSubagent: true }, { subagent: true })
  h.human('go')
  await h.runTurn(1, 'max-tokens')
  check('the retired continueOnSubagent key cannot opt a subagent back in',
    h.agent.inbox.nextTurn.length === 0)
  h.dispose()
}
{
  // A session whose header cannot classify it — an older host, a stripped-down
  // composition, a header shape that changed — must be treated as top-level
  // rather than throwing or being silently skipped.
  const h = makeHarness({})
  h.setManual(true)
  delete h.session.header
  h.human('go')
  await h.runTurn(1, 'max-tokens')
  check('a session with no readable header is continued',
    h.agent.inbox.nextTurn.length === 1)
  h.dispose()
}
{
  // A resumed child keeps `parentSession` but may have lost `origin`.
  const h = makeHarness({}, { subagent: true })
  delete h.session.header.origin
  h.human('go')
  await h.runTurn(1, 'max-tokens')
  check('parentSession alone is enough to classify a child',
    h.agent.inbox.nextTurn.length === 0)
  h.dispose()
}

// ── 6. the races the guards exist for ───────────────────────────────────────

console.log('\nraces')

{
  // "The human answered first." The client appends the typed message in the same
  // tick as the ceiling ending; the microtask must lose to it.
  const h = makeHarness({})
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.human('我自己来')
  await h.settle()
  check('a human message in the same tick wins over the continuation',
    h.agent.inbox.nextTurn.length === 0)
  equal('no continuation entered the transcript', h.continuations(), 0)
  h.dispose()
}
{
  // The deferred continuation must not fire into work that is already running
  // again. Both halves of the guard are exercised: the agent staying busy, and
  // a newer turn having superseded the ending it was armed for.
  const busy = makeHarness({ delayMs: 5 })
  busy.human('go')
  busy.endTurn(1, { kind: 'max-tokens' })
  busy.agent.status = 'running'
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('a delayed continuation does not fire while the agent is running',
    busy.agent.inbox.nextTurn.length === 0)
  busy.dispose()

  const superseded = makeHarness({ delayMs: 20 })
  superseded.human('go')
  superseded.endTurn(1, { kind: 'max-tokens' })
  // Turn 2 ends normally while the continuation for turn 1 is still deferred:
  // the watermark moves to 2 and the armed ending is no longer `pending`.
  superseded.endTurn(2, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  check('a delayed continuation for a superseded ending does not fire',
    superseded.agent.inbox.nextTurn.length === 0)
  equal('and nothing entered the transcript', superseded.continuations(), 0)
  superseded.dispose()
}
{
  const h = makeHarness({ delayMs: 5 })
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.agent.status = 'idle'
  // Wait out *two* poll intervals plus the delay floor. The wake's own cadence is
  // `WAKE_POLL_MS`, and the first poll after the ending lands before `readyAt`
  // (`delayMs` floor), so the send can happen as late as one further interval —
  // measured at ~33 ms for `delayMs: 5`. Waiting only 20 ms raced that cadence
  // and failed intermittently.
  await new Promise((resolve) => setTimeout(resolve, 60))
  // The delay is a floor, not a rival path: once the agent is idle the same wake
  // queues the continuation and starts the driver on it, so what proves it fired
  // is the durable transcript, not the inbox it was claimed out of.
  check('a delayed continuation fires once the agent is idle',
    h.continuations() === 1, String(h.continuations()))
  equal('and the message it queued is the continuation',
    h.item()?.data?.source?.kind, 'auto-continue')
  equal('and it is delivered exactly once', h.continuations(), 1)
  h.dispose()
}
{
  const h = makeHarness({ delayMs: 5 })
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.agent.status = 'idle'
  h.removeAgent()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('a disposed agent receives nothing', h.agent.inbox.nextTurn.length === 0)
  h.dispose()
}
{
  const h = makeHarness({ delayMs: 50 })
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.human('我来吧')
  await new Promise((resolve) => setTimeout(resolve, 80))
  check('a human message cancels an armed timer', h.agent.inbox.nextTurn.length === 0)
  h.dispose()
}
{
  // One ending must produce exactly one continuation, even when the log presents
  // that ending more than once. That is not hypothetical: a session resumed from
  // its JSONL is folded from durable events, and a retried request can re-append
  // a turn's ending. Turn numbers are monotonic, so the plugin keeps a watermark
  // and retires every ending at or below it.
  const h = makeHarness({})
  h.setManual(true)
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.park()
  await h.settle()
  equal('the first ending arms one continuation', h.agent.inbox.nextTurn.length, 1)
  h.endTurn(1, { kind: 'max-tokens' })
  h.park()
  await h.settle()
  equal('a repeat of the same ending adds nothing', h.agent.inbox.nextTurn.length, 1)
  equal('the watermark retired it', h.continuations(), 0)
  h.dispose()
}
{
  const h = makeHarness({ delayMs: 5 })
  h.setManual(true)
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.endTurn(1, { kind: 'max-tokens' })
  h.agent.status = 'idle'
  await new Promise((resolve) => setTimeout(resolve, 25))
  equal('two endings for one turn arm one continuation, not two',
    h.agent.inbox.nextTurn.length, 1)
  h.dispose()
}
{
  // The wake's own liveness test matches by object identity, so the message a
  // wake carries must be the very object handed to `followup()`. When
  // `continueTurn` built its own message instead, `isQueued` answered "not
  // queued" while the inbox plainly held that message — measured directly.
  //
  // Here the send never reaches the inbox at all (the failure happens before the
  // insert), so the wake is unsent and must be retried rather than abandoned.
  const h = makeHarness({ delayMs: 1 })
  h.setManual(true)
  let attempts = 0
  h.agent.followup = () => {
    attempts += 1
    h.log.push('followup')
    if (attempts === 1) throw new Error('transient failure before insert')
  }
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.park()
  await new Promise((resolve) => setTimeout(resolve, 80))
  check('a wake whose send failed is retried, not abandoned',
    attempts >= 2, `followup attempts = ${String(attempts)}`)
  h.dispose()
}
{
  // The other half of the same contract: a send that inserted the message and
  // *then* failed must not be repeated, or the transcript gets two copies of one
  // continuation.
  const h = makeHarness({ delayMs: 1 })
  h.setManual(true)
  let attempts = 0
  h.agent.followup = (payload) => {
    attempts += 1
    h.log.push('followup')
    h.agent.inbox.nextTurn.push(payload)
    if (attempts === 1) throw new Error('wake failed after insert')
  }
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.park()
  await new Promise((resolve) => setTimeout(resolve, 80))
  equal('a send that inserted then failed is not repeated',
    attempts, 1)
  equal('so one continuation is queued, not two',
    h.agent.inbox.nextTurn.length, 1)
  h.dispose()
}
{
  // The same identity contract, seen from the other side: a successful send must
  // not be repeated. A second `followup()` for one wake would append a second
  // continuation to the transcript.
  const h = makeHarness({ delayMs: 1 })
  h.setManual(true)
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.park()
  await new Promise((resolve) => setTimeout(resolve, 120))
  equal('a sent continuation is not re-sent by later polls',
    h.log.filter((line) => line === 'followup').length, 1)
  equal('so the inbox holds one message', h.agent.inbox.nextTurn.length, 1)
  h.dispose()
}
{
  // The ending arrives again after its continuation was already queued and
  // delivered. The watermark must still retire it.
  const h = makeHarness({})
  h.human('go')
  await h.runTurn(1, 'max-tokens')
  await h.runTurn(2, 'completed')
  const before = h.agent.inbox.nextTurn.length
  h.endTurn(1, { kind: 'max-tokens' })
  await h.settle()
  check('an ending replayed after delivery adds nothing',
    h.agent.inbox.nextTurn.length === before,
    `${before} -> ${h.agent.inbox.nextTurn.length}`)
  equal('and the transcript is unchanged', h.continuations(), 1)
  h.dispose()
}

// ── 7. durability and teardown ──────────────────────────────────────────────

console.log('\nteardown')
{
  const h = makeHarness({ delayMs: 1000 })
  h.human('go')
  h.endTurn(1, { kind: 'max-tokens' })
  h.agent.status = 'idle'
  h.dispose()
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('disposal cancels every armed timer', h.agent.inbox.nextTurn.length === 0)
}

console.log('\nfailures never escape the handler')
{
  const h = makeHarness({})
  h.agent.followup = () => {
    throw new Error('inbox is gone')
  }
  h.human('go')
  let threw = false
  try {
    await h.runTurn(1, 'max-tokens')
  } catch {
    threw = true
  }
  check('a throwing followup() is contained', threw === false)
  check('and it is reported', h.logger.warnings.some((w) => /could not queue/.test(w)))
  h.dispose()
}

// ── 8. the row declaration ──────────────────────────────────────────────────

console.log('\nbundle row')
{
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const idMatch = /-\s*id:\s*(\S+)/.exec(patch)
  const nameMatch = /name:\s*(\S+)/.exec(patch)
  check('the patch declares an insert row',
    /^-\s*insert:/m.test(patch.replace(/^#.*$/gm, '')))
  check('the row mounts this package', nameMatch !== null && nameMatch[1] === 'dsh-auto-continue',
    nameMatch === null ? 'none' : nameMatch[1])
  check('the row has a stable id', idMatch !== null && idMatch[1].length > 0,
    idMatch === null ? 'none' : idMatch[1])

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check('the manifest points at the patch',
    manifest.dsh?.bundle?.patch === './cordis.patch.yml')
  check('the manifest main is the host half', manifest.main === 'lib/index.js')
  check('the manifest declares schemastery as a host peer',
    typeof manifest.peerDependencies?.['@deepseek-ai/schemastery'] === 'string')
}

// ── summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(72))
if (failures > 0) {
  console.error(`FAIL: ${failures} of ${checks} checks failed`)
  process.exitCode = 1
} else {
  console.log(`OK: all ${checks} checks passed`)
}
console.log(`
Not reproducible offline, therefore not asserted here:
  * that the kernel resolves @deepseek-ai/schemastery for a profile plugin, and
    therefore that the Settings card appears. Both are observable only in a
    running DSH; the plugin is written to degrade to its defaults if the schema
    is absent rather than to fail.
  * that the real Chat UI paints the row from source.kind "auto-continue" as a
    labelled context row (the projection is reproduced above from the shipped
    source, not executed).
  * that the model honours the prompt. Only the plumbing is verifiable.
`)
