/**
 * dsh-auto-continue — Host half.
 *
 * One job: when a turn ends because the model hit its output ceiling, put the
 * next prompt into the session so the reply keeps going instead of stopping
 * mid-sentence and waiting for a human to type 继续.
 *
 * ## Why the signal is `turn/end { reason: { kind: 'max-tokens' } }`
 *
 * The model adapter normalizes a provider `finish_reason: 'length'` (or
 * `'max_tokens'`) to the closed `FinishReasonMap` member `'max-tokens'`. The
 * agent loop returns that reason from the step, keeps it as the turn's ending
 * reason even when a later step also ran (`if (turnEnds === null || turnEnds.kind
 * !== 'max-tokens') turnEnds = stepEnd`), and appends `turn/end` with it in the
 * turn's `finally`. So one durable event covers every provider and every
 * adapter, and it is the same event the shipped Chat UI keys its own
 * 「已达到输出 token 上限」 notice off. No provider-specific inspection, no
 * stream parsing, no token accounting.
 *
 * ## Why `agent.followup()` and not `agent.steer()`
 *
 * The `turn/end` append happens inside the turn, before the loop decides
 * whether to open another one. `followup()` lands the message in the
 * `next-turn` inbox; the loop's own `if (!this.inbox.hasPending) return false`
 * then sees it and starts the next turn on the spot — the continuation costs no
 * extra round trip and no idle gap. `steer()` would be wrong here: it targets
 * the *current* step, and by this point there is no current step left to steer.
 *
 * ## Why the message can carry a private source kind
 *
 * `deriveEventMessage()` in `@deepseek-ai/dsh-session/surface` returns
 * `event.data` verbatim for a `user/message` — "the event's model-facing content
 * stays verbatim", with no per-source framing or filtering. The Chat UI, on the
 * other hand, only renders the user bubble for `source.kind === 'user'`; every
 * other kind becomes a labelled injected-context row. Declaring our own kind
 * therefore buys a correct transcript (the automatic prompt is visibly not
 * something the human typed) at zero cost to what the model reads.
 *
 * @module dsh-auto-continue
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

// ── identity ────────────────────────────────────────────────────────────────

/** Package name the loader mounts this row as; must match cordis.patch.yml. */
export const name = 'dsh-auto-continue'

/**
 * Services this half consumes.
 *
 * `agents` is the live-agent registry, read for three things: to prove an event
 * belongs to a mounted agent, to keep a timer from firing at a disposed one, and
 * to hand `followup()` to. Nothing else is needed: a subagent session is
 * recognised from the durable session header the event already carries, so the
 * plugin takes no dependency on a service it only reads through one accessor.
 */
export const inject = ['agents']

// ── constants ───────────────────────────────────────────────────────────────

/**
 * Message source kind for an automatic continuation.
 *
 * Deliberately not `'user'`: the transcript must not claim the human typed
 * this, and `contextProducer()` falls back to using an unknown kind as the
 * row's label, so the value is also what the user sees.
 */
const SOURCE_KIND = 'auto-continue'

/**
 * Presentation form for the continuation row.
 *
 * Must be a member of the Chat UI's `KNOWN_FORMS` (`instructions`, `catalog`,
 * `snapshot`, `notice`, `relay`, `recall`) or `contextForm()` returns null and
 * the row degrades to the opaque presentation. `'notice'` is the honest one: a
 * one-line account of something the system just did.
 */
const SOURCE_FORM = 'notice'

/**
 * Default prompt. Short on purpose: the model already sees the whole truncated
 * reply, so the only information this has to add is "the cut was not the end".
 * The no-restart/no-repeat clauses are the difference between resuming a
 * sentence and producing a second document with a fresh title, which is the
 * observable failure mode of a naive 「继续」.
 */
const DEFAULT_PROMPT = [
  '继续。上一次输出因为达到长度上限被截断，请从断点处直接接着写，',
  '不要重复已经输出过的内容，不要重新开头或重列提纲。',
].join('')

/**
 * How often the same-tick path re-asks whether the turn's driver has parked.
 *
 * @see scheduleContinuation — the kernel only lets a queued prompt start a turn
 * while the agent is idle, so the same-tick path must wait for that edge
 * instead of racing the turn's own finalization with a microtask.
 */
const WAKE_POLL_MS = 20

/**
 * How long the same-tick path keeps asking before giving up on the driver.
 *
 * A turn that never parks (a wedged driver, a maintenance job that will not
 * end) must not leave a timer armed forever. The continuation is not lost when
 * this expires: it stays in the kernel's durable inbox and the next human turn
 * claims it, with the poll abandoned and noise kept to one warning.
 */
const WAKE_POLL_DEADLINE_MS = 10_000

/** Field defaults, also unreachable-when-schema-resolved fallbacks. */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  promptText: DEFAULT_PROMPT,
  maxContinues: 5,
  delayMs: 0,
})

/** Upper bounds {@link resolveSettings} clamps to, mirroring the schema below. */
const MAX_CONTINUES_CEILING = 100
const DELAY_CEILING_MS = 60_000

// ── config ──────────────────────────────────────────────────────────────────

/**
 * Whether the resolved schemastery carries `.volatile()`.
 *
 * `dsh-settings` serves a namespace only for an entry whose `Config` projects a
 * non-empty volatile form (`volatileForm()` keeps only fields with
 * `meta.volatile`, and `describe()` drops every entry whose projection is
 * empty). Without the method the plugin still works — `apply` just receives an
 * unresolved config — but the settings card silently never appears, so the
 * capability is probed once and reported through the schema instead of throwing.
 */
const LIVE_CAPABLE = typeof z.boolean().volatile === 'function'

/**
 * Mark one Config field live-editable where the schema library allows it.
 * @param schema - field schema.
 * @returns the same schema, marked volatile when supported.
 */
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema
}

/**
 * cosmokit's well-known key on a live config reference.
 *
 * `.volatile()` does not hand back the value: it hands back a stable reference
 * whose `get()` reads the current one, so that a settings edit can be committed
 * into the same object and the fiber can be left running
 * (`loader/volatile-update`). Detecting it by this shared symbol is the same
 * test `dsh-settings`' own `plainConfig()` makes.
 */
const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')

/**
 * Whether a config field arrived as a live reference.
 * @param value - applied config field.
 * @returns true when the value is a cosmokit volatile reference.
 */
export function isLive(value) {
  return typeof value === 'object' && value !== null && VOLATILE_REF in value
}

/**
 * Read one applied-config field, live reference or plain snapshot.
 *
 * Both shapes are real: a profile that could resolve the schema gets live
 * references (`apply` is expected to read through `get()`), and one that could
 * not gets whatever JSON the row carried.
 * @param config - applied config, possibly undefined.
 * @param key - field name.
 * @returns the current value, or undefined.
 */
export function readField(config, key) {
  if (config === null || typeof config !== 'object') return undefined
  const value = config[key]
  return isLive(value) && typeof value.get === 'function' ? value.get() : value
}

/**
 * Resolve the applied config to the settings the handler runs with.
 *
 * Every field falls back individually, so a profile that could not load the
 * schema — and therefore receives no resolved config at all — still gets a
 * working plugin under the documented defaults. The read is done once per
 * continuation rather than cached, because that is exactly when a value saved
 * from the settings card can take effect without a restart.
 * @param config - applied config, possibly undefined.
 * @returns detached, fully defaulted settings.
 */
export function resolveSettings(config) {
  const enabled = readField(config, 'enabled')
  const promptText = readField(config, 'promptText')
  const maxContinues = readField(config, 'maxContinues')
  const delayMs = readField(config, 'delayMs')
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SETTINGS.enabled,
    promptText: typeof promptText === 'string' && promptText.trim().length > 0
      ? promptText
      : DEFAULT_SETTINGS.promptText,
    // Clamped to the schema's own range rather than silently dropped back to the
    // default: a profile that carries `maxContinues: 100000` means "effectively
    // unlimited", and answering it with "5" would be the opposite of what was
    // written. Anything unreadable (NaN, a string, a negative) still falls back,
    // because there is no defensible clamp for a value that is not a number.
    maxContinues: Number.isSafeInteger(maxContinues) && maxContinues >= 0
      ? Math.min(maxContinues, MAX_CONTINUES_CEILING)
      : DEFAULT_SETTINGS.maxContinues,
    delayMs: Number.isSafeInteger(delayMs) && delayMs >= 0
      ? Math.min(delayMs, DELAY_CEILING_MS)
      : DEFAULT_SETTINGS.delayMs,
  }
}

/** This entry's Host configuration schema, exactly the fields the card edits. */
export const Config = z.object({
  enabled: live(z.boolean().default(DEFAULT_SETTINGS.enabled))
    .description('达到输出上限时自动续写'),
  promptText: live(z.string().default(DEFAULT_SETTINGS.promptText))
    .description('自动追发的内容'),
  maxContinues: live(z.number().step(1).min(0).max(100).default(DEFAULT_SETTINGS.maxContinues))
    .description('每轮最多自动续写几次（0 = 不限制）'),
  delayMs: live(z.number().step(1).min(0).max(60000).default(DEFAULT_SETTINGS.delayMs))
    .description('追发前等待的毫秒数'),
})

// ── wire helpers ────────────────────────────────────────────────────────────

/**
 * Whether a durable `user/message` is a real person's turn.
 *
 * `source.kind === 'user'` is what the client controller writes for typed
 * input; our own continuation, the runtime-context snapshot, goal rounds, and
 * every injected reminder all use their own kind. This is the boundary that
 * resets the consecutive-continuation budget, so it must not be satisfied by
 * anything the system sends to itself.
 * @param message - logged user message.
 * @returns true for a human-authored turn.
 */
export function isHumanMessage(message) {
  return message !== null
    && typeof message === 'object'
    && message.source !== null
    && typeof message.source === 'object'
    && message.source.kind === 'user'
}

/**
 * Read the token-ceiling ending out of a `turn/end` payload.
 *
 * Non-exhaustive on purpose: `TurnEndReasonMap` is merge-extensible, and every
 * reason that is not the ceiling is simply not our business.
 * @param reason - `turn/end` reason, possibly absent.
 * @returns true only for the output-limit ending.
 */
export function isMaxTokensTurnEnd(reason) {
  return reason !== null
    && typeof reason === 'object'
    && reason.kind === 'max-tokens'
}

/**
 * Build the continuation message for one turn.
 *
 * Shape notes that matter: `content` is a single `text` block because that is
 * the only block a `user/message` needs to project verbatim into the request,
 * and `source` carries only presentation fields.
 *
 * ## Why `id` and `role` are not optional
 *
 * A `user/message` is a **message event**, and `dsh-session-persistence`
 * validates every loaded event with `adoptSessionEvent()`, which for this type
 * requires a non-empty `id`, `role === 'user'`, a non-empty `source.kind`, and
 * array `content`. The kernel's own injected user rows are built by
 * `createUserMessage()`, which stamps `id` and `role`; this plugin hand-builds
 * its payload, so it must stamp them itself.
 *
 * Omitting them writes a log that replays fine in memory but is **refused at
 * load time**: `stored session "…" failed validation: Error: session event at
 * seq … lacks an identified message`. The failure surfaces only when the
 * session is next resumed, and by then every continuation in the log is
 * unloadable — measured on three real sessions on 2026-11-03, twelve
 * continuations each with `keys=content,source`.
 *
 * `id` is generated once per message object and travels with it. That keeps the
 * object-identity bookkeeping in {@link isQueued} intact, and it is what the
 * retry path re-sends, so a re-kick cannot mint a second identity for one
 * continuation.
 * @param text - prompt to send.
 * @param turn - the turn whose ending triggered this, for the transcript row.
 * @returns a `user/message` payload ready for `agent.followup()`.
 */
export function continuationMessage(text, turn) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: SOURCE_FORM,
      turn,
    },
  }
}

// ── the plugin ──────────────────────────────────────────────────────────────

/**
 * Install automatic continuation over the public agent and session services.
 *
 * State is per exact agent object (a replaced agent must never inherit its
 * predecessor's budget) and holds four things: how many continuations have been
 * armed since the last human turn, the turn whose ceiling ending is currently
 * armed, the highest turn whose ending has been considered at all, and whether
 * the budget warning has already been said for this human turn. Together the
 * last two are what make "the user answered first", a superseded turn, and a
 * replayed durable ending all lossless rather than merely unlikely.
 *
 * @param ctx - the host root context owned by this row.
 * @param config - applied config, validated against {@link Config} when the
 *   schema was resolvable.
 */
export function apply(ctx, config) {
  /** Live per-agent continuation state, keyed by the agent object. */
  const states = new Map()

  /**
   * State for an exact live agent, created on first sight.
   * @param agent - agent the state belongs to.
   * @returns its mutable state record.
   */
  function stateFor(agent) {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state = {
      /** Continuations armed since the last human turn. */
      continues: 0,
      /** Highest turn whose ending has been considered, ceiling or not. */
      seen: 0,
      /** True once a human message has been seen after the last armed ending. */
      humanAnswered: false,
      /** Whether the budget warning has already been said for this human turn. */
      capped: false,
      /** Whether the parked-driver warning has already been said for this human turn. */
      stalled: false,
      /**
       * Endings still waiting for the driver to park, oldest first.
       *
       * Deliberately a list, not one slot: two ceiling endings can be committed
       * before the driver parks once (a turn that hits the ceiling can be
       * claimed and closed again while the first wake is still waiting), and a
       * single slot loses the earlier one — measured in the offline driver
       * model as a chain that arms three continuations but delivers one.
       */
      wakes: [],
      /** Timeout handles the wake loop keeps armed. */
      timers: new Set(),
    }
    states.set(agent, state)
    return state
  }

  /**
   * Whether this exact agent object is still the registered one under its id.
   *
   * An agent that was disposed and replaced — or a `fork` child that inherited a
   * session id — must never receive a continuation queued for its predecessor.
   * @param agent - agent to test.
   * @returns true when the registry still hands back this identity.
   */
  function isCurrent(agent) {
    try {
      return ctx.agents.get(agent.id) === agent
    } catch {
      return false
    }
  }

  /**
   * Whether one session belongs to a delegated subagent.
   *
   * Read from the durable session header, which is the host-side fact: a
   * delegated child is created with `parentSession` and `origin: 'subagent'`
   * (see `@deepseek-ai/dsh-subagent`, `childSessionMeta`), and the header
   * survives on resumed sessions. The client-facing
   * `sessions.subagentAddress()` lookup is deliberately not used — that method
   * exists on the API controller's connection-scoped service, not on the host
   * `sessions` service a plugin is handed.
   *
   * Subagent sessions are skipped unconditionally, and that is not a
   * conservative default but the only correct behaviour: measured live, a child
   * emits `turn/end` and is disposed in the same instant, so a deferred
   * continuation aimed at it is dropped one microtask later anyway. There is no
   * setting that could make it work, so the plugin does not offer one.
   * @param session - session to classify.
   * @returns true when the session belongs to a subagent.
   */
  function isSubagentSession(session) {
    try {
      const header = session?.header
      if (header === null || header === undefined) return false
      return header.parentSession !== undefined || header.origin === 'subagent'
    } catch {
      return false
    }
  }

  /**
   * Whether this turn's ceiling ending is still ours to answer.
   *
   * Every clause is a real way the continuation loses its footing:
   *   * the agent was disposed, or a different one now owns the session id;
   *   * a human message was admitted after the ending, which is the "the user
   *     answered first" case and must win;
   *   * the session has since entered a higher turn, so the ending being
   *     answered is already in the past (`state.seen` moved on). That covers
   *     both a newer `turn/end` superseding this one and a replay of an ending
   *     the session already answered.
   *
   * Note what is deliberately *not* a clause: "some other ending is currently
   * armed". Two endings can be live at once, and each is answered when its own
   * parked-driver window opens; suppressing the older one is what stalled a
   * chain mid-flight.
   *
   * @param agent - agent the continuation would be queued for.
   * @param state - its state record.
   * @param turn - turn whose ending is being answered.
   * @returns true when the continuation should still be sent.
   */
  function stillOurs(agent, state, turn) {
    if (!isCurrent(agent)) return false
    if (state.seen > turn) return false
    if (state.humanAnswered) return false
    return true
  }

  /**
   * Queue one continuation for an agent whose turn just hit the ceiling.
   * @param agent - agent to continue.
   * @param session - its session.
   * @param state - its state record.
   * @param turn - the ending turn number.
   */
  function continueTurn(agent, session, state, turn, message) {
    if (!stillOurs(agent, state, turn)) return 'forbidden'
    const settings = resolveSettings(config)
    const subagent = isSubagentSession(session)
    if (!settings.enabled) return 'forbidden'
    if (subagent) return 'forbidden'
    if (settings.maxContinues > 0 && state.continues >= settings.maxContinues) {
      // The ending is answered as "not this time"; the turn keeps the kernel's
      // own 「已达到输出 token 上限」 notice, so nothing is silently swallowed —
      // the plugin just stops adding to it.
      // Said once per human turn, not once per exhausted ending: a chain that
      // keeps hitting the ceiling without anyone replying would otherwise log
      // the same warning for every turn in it.
      if (!state.capped) {
        state.capped = true
        ctx.logger.warn(
          `auto-continue: session "${String(session.id)}" reached its configured limit of `
          + `${String(settings.maxContinues)} automatic continuation(s) this turn; `
          + 'send a message to reset the budget, or raise maxContinues in the plugin settings.',
        )
      }
      return 'forbidden'
    }
    try {
      agent.followup(message)
    } catch (error) {
      ctx.logger.warn(
        `auto-continue: could not queue a continuation for session `
        + `"${String(session.id)}": ${renderThrown(error)}`,
      )
      return 'retry'
    }
    state.continues += 1
    return 'sent'
  }

  /**
   * Queue one ceiling ending's continuation once the driver has parked.
   *
   * ## Why a wake must not race the turn's own finalization
   *
   * The kernel drops a wake that arrives while it is not idle:
   * `ReactLoopAgent.wakeDriver()` returns early unless the phase is idle, and
   * only latches `wakeRequested` for a *maintenance* phase. The `hasPending`
   * test that would have opened the continuation turn (`turn()`, the line right
   * after `turn/end` is appended) runs synchronously, while `session/event`
   * handlers are still mid-append. A microtask queued from the `turn/end`
   * handler therefore fires **after** that test has already answered "no work"
   * and the driver has begun parking: the spliced continuation is invisible to
   * the decision that needed it, the wake is dropped because the phase is still
   * `running`, and the message sits in the durable inbox until an unrelated turn
   * (a human typing) claims it. Measured on a live session: the splice landed
   * 13 ms after the ending, and the next `turn/start` came 74 s later, in the
   * same millisecond as the human's message.
   *
   * So the plugin waits for `agent.status === 'idle'` first. At idle the very
   * same `followup()` opens the turn in the same millisecond — `wakeDriver()`'s
   * own contract is that "a wake sent while idle always opens its turn
   * boundary" — and `stillOurs()` still retires the continuation if a human turn
   * won in the meantime. Both `status` and `inbox.nextTurn` are public `Agent`
   * contract, so this needs no kernel internals and never pokes a busy agent.
   *
   * ## Why a list, and why every entry is re-kicked until it is claimed
   *
   * One parked window can cover more than one ending (the continuation turn
   * itself can hit the ceiling before the driver parks again), so entries wait
   * as a list. And a wake can still land a hair before the driver parks, in
   * which case it *looks* sent but never opened a turn. The loop therefore
   * re-kicks any entry whose message is still pending in the inbox.
   *
   * The re-kick is safe because of the order inside the kernel's own `send()`:
   * it splices the inbox — where `ReactLoopInbox.mutate` throws on a duplicate
   * pending id — and only then calls `wakeDriver()`. So a message that is still
   * pending is refused with a throw rather than inserted twice (that throw is
   * caught and logged by `continueTurn`), and a message that was already claimed
   * is no longer pending at all, which retires this wake instead of re-sending
   * it. Either way the durable log cannot gain a second copy of one
   * continuation.
   *
   * @param agent - agent whose ending is being answered.
   * @param session - its session.
   * @param state - its state record.
   * @param turn - the ending turn number.
   * @param delayMs - the configured floor to wait for, if any.
   */
  function scheduleContinuation(agent, session, state, turn, delayMs) {
    const now = Date.now()
    state.wakes.push({
      turn,
      // Built once, here, and handed to `continueTurn` unchanged, so everything
      // downstream — the `isQueued()` re-nudge test and the one-ending-one-message
      // dedup — keeps talking about one identity. A second
      // `continuationMessage()` call inside `continueTurn` would mint a new id and
      // make `isQueued()` answer "not queued" for a message that is in fact in the
      // inbox, silently deleting the re-nudge path (measured: `isQueued` returned
      // false while the inbox held exactly that message).
      message: continuationMessage(resolveSettings(config).promptText, turn),
      readyAt: now + Math.max(delayMs, 0),
      deadlineAt: now + Math.max(delayMs, 0) + WAKE_POLL_DEADLINE_MS,
      sent: false,
    })
    runWake(agent, session, state)
  }

  /** Kick the wake loop if the driver needs it; harmless when already parked. */
  function runWake(agent, session, state) {
    if (state.timers.size > 0) return
    /**
     * Handle of the poll that is currently scheduled.
     *
     * Reassigned on every reschedule so a firing poll deletes *itself*. Deleting
     * the handle `runWake` created instead left one already-fired handle behind
     * per poll — measured as 13 stale handles after 14 schedules — which grew the
     * set across a stall and, because `runWake` reads `size > 0` as "a loop is
     * already running", could wedge the loop for good.
     */
    let current = null
    /** One poll iteration. `poll` is the guard that contains it. */
    const pollOnce = () => {
      if (!isCurrent(agent)) {
        clearWakes(state)
        state.wakes.length = 0
        return
      }
      const now = Date.now()
      // Retire endings the session has already moved past: the watermark
      // advancing past a turn is proof it is no longer the frontier, so its
      // continuation would wake a turn nobody asked for.
      state.wakes = state.wakes.filter((wake) => wake.turn >= state.seen)
      // One ending, one message: two wakes carrying the same message identity
      // would each be sent, and the kernel would then refuse the second insert
      // (`message "…" is already pending`). Deduplicating by the same identity
      // the kernel uses is what keeps "two endings for one turn arm one
      // continuation, not two" true now that the message is stored once per wake.
      const unique = new Map()
      for (const wake of state.wakes) {
        const key = messageIdentity(wake.message)
        if (!unique.has(key)) unique.set(key, wake)
      }
      state.wakes = [...unique.values()]
      const due = state.wakes.filter((wake) => wake.readyAt <= now)
      if (due.length > 0 && agent.status === 'idle') {
        for (const wake of due) {
          try {
            // `isQueued` first, and never both branches: an earlier attempt may
            // have inserted the message and then failed on the wake, so sending
            // again would append a second copy of the same continuation.
            if (isQueued(agent, wake)) {
              // Already in the inbox: an earlier attempt inserted it and then
              // failed on the wake. The driver's own pending test carries it, so
              // the wake is finished — and the budget was already charged by the
              // attempt that queued it, so this branch must not charge again.
              wake.sent = true
              continue
            }
            const outcome = continueTurn(agent, session, state, wake.turn, wake.message)
            if (outcome === 'sent') {
              // Only a send that actually happened retires the wake:
              // `continueTurn` contains `followup()`'s own throws (a
              // transcript-side failure must not take the turn down), so it
              // reports the outcome instead. Marking the wake sent
              // unconditionally made a failed send look delivered and discarded
              // the one retry that could still have continued the turn.
              wake.sent = true
            } else if (outcome === 'forbidden') {
              // Nothing will change by asking again: the plugin is disabled, the
              // session is a subagent, the budget is spent, or the ending is no
              // longer ours. Retiring the wake here is what makes the deadline
              // below reachable — leaving it pending kept the wake permanently
              // `due`, so every poll took the `due.length > 0` branch, the
              // `else if` deadline check never ran, and the loop span forever on
              // a 20 ms timer (measured: 397 polls past a 10 s deadline with the
              // budget exhausted, and a poll loop that never stopped with the
              // plugin disabled).
              wake.sent = true
            } else if (outcome === 'retry') {
              // A send that failed: leave the wake pending so the next poll
              // retries it, up to the deadline.
              wake.deadlineAt = Math.min(wake.deadlineAt, now + WAKE_POLL_DEADLINE_MS)
            }
          } catch (error) {
            // A throw escaping `continueTurn` itself is still contained: nothing
            // may escape a timer callback, which would take the process down.
            ctx.logger.warn(`auto-continue: wake failed: ${renderThrown(error)}`)
            wake.deadlineAt = 0
          }
        }
        // A wake is finished exactly when it has been sent: `followup()` either
        // started the turn or left the message in the inbox for the driver's own
        // pending check, and re-sending would only append a duplicate. Membership
        // in the inbox deliberately does *not* retire a wake — an unsent wake
        // whose message is also not in the inbox is precisely the state that
        // needs the retry, so keying retirement off `isQueued` threw away the
        // retry the doc comment above promises.
        state.wakes = state.wakes.filter((wake) => wake.sent !== true)
      } else if (state.wakes.length > 0) {
        const overdue = state.wakes.filter((wake) => wake.deadlineAt <= now)
        if (overdue.length > 0) {
          state.wakes = state.wakes.filter((wake) => wake.deadlineAt > now)
          if (!state.stalled) {
            state.stalled = true
            ctx.logger.warn(
              `auto-continue: session "${String(session.id)}" never went idle within `
              + `${String(WAKE_POLL_DEADLINE_MS)} ms after hitting the output ceiling; `
              + 'the continuation stays queued and the next message will carry it.',
            )
          }
        }
      }
      if (state.wakes.length > 0) {
        current = setTimeout(poll, WAKE_POLL_MS)
        state.timers.add(current)
      } else {
        clearWakes(state)
      }
    }
    /**
     * The timer callback itself, and the only place a throw could leave the loop.
     *
     * Nothing may escape a timer callback: an `uncaughtException` there terminates
     * the host process outright (measured — a throwing `agent.status` getter on the
     * `due.length > 0` test below escaped the old code entirely). The inner `try`
     * in `pollOnce` contains one wake's failure; this guard contains everything
     * else: the filters, the status read, the reschedule, and even a logger that
     * throws while reporting. The state is left clean rather than wedged, so the
     * next ceiling ending can still arm a wake.
     */
    const poll = () => {
      state.timers.delete(current)
      current = null
      try {
        pollOnce()
      } catch (error) {
        state.wakes.length = 0
        clearWakes(state)
        try {
          ctx.logger.warn(`auto-continue: wake loop failed: ${renderThrown(error)}`)
        } catch { /* a broken logger must not resurrect the throw */ }
      }
    }
    current = setTimeout(poll, 0)
    state.timers.add(current)
  }

  /**
   * Identity of one pending message, as the kernel itself compares them.
   *
   * The kernel refuses a duplicate pending id (`ReactLoopInbox.mutate`), and its
   * inbox projection is rebuilt from **copies**: `session.append` snapshots the
   * payload through `snapshotJsonValue` (dsh-session `append`), and the fold
   * reads that copy back. Object identity therefore never survives a round trip
   * — measured in the live host, `data.inserted[0] === message` is false — so an
   * identity comparison would read "not queued" forever and silently disable
   * every guard built on it. The id is the value that does survive.
   * @param message - pending message.
   * @returns its id when it has one, else the object itself as a last resort.
   */
  function messageIdentity(message) {
    return typeof message?.id === 'string' && message.id.length > 0 ? message.id : message
  }

  /** Whether this wake's message is still sitting in the public inbox. */
  function isQueued(agent, wake) {
    try {
      const inbox = agent.inbox
      if (inbox === undefined || inbox === null) return false
      const lists = [inbox.nextTurn, inbox.nextStep]
      // A list we cannot read is a list we cannot vouch for: answer "not queued"
      // rather than "queued". Claiming a message that is not there would mark the
      // wake finished without ever having sent it — silently dropping the
      // continuation — whereas the other error costs at most one extra
      // `followup()`, which is idempotent for an already-queued message.
      if (!lists.every((list) => Array.isArray(list))) return false
      const wanted = messageIdentity(wake.message)
      return lists.some((list) => list.some((candidate) => messageIdentity(candidate) === wanted))
    } catch {
      return false
    }
  }

  /** Drop every armed timer for one state record. */
  function clearWakes(state) {
    for (const timer of state.timers) clearTimeout(timer)
    state.timers.clear()
  }

  /**
   * Handle one durable session event.
   * @param session - session the event was appended to.
   * @param event - the appended event.
   */
  function onSessionEvent(session, event) {
    let agent
    try {
      agent = ctx.agents.get(session.id)
    } catch {
      return
    }
    if (agent === undefined || agent.session !== session) return
    const state = stateFor(agent)
    if (event.type === 'user/message') {
      if (isHumanMessage(event.data)) {
        // A human took over: the budget restarts and every armed continuation
        // is cancelled, whether it is still waiting for a parked driver or
        // already deferred by `delayMs`. `humanAnswered` is what retires an
        // ending whose continuation has not been queued yet, which is the "the
        // user answered first" race. The turn watermark is deliberately *not*
        // reset — it tracks the session's own turn numbering, which keeps
        // climbing.
        state.continues = 0
        state.capped = false
        state.stalled = false
        state.humanAnswered = true
        state.wakes.length = 0
        clearWakes(state)
      }
      return
    }
    if (event.type !== 'turn/end') return
    const turn = typeof event.data.turn === 'number' ? event.data.turn : 0
    // The watermark tracks the session's own monotonic turn numbering and is
    // advanced by *every* ending, not only the ceiling ones. `turn/end` is
    // durable, so a resumed session, a folded replay, or a retried request can
    // present an ending this session has already answered — and an ending that
    // is not the ceiling is still proof the session moved on, which must retire
    // an armed continuation for an older turn.
    if (turn <= state.seen) return
    state.seen = turn
    // A human message seen before this ending is the turn this ending closed,
    // not an answer to it; only a human message *after* the ending wins the
    // race. Every new ending therefore reopens the race.
    state.humanAnswered = false
    if (!isMaxTokensTurnEnd(event.data.reason)) return
    const settings = resolveSettings(config)
    // `delayMs` is a floor before the wake may start looking, not a rival path:
    // both settings converge on "queue it the moment the driver parks", because
    // queueing it any earlier is exactly what the kernel drops.
    scheduleContinuation(agent, session, state, turn, settings.delayMs)
  }

  /** Render an unknown thrown value for a log line. */
  function renderThrown(value) {
    return value instanceof Error ? value.message : String(value)
  }

  ctx.effect(function* () {
    ctx.on('session/event', (session, event) => {
      try {
        onSessionEvent(session, event)
      } catch (error) {
        // A transcript-side failure must never take the turn down with it.
        ctx.logger.warn(`auto-continue: handler failed: ${renderThrown(error)}`)
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const state = states.get(agent)
      if (state !== undefined) {
        state.wakes.length = 0
        clearWakes(state)
      }
      states.delete(agent)
    })
    yield () => {
      for (const state of states.values()) {
        state.wakes.length = 0
        clearWakes(state)
      }
      states.clear()
    }
  }, 'auto-continue lifecycle')
}

export default { name, inject, Config, apply }
