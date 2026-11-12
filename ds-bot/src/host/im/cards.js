// The Card journal: every Card copy the Bridge sent, its answer and the edit that
// settles it. Records live in each connection's runtime file (`store`), so a
// restart neither sends a Card twice nor forgets an answer. One journal serves
// every connection; what each Card kind means stays with its caller.
import { imPlatform } from '../../shared/im-platforms.js'
import { addressKey } from './topics.js'

const PRIVATE_MS = 5 * 60 * 1000

// The Settled card rule: the answer shows and only the chosen options stay.
export const settledCard = (card, answer, labels) => ({
  answer,
  options: card.options.filter(option => option.submit !== true && labels.includes(option.label)).map(({ label, style }) => ({ label, ...(style ? { style } : {}) })),
})

/**
 * @param {object} deps
 * @param {{of: (id: string) => Promise<{cards: object}>, peek: (id: string) => {cards: object}|undefined, save: (id: string) => void}} deps.store
 * @param {(conn: object) => (cardKey: string, entries: object[]) => boolean} deps.sourceOpen  whether the thing a Card asks about still waits
 */
export function cardJournal({ store, connections, textForChat, textForPerson, handleOf, enqueue, paired, sourceOpen, warn, readOnly }) {
  // Public copies of expired Private cards already queued, per adapter handle: a
  // restarted connection has a new handle and queues them again.
  const privateQueued = new WeakMap()
  const editing = new WeakMap()
  const pendingClaims = new Map()
  // Keep the answer available to every read while its unloaded journal is read in.
  const records = (id, data = store.peek(id)) => {
    const pending = pendingClaims.get(id)
    if (data !== undefined && pending !== undefined) {
      pendingClaims.delete(id)
      const conn = connections()[id]
      if (conn !== undefined) {
        for (const [cardKey, request] of pending) {
          request.rollback = claim(conn, cardKey, request.answer, request.selected, data)
        }
      }
    }
    return data
  }
  const addressOf = (conn, entry) => {
    const chat = conn.chats?.[entry.chatKey]
    return chat === undefined ? undefined : { key: entry.chatKey, kind: chat.kind, title: chat.title, ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }) }
  }
  // A Private card speaks to its receiver, falling back to the chat's language
  // when Telegram did not report theirs; a shared copy speaks to the chat.
  const textOf = (conn, entry) => entry.receiverUserId === undefined
    ? textForChat(conn, entry.chatKey)
    : textForPerson(conn, { id: entry.receiverUserId, languageCode: entry.languageCode ?? conn?.chats?.[entry.chatKey]?.languageCode })

  const record = async (id, cardKey, chat, messageId, body, card, cardFormat, copy = {}) => {
    const data = records(id, await store.of(id))
    const entries = data.cards[cardKey] ?? []
    const held = entries.find(entry => entry.chatKey === chat.key && entry.threadId === chat.threadId && entry.receiverUserId === copy.receiverUserId)
    if (held !== undefined) {
      held.messageId = messageId ?? held.messageId
      held.text = body ?? held.text
      held.card ??= card
      held.cardFormat = cardFormat ?? held.cardFormat
      Object.assign(held, copy)
    } else {
      entries.push({ chatKey: chat.key, ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }), messageId, text: body, ...(card === undefined ? {} : { card }), ...copy })
    }
    data.cards[cardKey] = entries
    store.save(id)
  }

  // Sets the answer on every copy without editing: a second press already sees it.
  const claim = (conn, cardKey, answer, selected, data = records(conn.id)) => {
    if (data === undefined) {
      let pending = pendingClaims.get(conn.id)
      if (pending === undefined) pendingClaims.set(conn.id, pending = new Map())
      if (pending.has(cardKey)) return
      const request = { answer, selected }
      pending.set(cardKey, request)
      request.loading = store.of(conn.id).then(loaded => records(conn.id, loaded))
        .catch(error => warn('ds-bot: im pending card answer not saved: %s', error))
      return async () => {
        if (pendingClaims.get(conn.id)?.get(cardKey) === request) {
          pending.delete(cardKey)
          if (pending.size === 0) pendingClaims.delete(conn.id)
        }
        await request.rollback?.()
      }
    }
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    const claimed = []
    for (const entry of entries) {
      if (entry.answer !== undefined) continue
      entry.answer = typeof answer === 'function' ? answer(textOf(connections()[conn.id], entry)) : answer
      claimed.push(entry)
      delete entry.edited
      if (entry.card !== undefined) entry.card.settled = settledCard(entry.card, entry.answer, selected ?? [entry.answer])
    }
    store.save(conn.id)
    if (claimed.length === 0) return
    return async () => {
      // Delivery failed: reopen only copies this claim answered, even if a save
      // already edited and pruned them while the source was absent.
      data.cards[cardKey] ??= entries
      for (const entry of claimed) {
        delete entry.answer
        if (entry.card !== undefined) delete entry.card.settled
        if (entry.edited !== undefined) entry.edited = false
      }
      store.save(conn.id)
      await Promise.all(claimed.map(entry => editing.get(entry)))
      await edits(conn)
    }
  }

  // Buttons drop and the answer shows wherever a copy was answered; a failed edit
  // is retried by the next one.
  const edits = async (conn) => {
    const handle = handleOf(conn.id)
    const data = records(conn.id)
    if (handle?.edit === undefined || data === undefined) return
    for (const entries of Object.values(data.cards)) {
      for (const entry of entries) {
        if (entry.deleted || (entry.answer === undefined && entry.edited !== false) || (entry.messageId === undefined && entry.ephemeralMessageId === undefined) || entry.edited === true) continue
        const address = addressOf(conn, entry)
        if (address === undefined) continue
        entry.edited = true
        const body = entry.answer === undefined ? entry.text : entry.text !== undefined ? `${entry.text}\n— ${entry.answer}` : `(${textForChat(conn, entry.chatKey)('answered')})`
        const edit = entry.receiverUserId !== undefined && typeof handle.editPrivateCard === 'function'
          ? handle.editPrivateCard(address, entry, entry.card)
          : entry.card !== undefined && imPlatform(conn.platform)?.richCards === true && typeof handle.editCard === 'function'
            ? handle.editCard(address, entry.messageId, entry.card, entry.cardFormat)
            : handle.edit(address, entry.messageId, { text: body })
        const pending = edit.catch(error => {
          entry.edited = false
          if (!error?.stopped) warn('ds-bot: im settled card edit failed: %s', error)
        })
        editing.set(entry, pending)
        await pending
        editing.delete(entry)
        store.save(conn.id)
      }
    }
  }

  return {
    // Shutdown must wait for applying claims, not just reading their runtime files.
    flushClaims: () => Promise.all([...pendingClaims.values()].flatMap(pending => [...pending.values()].map(request => request.loading))),
    // A re-enabled connection must also edit answers claimed while it was off.
    load: async id => {
      const data = records(id, await store.of(id))
      const conn = connections()[id]
      if (conn !== undefined) await edits(conn)
      return data
    },
    // Whether a Card was already sent on this connection, by key.
    sent: (id, cardKey) => records(id)?.cards[cardKey] !== undefined,

    // A group Card started by a paired person goes to that person alone first,
    // when the platform can; it is recorded before it is queued, so a Card the
    // queue drops is never sent again.
    send: async (conn, cardKey, targets, body, buttons, structured, initiator) => {
      for (const { chat, target, output } of targets) {
        const handle = handleOf(conn.id)
        const privateCard = chat.kind === 'group' && initiator !== undefined && paired(conn, initiator.sender.id)
          && imPlatform(conn.platform)?.privateCards === true && typeof handle?.sendPrivateCard === 'function'
        const copy = { target, ...(privateCard ? { receiverUserId: initiator.sender.id, languageCode: initiator.sender.languageCode, privateUntil: Date.now() + PRIVATE_MS } : {}) }
        const text = privateCard ? textForPerson(conn, initiator.sender) : textForChat(conn, chat.key)
        const rendered = typeof body === 'function' ? body(text) : body
        const renderedButtons = typeof buttons === 'function' ? buttons(text) : buttons
        const card = imPlatform(conn.platform)?.richCards === true && typeof handle?.sendCard === 'function' ? structured?.(text) : undefined
        await record(conn.id, cardKey, chat, undefined, rendered, card, undefined, copy)
        enqueue(conn, addressKey(chat), { chat, target, output, text: rendered, buttons: renderedButtons, card, ...copy, after: async (sent) => {
          await record(conn.id, cardKey, chat, sent?.messageId, rendered, card, sent?.cardFormat, { ...copy, ...(sent?.ephemeralMessageId === undefined ? {} : { ephemeralMessageId: sent.ephemeralMessageId, ephemeralMessageIds: sent.ephemeralMessageIds }) })
          await edits(conn)
        } })
      }
    },

    settle: async (conn, cardKey, answer, selected) => {
      await claim(conn, cardKey, answer, selected)
      await edits(conn)
    },
    claim,
    edits,

    // One copy this chat was sent and has not answered yet. A button names its own
    // Card, so it must never fall through to a newer Card of the same kind.
    open: (conn, chat, cardKey, action) => {
      const entry = records(conn.id)?.cards[cardKey]?.findLast(item => item.chatKey === chat.key && item.threadId === chat.threadId && item.answer === undefined && !item.deleted
        && (action?.ephemeralMessageId === undefined || (item.ephemeralMessageId === action.ephemeralMessageId && item.receiverUserId === action.receiverUserId)))
      return entry === undefined ? undefined : { cardKey, entry }
    },
    // The chat's newest open copy among the kinds `answerable` admits.
    newest: (conn, chat, answerable) => {
      const data = records(conn.id)
      if (data === undefined) return undefined
      for (const [cardKey, entries] of Object.entries(data.cards).reverse()) {
        if (!answerable(cardKey)) continue
        const entry = entries.findLast(item => item.chatKey === chat.key && item.threadId === chat.threadId && item.answer === undefined && !item.deleted)
        if (entry !== undefined) return { cardKey, entry }
      }
      return undefined
    },
    byMessage: (conn, chat, cardKey, messageId) => records(conn.id)?.cards[cardKey]?.find(item => item.chatKey === chat.key
      && item.threadId === chat.threadId && item.messageId === messageId),

    // A copy whose Card changed in place (a multi-select tick) is saved and redrawn.
    redraw: async (conn, chat, entry) => {
      store.save(conn.id)
      if (entry.messageId !== undefined) await handleOf(conn.id).editCard(chat, entry.messageId, entry.card, entry.cardFormat)
    },

    // An unanswered Private card past its time gets a public copy; once that is
    // sent the private one is deleted.
    expirePrivate: async (conn) => {
      const handle = handleOf(conn.id)
      const data = records(conn.id)
      if (handle === undefined || data === undefined || readOnly()) return
      if (!privateQueued.has(handle)) privateQueued.set(handle, new WeakSet())
      const queued = privateQueued.get(handle)
      for (const entries of Object.values(data.cards)) {
        for (const entry of entries) {
          if (entry.receiverUserId === undefined || entry.deleted) continue
          const address = addressOf(conn, entry)
          if (address === undefined) continue
          let publicCopy = entries.find(copy => copy.chatKey === entry.chatKey && copy.threadId === entry.threadId && copy.receiverUserId === undefined)
          if (entry.answer === undefined && Date.now() >= entry.privateUntil && publicCopy === undefined) {
            publicCopy = { chatKey: entry.chatKey, text: entry.text, card: structuredClone(entry.card), threadId: entry.threadId, target: entry.target }
            entries.push(publicCopy)
            store.save(conn.id)
          }
          if (publicCopy !== undefined && publicCopy.messageId === undefined && !queued.has(publicCopy)) {
            queued.add(publicCopy)
            const copy = publicCopy
            enqueue(conn, addressKey(address), { chat: address, card: copy.card, after: async sent => {
              copy.messageId = sent?.messageId
              copy.cardFormat = sent?.cardFormat
              queued.delete(copy)
              store.save(conn.id)
              await edits(conn)
            } })
            store.save(conn.id)
          }
          if (publicCopy?.messageId !== undefined && entry.ephemeralMessageId !== undefined) {
            await handle.deletePrivateCard(address, entry)
            entry.deleted = true
            entry.edited = true
            store.save(conn.id)
          }
        }
      }
    },

    // A Card answered elsewhere settles here too; once its copies are settled and
    // edited where the platform can edit, it is dropped so the file stays small.
    settleGone: async () => {
      for (const conn of Object.values(connections())) {
        const data = records(conn.id)
        if (data === undefined) continue
        const open = sourceOpen(conn)
        let touched = false
        for (const [cardKey, entries] of Object.entries(data.cards)) {
          if (open(cardKey, entries)) continue
          for (const entry of entries) {
            if (entry.answer === undefined) {
              entry.answer = textOf(conn, entry)('answered')
              if (entry.card !== undefined) entry.card.settled = settledCard(entry.card, entry.answer, [])
              touched = true
            }
          }
        }
        if (touched) store.save(conn.id)
        await edits(conn)
        const editable = handleOf(conn.id)?.edit !== undefined
        let pruned = false
        for (const [cardKey, entries] of Object.entries(data.cards)) {
          if (open(cardKey, entries)) continue
          const droppable = entries.length === 0 || entries.every(entry => entry.answer !== undefined
            && (entry.edited === true || (entry.messageId === undefined && entry.ephemeralMessageId === undefined) || !editable || conn.chats?.[entry.chatKey] === undefined))
          if (droppable) {
            delete data.cards[cardKey]
            pruned = true
          }
        }
        if (pruned) store.save(conn.id)
      }
    },

    // A restored Topic takes the copies not yet sent to the old one.
    moved: async (id, chatKey, oldThreadId, threadId) => {
      const data = records(id, await store.of(id))
      for (const entries of Object.values(data.cards)) {
        for (const entry of entries) {
          if (entry.chatKey === chatKey && entry.threadId === oldThreadId && entry.messageId === undefined && entry.ephemeralMessageId === undefined) entry.threadId = threadId
        }
      }
      store.save(id)
    },
  }
}
