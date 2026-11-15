// One connection's live parts: reserved slot, adapter, Delivery and capability timers.
import { delivery } from './delivery.js'
import { draftStream } from './drafts.js'
import { statusPanels } from './status-panel.js'

const TYPING_MS = 4_000

export function connectionRunners(rt, { connections, platformOf, wants, connect, place, steps, textForChat, panelRecords, savePanels, ensurePrivateTopics, recoverTopic, expirePrivate, syncCards, migrate, message, action, stop: onStop, widgetQuery }) {
  const runners = new Map()
  const statuses = new Map()
  let stopped = false
  let syncing = Promise.resolve()
  const fresh = id => connections()[id]
  const setStatus = (id, next) => {
    // Adapter errors can echo platform responses that quote the token; keep them out of the UI and logs.
    if (typeof next.error === 'string' && next.error !== '') return statuses.set(id, { ...next, error: rt.redactSecrets(next.error), at: Date.now() })
    return statuses.set(id, { ...next, at: Date.now() })
  }
  const onStatus = id => next => {
    const conn = fresh(id)
    if (conn === undefined) return
    setStatus(id, { state: next.state, error: next.error, at: Date.now() })
    if (next.account !== undefined && (conn.account?.id !== next.account.id || conn.account?.name !== next.account.name || conn.account?.hasTopicsEnabled !== next.account.hasTopicsEnabled)) {
      conn.account = next.account
      void rt.save().catch(() => {})
      if (platformOf(conn.platform)?.topics === true) {
        void Promise.all(Object.keys(conn.chats ?? {}).map(chatKey => ensurePrivateTopics(conn, chatKey)))
          .catch(error => rt.warn('ds-bot: im topics failed: %s', rt.redactSecrets(String(error?.message ?? error))))
      }
    }
  }
  const busyOf = target => {
    if (target?.botId !== undefined) return rt.live.get(rt.chatOf(target.botId))?.turn !== undefined
    if (target?.roomId !== undefined) return (rt.roomWorkView?.()[target.roomId] ?? []).length > 0
    return false
  }
  const stop = async id => {
    const runner = runners.get(id)
    runners.delete(id)
    const delivered = runner?.delivery.close()
    if (runner?.typing !== undefined) clearInterval(runner.typing)
    clearInterval(runner?.privateTimer)
    runner?.panels?.stop()
    runner?.drafts?.dispose()
    await Promise.resolve(runner?.handle?.stop?.()).catch(() => {})
    await delivered
    if (statuses.get(id)?.state !== 'error') setStatus(id, { state: 'off', at: Date.now() })
  }
  const start = async conn => {
    if (runners.has(conn.id)) return
    const platform = platformOf(conn.platform)
    // Reserve before connecting: concurrent syncs must see the same slot.
    const runner = { connection: () => fresh(conn.id), handle: undefined, delivery: undefined, typing: undefined, drafts: undefined }
    const recover = chat => {
      const current = runner.connection()
      return current === undefined ? false : recoverTopic(current, chat)
    }
    runner.delivery = delivery({
      connection: runner.connection, placement: place,
      sending: key => runner.drafts?.sending(key),
      recoverTopic: recover,
      setStatus: next => { if (runner.connection() !== undefined) setStatus(conn.id, next) },
      warn: (template, error) => rt.warn(template, rt.redactSecrets(String(error?.message ?? error))),
    })
    runners.set(conn.id, runner)
    setStatus(conn.id, { state: 'connecting', at: Date.now() })
    try {
      const handle = await connect(conn, {
        onMessage: msg => {
          const current = runner.connection()
          return current === undefined ? undefined : message(current, msg).catch(error => rt.warn('ds-bot: im message failed: %s', error))
        },
        onAction: event => {
          const current = runner.connection()
          return current === undefined ? undefined : action(current, event).catch(error => rt.warn('ds-bot: im action failed: %s', error))
        },
        onStop: event => {
          const current = runner.connection()
          return current === undefined ? undefined : onStop(current, event).catch(error => rt.warn('ds-bot: im stop failed: %s', error))
        },
        onWidgetQuery: event => {
          const current = runner.connection()
          return current === undefined ? undefined : widgetQuery(current, event).catch(error => rt.warn('ds-bot: widget query failed: %s', error))
        },
        onStatus: onStatus(conn.id),
      })
      if (runners.get(conn.id) !== runner) {
        void Promise.resolve(handle?.stop?.()).catch(() => {})
        return
      }
      runner.handle = handle
      if (platform?.drafts === true) {
        runner.drafts = draftStream({
          connOf: runner.connection,
          // Placement's other callers retain their own fallback policy.
          place: {
            places: (current, ...args) => current === undefined ? [] : place.places(current, ...args),
            deliverable: (current, ...args) => current !== undefined && place.deliverable(current, ...args),
          },
          send: (chat, draft) => handle.draft(chat, draft),
          recover: async chat => platformOf(conn.platform)?.topics === true && await recover(chat),
          warn: text => rt.warn('ds-bot: im draft failed: %s', rt.redactSecrets(text)),
        })
      }
      if (platform?.statusPanel === true) {
        runner.panels = statusPanels(handle, {
          rt, steps, records: await panelRecords(conn.id),
          textForChat: chat => textForChat(runner.connection(), chat.key),
          deliverable: (chat, target) => {
            const current = runner.connection()
            return current !== undefined && place.deliverable(current, chat, { target })
          },
          save: () => { if (runner.connection() !== undefined) savePanels(conn.id) },
          recover,
          warn: error => rt.warn('ds-bot: Status panel update failed: %s', rt.redactSecrets(String(error?.message ?? error))),
        })
      }
      if (runners.get(conn.id) !== runner) {
        runner.panels?.stop()
        runner.drafts?.dispose()
        return
      }
      runner.delivery.attach(handle)
      if (platform?.topics === true) {
        for (const chatKey of Object.keys(conn.chats ?? {})) await ensurePrivateTopics(conn, chatKey)
        if (runners.get(conn.id) !== runner) return
      }
      if (platform?.typing === true) {
        runner.typing = setInterval(() => {
          const current = runner.connection()
          if (current === undefined) return
          const owners = [...Object.keys(rt.state.bots).map(botId => ({ botId })), ...Object.keys(rt.state.rooms).map(roomId => ({ roomId }))]
          for (const owner of owners) {
            if (!busyOf(owner)) continue
            const sessionId = owner.botId === undefined ? owner.roomId : rt.chatOf(owner.botId)
            for (const { chatKey, chat } of place.places(current, owner, sessionId, 'typing')) {
              void runner.handle.typing({ key: chatKey, kind: chat.kind, title: chat.title, ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }) }).catch?.(() => {})
            }
          }
        }, TYPING_MS)
        runner.typing.unref?.()
      }
      if (platform?.privateCards === true) {
        runner.privateTimer = setInterval(() => {
          const current = runner.connection()
          if (current !== undefined) void expirePrivate(current).catch(error => rt.warn('ds-bot: Private card fallback failed: %s', error))
        }, 1000)
        runner.privateTimer.unref?.()
      }
      await syncCards()
    } catch (error) {
      if (runners.get(conn.id) === runner) await stop(conn.id)
      setStatus(conn.id, { state: 'error', error: String(error?.message ?? error).slice(0, 300), at: Date.now() })
    }
  }
  const sync = () => {
    const run = syncing.then(async () => {
      const conns = connections()
      const saving = migrate()
      if (saving !== undefined) await saving
      for (const conn of Object.values(conns)) {
        const wanted = stopped !== true && wants(conn)
        if (wanted && !runners.has(conn.id)) await start(conn)
        else if (!wanted && runners.has(conn.id)) await stop(conn.id)
        if (wanted && platformOf(conn.platform)?.topics === true) {
          for (const chatKey of Object.keys(conn.chats ?? {})) await ensurePrivateTopics(conn, chatKey)
        }
      }
      for (const id of [...runners.keys()]) if (conns[id] === undefined) await stop(id)
      for (const id of [...statuses.keys()]) if (conns[id] === undefined) statuses.delete(id)
      for (const conn of Object.values(conns)) {
        if (conn.enabled === false || !runners.has(conn.id)) {
          if (statuses.get(conn.id)?.state !== 'error') setStatus(conn.id, { state: 'off', at: Date.now() })
        }
      }
    })
    syncing = run.catch(() => {})
    return run
  }
  return {
    get: id => runners.get(id), has: id => runners.has(id),
    * running() {
      for (const conn of Object.values(connections())) {
        const runner = runners.get(conn.id)
        if (runner !== undefined) yield { conn, runner }
      }
    },
    sync, stop,
    restart: async id => { if (runners.has(id)) await stop(id); await sync() },
    statusView: () => Object.fromEntries([...statuses.entries()].map(([id, status]) => [id, { state: status.state, ...(status.error !== undefined ? { error: status.error } : {}), at: status.at }])),
    teardown: () => { stopped = true; return Promise.all([...runners.keys()].map(stop)) },
  }
}
