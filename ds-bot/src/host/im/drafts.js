// Draft stream: the live previews of a Bot's Step messages on one connection. An
// attempt (one streamed step) has a copy per place it goes to; each address sends
// at most one Draft per DRAFT_MS and only the latest pending text. Drafts never
// enter the durable send queue, but a queued message waits for the Draft in flight
// at its address, so a Draft is never shown after its own Step message.
import { randomBytes } from 'node:crypto'
import { addressKey } from './topics.js'
import { classify, recoverMissingTopic } from './errors.js'

// Local conservative policy; Telegram's numeric Draft rate limit is unverified.
const DRAFT_MS = 1000

/**
 * @param {object} deps
 * @param {() => any} deps.connOf the connection's current record
 * @param {any} deps.place Placement
 * @param {(chat: any, draft: { draftId: number, text: string }) => Promise<unknown>} deps.send
 * @param {(chat: any) => Promise<boolean>} deps.recover restores a missing Topic; the
 *   stream learns the new address through `moved`
 * @param {(message: string) => void} deps.warn
 */
export function draftStream({ connOf, place, send, recover, warn }) {
  const attempts = new Map() // attempt key → { sessionId, owner, turn, step, text, copies }
  const addresses = new Map() // address key → { pending?, sending?, timer?, lastAt }
  let nextDraftId = randomBytes(4).readUInt32BE(0) || 1
  let disposed = false

  const flush = (chatKey) => {
    const held = addresses.get(chatKey)
    if (held === undefined || held.pending === undefined || held.sending !== undefined || held.timer !== undefined) return
    const wait = held.lastAt + DRAFT_MS - Date.now()
    if (wait > 0) {
      held.timer = setTimeout(() => {
        held.timer = undefined
        flush(chatKey)
      }, wait)
      held.timer.unref?.()
      return
    }
    const copy = held.pending
    held.pending = undefined
    if (copy.ended || !place.deliverable(connOf(), copy.chat, copy)) return
    held.lastAt = Date.now()
    held.sending = Promise.resolve(send(copy.chat, { draftId: copy.draftId, text: copy.attempt.text }))
      .catch(async caught => {
        let error = caught
        if (disposed) return
        try {
          if (await recoverMissingTopic(error, copy.chat, recover) && !copy.ended && place.deliverable(connOf(), copy.chat, copy)) {
            await send(copy.chat, { draftId: copy.draftId, text: copy.attempt.text })
            return
          }
        } catch (recoveryError) { error = recoveryError }
        warn(String(error?.message ?? error))
        const { retryAfterMs } = classify(error)
        if (retryAfterMs > 0) held.lastAt = Date.now() + retryAfterMs
      })
      .finally(() => {
        held.sending = undefined
        if (!disposed) flush(chatKey)
      })
  }

  const end = (key) => {
    const attempt = attempts.get(key)
    if (attempt === undefined) return
    for (const copy of attempt.copies) {
      copy.ended = true
      const held = addresses.get(addressKey(copy.chat))
      if (held?.pending !== copy) continue
      held.pending = undefined
      clearTimeout(held.timer)
      held.timer = undefined
    }
    attempts.delete(key)
  }

  return {
    /** A streamed step began; an earlier attempt under the same key ends. */
    start(key, { sessionId, owner, turn, step }) {
      end(key)
      attempts.set(key, { sessionId, owner, turn, step, text: '', copies: [] })
    },
    /** Text arrived for an attempt; every place the Draft may go gets the latest text. */
    text(key, delta) {
      const attempt = attempts.get(key)
      if (attempt === undefined) return
      attempt.text += delta
      const targets = place.places(connOf(), attempt.owner, attempt.sessionId, 'draft')
      for (const copy of attempt.copies) {
        if (!targets.some(where => addressKey(where.chat) === addressKey(copy.chat))) copy.ended = true
      }
      for (const { chat, target, output } of targets) {
        if (!attempt.copies.some(copy => !copy.ended && addressKey(copy.chat) === addressKey(chat))) {
          attempt.copies.push({ attempt, target, output, draftId: nextDraftId++, chat })
        }
      }
      for (const copy of attempt.copies) {
        if (copy.ended) continue
        const chatKey = addressKey(copy.chat)
        let held = addresses.get(chatKey)
        if (held === undefined) addresses.set(chatKey, held = { lastAt: 0 })
        held.pending = copy
        flush(chatKey)
      }
    },
    end,
    /** The session's step (or every step, when turn or step is unknown) has its Step message. */
    endStep(sessionId, turn, step) {
      for (const [key, attempt] of attempts) {
        if (attempt.sessionId === sessionId && (turn === undefined || attempt.turn === turn)
          && (step === undefined || attempt.step === step)) end(key)
      }
    },
    /** Ends every Draft of a Bot or DS Bot group chat, for Stop. */
    endTarget(target) {
      for (const [key, attempt] of attempts) {
        if (attempt.copies.some(copy => target.botId !== undefined ? copy.target.botId === target.botId : copy.target.roomId === target.roomId)) end(key)
      }
    },
    /** The live copy shown at `address` under this Draft id, if any. */
    find(address, draftId) {
      for (const attempt of attempts.values()) {
        const copy = attempt.copies.find(copy => copy.draftId === draftId && copy.chat.key === address.key && copy.chat.threadId === address.threadId && !copy.ended)
        if (copy !== undefined) return copy
      }
      return undefined
    },
    /** A Topic was replaced: Drafts at its old thread continue at the new one. */
    moved(chatKey, oldThreadId, threadId) {
      const held = addresses.get(addressKey({ key: chatKey, threadId: oldThreadId }))
      if (held !== undefined) {
        addresses.delete(addressKey({ key: chatKey, threadId: oldThreadId }))
        addresses.set(addressKey({ key: chatKey, threadId }), held)
      }
      for (const attempt of attempts.values()) {
        for (const copy of attempt.copies) {
          if (copy.chat.key === chatKey && copy.chat.threadId === oldThreadId) copy.chat.threadId = threadId
        }
      }
    },
    /** The Draft send in flight at an address, for a queued message to wait on. */
    sending(chatKey) {
      return addresses.get(chatKey)?.sending
    },
    dispose() {
      disposed = true
      for (const held of addresses.values()) clearTimeout(held.timer)
    },
  }
}
