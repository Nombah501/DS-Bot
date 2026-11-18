// IM: talk to Bots from chat apps. A connection is one IM bot account bound to a Bot;
// direct chats reach that Bot, platform group chats can be bound to a DS Bot group.
// The platform adapters (im/platforms/) own the wire; placement.js decides where output
// goes; cards.js keeps the Card journal; card-kinds.js owns DSH-sourced Cards;
// delivery.js owns queued sends. This module owns pairing and event routing.
import { randomBytes } from 'node:crypto'
import { viewCardText } from '../parts.js'
import { imPlatform, IM_PLATFORMS } from '../../shared/im-platforms.js'
import { adapters } from './platforms/index.js'
import { cleanAccess, migrateTopics, topics } from './topics.js'
import { placement } from './placement.js'
import { connectionRunners } from './runners.js'
import { runtimeStore } from './runtime-store.js'
import { cardJournal } from './cards.js'
import { cardKinds } from './card-kinds.js'
import { chatRecords } from './chat-record.js'
import { inbound } from './inbound.js'
import { localeOf, translate } from './locale.js'
import { forumBinder } from './forum-bind.js'
import { stops } from './stop.js'

const RECONCILE_MS = 15_000

const secretField = key => key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()

export function install(rt) {
  const { ctx, state } = rt
  const store = runtimeStore(rt)
  // Telegram notices follow one Paired person: their /lang choice, else their
  // Telegram language. Other platforms, and unknown people, use DS Bot's language.
  const translator = (conn, who) => (key, values) => {
    if (imPlatform(conn.platform)?.personLanguage !== true) return translate(localeOf({ uiLanguage: rt.uiLanguage?.() }), key, values)
    const { personId, languageCode } = who()
    const preference = conn.paired?.find(person => person.id === personId)?.language
    return translate(localeOf({ preference, languageCode, uiLanguage: rt.uiLanguage?.() }), key, values)
  }
  // Answers to someone who just wrote or pressed: that sender.
  const textForPerson = (conn, sender) => translator(conn, () => ({ personId: sender?.id, languageCode: sender?.languageCode }))
  // Output to a chat: its owner in a private chat, its last speaker in a group.
  const textForChat = (conn, chatKey) => translator(conn, () => {
    const saved = conn.chats?.[chatKey]
    return { personId: saved?.personId ?? saved?.lastSenderId, languageCode: saved?.languageCode }
  })

  // ------------------------------------------------------------- connections
  let topicsMigrated = false
  const connections = () => {
    const conns = (state.im ??= { connections: {} }).connections
    for (const conn of Object.values(conns)) if (imPlatform(conn.platform)?.topics === true) topicsMigrated = migrateTopics(conn) || topicsMigrated
    return conns
  }
  const records = chatRecords(rt, { connections })
  const adaptersFor = () => Object.keys(adapters)
  const hasSecrets = conn => Object.values(conn.secrets ?? {}).every(name => rt.secretValue(name) !== undefined)
  const fieldsOf = (conn) => {
    const fields = { ...conn.settings }
    for (const [key, name] of Object.entries(conn.secrets ?? {})) fields[key] = rt.secretValue(name)
    return fields
  }
  // The reason a request failed, with the chain under it: `fetch failed` alone
  // hides the DNS, TLS or connection error that the user needs (#1120).
  const reasonOf = (error) => {
    const parts = []
    for (let at = error, depth = 0; at !== undefined && at !== null && depth < 4; at = at.cause, depth += 1) {
      const text = typeof at === 'string' ? at : at?.message
      if (typeof text === 'string' && text.trim() !== '' && !parts.includes(text.trim())) parts.push(text.trim())
    }
    return parts.length === 0 ? 'The connection failed' : parts.join(': ')
  }

  // The reason can quote the request URL, and a platform URL carries the token:
  // keep the secret field values, also as they appear in a URL, out of the text before it
  // reaches the UI or the log.
  const scrub = (text, fields, platform) => {
    let out = text
    for (const field of platform.fields) {
      const value = fields[field.key]
      if (!field.secret || typeof value !== 'string' || value.length < 4) continue
      for (const form of new Set([value, encodeURIComponent(value)])) out = out.split(form).join('***')
    }
    return out
  }
  const checkAccount = async (platform, fields, env) => {
    try {
      return await adapters[platform.id].check(fields, env)
    } catch (error) {
      throw new Error(scrub(rt.redactSecrets(reasonOf(error)), fields, platform))
    }
  }

  const envFor = async (conn, runtime) => ({
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    config: rt.config.im?.[conn.platform],
    runtime: runtime ?? await store.runtime(conn.id),
    log: { warn: (template, ...args) => rt.warn(template, ...args) },
    uploadFile: async (sessionId, file) => {
      const uploads = ctx.get?.('fileUploads')
      if (typeof uploads?.uploadStream !== 'function') throw new Error('no upload service')
      const data = file.data?.[Symbol.asyncIterator] !== undefined ? file.data : (async function* () { yield file.data })()
      const value = await uploads.uploadStream({ sessionId, data, name: file.name })
      return value.receiptId
    },
  })

  const place = placement({
    connections,
    store,
    botOf: id => rt.botOf(id),
    roomOf: id => rt.roomOf(id),
    chatOf: id => rt.chatOf(id),
    roomActive: id => rt.roomActive?.(id) || (rt.roomWorkView?.()[id] ?? []).length > 0,
  })
  const cards = cardJournal({
    store,
    connections,
    textForChat,
    textForPerson,
    handleOf: id => runners.get(id)?.handle,
    deliveryOf: id => runners.get(id)?.delivery,
    paired: (conn, personId) => paired(conn, personId),
    sourceOpen: conn => stopping.sourceOpen(conn),
    warn: (template, ...args) => rt.warn(template, ...args),
    readOnly: () => rt.readOnly() !== undefined,
  })

  // ------------------------------------------------------------------ send out
  const topicLifecycle = topics(rt, {
    connections, handleOf: id => runners.get(id)?.handle, textForChat,
    deliverable: (conn, address, target) => place.deliverable(conn, address, { target }),
    replaced: [
      (connId, chatKey, oldThreadId, threadId) => runners.get(connId)?.drafts?.moved(chatKey, oldThreadId, threadId),
      (connId, chatKey, oldThreadId, threadId) => cards.moved(connId, chatKey, oldThreadId, threadId),
      async (connId, chatKey, oldThreadId, threadId) => {
        const data = await store.of(connId)
        for (const panel of data.panels) {
          if (panel.chat.key === chatKey && panel.chat.threadId === oldThreadId) {
            panel.chat.threadId = threadId
            delete panel.messageId
          }
        }
        store.save(connId)
      },
    ],
  })
  const ensurePrivateTopics = topicLifecycle.ensure
  const recoverTopic = async (conn, chat) => {
    const threadId = await topicLifecycle.restore(conn, chat)
    if (threadId === undefined) return false
    chat.threadId = threadId
    return true
  }

  const sendText = (conn, chat, body, buttons) => {
    void runners.get(conn.id)?.delivery.notice(chat, { text: body, buttons })
  }

  // ----------------------------------------------------------------- inbound
  const paired = (conn, senderId) => (conn.paired ?? []).some(entry => entry.id === senderId)

  const targetName = (conn, target) => {
    if (target?.botId !== undefined) return rt.botOf(target.botId)?.name
    if (target?.roomId !== undefined) return rt.roomOf(target.roomId)?.name
    return undefined
  }

  const kinds = cardKinds(rt, {
    cards, place, connections,
    handleOf: id => runners.get(id)?.handle,
    running: id => runners.has(id),
    sendText, textForPerson,
  })
  const stopping = stops(rt, {
    cards, place, runnerOf: id => runners.get(id),
    sendText, textForPerson, textForChat, sourceOpen: kinds.sourceOpen,
  })

  const forumBind = forumBinder(rt, { connections, topics: topicLifecycle, handleOf: id => runners.get(id)?.handle, deliveryOf: id => runners.get(id)?.delivery, sendText, sendCardReply: stopping.reply, textForPerson, may: place.may })

  const incoming = inbound(
    rt,
    {
      records, place, kinds, forumBind, connections,
      deliveryOf: id => runners.get(id)?.delivery,
      showStatus: stopping.show,
      textForPerson, targetName, stopTarget: stopping.target, envFor,
    },
  )

  const onAction = (conn) => async (action) => {
    if (!paired(conn, action.sender.id)) {
      if (stopping.handles(conn, action)) await stopping.unpaired(conn, action)
      return
    }
    await records.heard(conn.id, action.chat.key, action.sender)
    const data = String(action.data ?? '')
    if (imPlatform(conn.platform)?.topics === true && data.startsWith('b:')) {
      await forumBind.action(conn, action)
      return
    }
    if (stopping.handles(conn, action)) {
      await stopping.press(conn, action)
      return
    }
    await kinds.press(conn, action)
  }

  const syncCards = async () => {
    if (rt.readOnly() !== undefined) return
    for (const conn of Object.values(connections())) await kinds.sync(conn)
  }

  // ---------------------------------------------------------------- lifecycle
  const runners = connectionRunners(rt, {
    connections, platformOf: imPlatform, place, steps: stopping.steps, textForChat,
    wants: conn => adapters[conn.platform] !== undefined && conn.enabled !== false
      && rt.readOnly() === undefined && hasSecrets(conn),
    connect: async (conn, handlers) => {
      const adapter = adapters[conn.platform]
      const env = await envFor(conn)
      return adapter.connect(fieldsOf(conn), env, handlers)
    },
    store,
    ensurePrivateTopics, recoverTopic,
    expirePrivate: conn => cards.expirePrivate(conn),
    syncCards,
    migrate: () => {
      if (topicsMigrated && rt.readOnly() === undefined) {
        topicsMigrated = false
        return rt.save()
      }
    },
    message: (conn, msg) => incoming.message(conn, msg),
    action: (conn, action) => onAction(conn)(action),
    stop: stopping.draft,
    widgetQuery: stopping.widgetQuery,
  })
  const sync = runners.sync

  // ---------------------------------------------------------------- endpoints
  const secretName = (conn, key) => `IM_${conn.platform.toUpperCase()}_${conn.id.slice(3, 9).toUpperCase()}_${secretField(key)}`
  const cleanFields = (platform, fields, base = {}) => {
    const given = fields !== null && typeof fields === 'object' ? fields : {}
    const out = {}
    for (const field of platform.fields) {
      const value = given[field.key]
      if (field.options !== undefined) {
        out[field.key] = field.options.some(([id]) => id === value) ? value
          : (value === undefined && base[field.key] !== undefined ? base[field.key] : field.options[0][0])
      } else if (typeof value === 'string' && value.trim() !== '') {
        out[field.key] = value.trim()
      } else if (!field.secret) {
        if (value !== undefined && typeof value !== 'string') throw new Error(`${field.label} must be text`)
        out[field.key] = value === undefined && base[field.key] !== undefined ? base[field.key] : ''
      }
      // Missing secret fields are allowed only on update, where the saved one stays.
    }
    return out
  }

  const saveSecrets = async (conn, platform, fields) => {
    for (const field of platform.fields) {
      if (!field.secret || fields[field.key] === undefined) continue
      const name = conn.secrets[field.key] ?? secretName(conn, field.key)
      await rt.secretEndpoint('secret-set', { name, value: fields[field.key], purpose: `${platform.name} IM bot`, scope: [] })
      conn.secrets[field.key] = name
    }
  }

  const viewOf = (conn) => ({
    id: conn.id,
    platform: conn.platform,
    account: conn.account ?? null,
    botId: conn.botId ?? null,
    settings: conn.settings ?? {},
    ...(imPlatform(conn.platform)?.topics === true ? { nonTelegramTurns: conn.nonTelegramTurns ?? 'all' } : {}),
    secrets: Object.keys(conn.secrets ?? {}),
    enabled: conn.enabled !== false,
    paired: conn.paired ?? [],
    requests: conn.requests ?? [],
    chats: Object.fromEntries(Object.entries(conn.chats ?? {}).map(([key, chat]) => [key, { ...chat }])),
    createdAt: conn.createdAt,
  })

  const endpoints = {
    async 'im-add'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      if (platform === undefined || adapters[platform.id] === undefined) throw new Error('This platform is not available yet')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      if (platform.login === 'qr') throw new Error('This platform signs in by scanning a code; not available yet')
      const fields = cleanFields(platform, body.fields)
      for (const field of platform.fields) {
        if (!field.options && (fields[field.key] === undefined || String(fields[field.key]).trim() === '')) throw new Error(`${field.label} is required`)
      }
      const env = await envFor({ id: 'im_check', platform: platform.id, settings: fields, secrets: {} }, { get: () => ({}), set: () => {} })
      const { account } = await checkAccount(platform, fields, env)
      const conn = {
        id: `im_${randomBytes(4).toString('hex')}`,
        platform: platform.id,
        account,
        botId: bot.id,
        settings: Object.fromEntries(platform.fields.filter(field => !field.secret).map(field => [field.key, fields[field.key]])),
        secrets: {},
        enabled: true,
        paired: [],
        requests: [],
        chats: {},
        createdAt: Date.now(),
      }
      await saveSecrets(conn, platform, fields)
      connections()[conn.id] = conn
      await rt.save()
      await sync()
      return viewOf(conn)
    },
    async 'im-update'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const platform = imPlatform(conn.platform)
      if (platform === undefined) throw new Error('No such platform')
      if (body.nonTelegramTurns !== undefined) {
        if (platform.topics !== true || !['all', 'cards', 'none'].includes(body.nonTelegramTurns)) throw new Error('Choose all messages, Cards only or nothing')
        conn.nonTelegramTurns = body.nonTelegramTurns
      }
      if (body.botId !== undefined) {
        const bot = rt.botOf(String(body.botId))
        if (bot === undefined) throw new Error('Choose a Bot first')
        conn.botId = bot.id
      }
      if (body.enabled !== undefined) conn.enabled = body.enabled === true
      if (body.fields !== undefined) {
        const fields = cleanFields(platform, body.fields, conn.settings)
        const env = await envFor(conn)
        const check = { ...fields }
        for (const field of platform.fields) {
          if (field.secret && check[field.key] === undefined) check[field.key] = rt.secretValue(conn.secrets[field.key])
        }
        const { account } = await checkAccount(platform, check, env)
        conn.account = account
        await saveSecrets(conn, platform, fields)
        for (const field of platform.fields) {
          if (!field.secret && fields[field.key] !== undefined) conn.settings[field.key] = fields[field.key]
        }
      }
      await rt.save()
      await runners.restart(conn.id)
      return viewOf(conn)
    },
    async 'im-remove'(body) {
      const id = String(body.id ?? '')
      const conn = connections()[id]
      if (conn === undefined) throw new Error('No such IM bot')
      await runners.stop(id)
      for (const name of Object.values(conn.secrets ?? {})) {
        await rt.secretEndpoint('secret-delete', { name }).catch(() => {})
      }
      delete connections()[id]
      runners.forget(id)
      await store.remove(id)
      await rt.save()
      return true
    },
    async 'im-pair'(body) {
      let conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const at = (conn.requests ?? []).findIndex(entry => entry.id === String(body.senderId ?? ''))
      if (at === -1) throw new Error('This request is gone')
      const access = imPlatform(conn.platform)?.topics === true ? cleanAccess(body.access, rt) : undefined
      const [request] = conn.requests.splice(at, 1)
      if (body.allow === true) {
        conn.paired = [...(conn.paired ?? []), { id: request.id, name: request.name, at: Date.now(), ...(access === undefined ? {} : { access }) }]
        const accepted = await records.paired(conn.id, request)
        conn = accepted.conn
        if (imPlatform(conn.platform)?.topics === true) await ensurePrivateTopics(conn, request.chatKey)
        const chat = conn.chats[request.chatKey]
        const text = textForChat(conn, request.chatKey)
        const target = place.targetOf(conn, { key: request.chatKey, kind: request.chatKind })
        const name = target === undefined ? undefined : targetName(conn, target)
        await sendText(conn, { key: request.chatKey, kind: request.chatKind, title: chat.title },
          conn.account?.hasTopicsEnabled === true ? text('paired') : name === undefined ? text(request.chatKind === 'group' ? 'unboundGroup' : 'unbound') : text('connected', { target: name }))
      } else {
        await rt.save()
      }
      return true
    },
    async 'im-access'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      if (imPlatform(conn.platform)?.topics !== true) throw new Error('This platform has no Access lists')
      const person = conn.paired?.find(person => person.id === String(body.senderId ?? ''))
      if (person === undefined) throw new Error('No such paired person')
      person.access = cleanAccess(body.access, rt)
      await rt.save()
      for (const [chatKey, chat] of Object.entries(conn.chats ?? {})) {
        if (chat.personId === person.id) await ensurePrivateTopics(conn, chatKey)
          .catch(error => rt.warn('ds-bot: im topics failed: %s', rt.redactSecrets(String(error?.message ?? error))))
      }
      return true
    },
    async 'im-unpair'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      conn.paired = (conn.paired ?? []).filter(entry => entry.id !== String(body.senderId ?? ''))
      await rt.save()
      return true
    },
    async 'im-chat'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const chat = conn.chats?.[String(body.chatKey ?? '')]
      if (chat === undefined) throw new Error('No such chat')
      const chatKey = String(body.chatKey ?? '')
      if (body.remove === true) {
        await records.remove(conn.id, chatKey)
      } else if (body.target === null) {
        await records.setTarget(conn.id, chatKey, undefined)
      } else if (body.target !== undefined) {
        const target = body.target
        if (target.botId !== undefined && rt.botOf(target.botId) === undefined) throw new Error('Choose a Bot or a group')
        if (target.roomId !== undefined && rt.roomOf(target.roomId) === undefined) throw new Error('Choose a Bot or a group')
        await records.setTarget(conn.id, chatKey, target.botId !== undefined ? { botId: String(target.botId) } : { roomId: String(target.roomId) })
      }
      return true
    },
    async 'im-retry'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      await runners.retry(conn.id)
      return true
    },
    async 'im-login-start'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform?.login !== 'qr' || adapter === undefined) throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginStart(env)
      return { loginId: login.loginId, qr: login.qr, expiresAt: login.expiresAt, botId: bot.id }
    },
    async 'im-login-wait'(body) {
      const platform = imPlatform(String(body.platform ?? 'weixin'))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform?.login !== 'qr' || adapter === undefined) throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginWait(String(body.loginId ?? ''), env)
      if (login.status !== 'done') return { status: login.status }
      // Confirmed: create the connection with the platform credentials the
      // login returned, paired with the scanning owner — no review needed.
      const conn = {
        id: `im_${randomBytes(4).toString('hex')}`,
        platform: platform.id,
        account: login.connection.account,
        botId: bot.id,
        settings: login.connection.settings ?? {},
        secrets: {},
        enabled: true,
        paired: login.owner === undefined ? [] : [{ id: login.owner.id, name: login.owner.name, at: Date.now() }],
        requests: [],
        chats: {},
        createdAt: Date.now(),
      }
      for (const [key, value] of Object.entries(login.connection.secrets ?? {})) {
        const name = secretName(conn, key)
        await rt.secretEndpoint('secret-set', { name, value, purpose: `${platform.name} IM bot`, scope: [] })
        conn.secrets[key] = name
      }
      connections()[conn.id] = conn
      if (login.owner === undefined) await rt.save()
      else await records.paired(conn.id, { ...login.owner, chatKey: login.owner.id, chatKind: 'direct', chatTitle: login.owner.name })
      await sync()
      return { status: 'done', id: conn.id }
    },
  }

  const imEndpoint = async (endpoint, body) => {
    const result = await endpoints[endpoint]?.(body ?? {})
    if (result === undefined) throw new Error(`Unknown endpoint ${endpoint}`)
    if (endpoint !== 'im-retry') void sync()
    void syncCards()
    return result
  }

  // ------------------------------------------------------------------ im via
  // IM-originated user messages, keyed by session and event seq, so the client
  // can tag a message with the platform it came from. A Session's entries go
  // when it stops being the chat's current part.
  const imVia = new Map()
  const imViaView = () => {
    for (const sessionId of imVia.keys()) if (!rt.chatOwners.has(sessionId)) imVia.delete(sessionId)
    return Object.fromEntries([...imVia.entries()].map(([sessionId, seqs]) => [sessionId, { ...seqs }]))
  }

  // ----------------------------------------------------------------- outbound
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const key = JSON.stringify([agent.id, frame.attemptId])
    for (const { conn, runner } of runners.running()) {
      if (imPlatform(conn.platform)?.drafts !== true || runner.drafts === undefined) continue
      if (frame.type === 'start') {
        const botId = rt.chatOwners.get(agent.id)
        const roomId = rt.groupOwners.get(agent.id)?.roomId
        const match = roomId === undefined ? { botId } : { roomId }
        if ((botId === undefined && roomId === undefined) || (roomId === undefined && (state.exchangeTurns[agent.id] ?? []).includes(frame.turn))) continue
        runner.drafts.start(key, { sessionId: agent.id, owner: match, turn: frame.turn, step: frame.step })
        continue
      }
      if (frame.type === 'end') runner.drafts.end(key)
      else if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') runner.drafts.text(key, frame.chunk.text)
    }
  })
  ctx.on('session/event', (session, event) => {
    stopping.sessionEvent(session, event)
    place.sessionEvent(session, event)
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      for (const { runner } of runners.running()) runner.drafts?.endStep(session.id, event.data?.turn, event.data?.step)
    }
    if (event.type === 'user/message') {
      const rpcId = event.data?.source?.rpcId
      if (typeof rpcId === 'string' && rpcId.startsWith('im:') && Number.isInteger(event.seq)) {
        imVia.set(session.id, { ...imVia.get(session.id), [event.seq]: rpcId.split(':')[1] })
      }
    }
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) {
      // A group's own chat has no Bot of its own; its lines go out from onRoomLine.
      imVia.delete(session.id)
      return
    }
    for (const item of rt.displayItems(session.id, [event])) {
      if (item.kind !== 'bot' && item.kind !== 'view') continue
      const body = item.kind === 'bot' ? item.text : viewCardText({ title: item.title, view: item.view }) || (item.title ?? '')
      for (const { conn, runner } of runners.running()) {
        for (const destination of place.places(conn, { botId }, session.id, item.kind === 'view' ? 'card' : 'message')) {
          void runner.delivery.output(destination, { text: body, rich: item.kind === 'bot' })
        }
      }
    }
  })

  rt.onRoomLine((room, line) => {
    if (line.botId === undefined || line.kind !== undefined || typeof line.text !== 'string' || line.text.trim() === '') return
    const body = `**${line.who}**: ${line.text}`
    for (const { conn, runner } of runners.running()) {
      for (const destination of place.places(conn, { roomId: room.id }, rt.sessionOfRoom(room), 'message')) {
        void runner.delivery.output(destination, { text: body, rich: true })
      }
    }
  })

  rt.onApproval((kind, data) => { void kinds.approval(kind, data) })

  rt.onSaved(() => {
    void syncCards().then(cards.settleGone).catch(() => {})
    void sync().catch(() => {})
  })

  let interval
  ctx.effect(() => {
    interval = setInterval(() => {
      void rt.refresh().then(() => sync()).catch(() => {})
    }, RECONCILE_MS)
    interval.unref?.()
    void rt.load().then(() => sync()).catch(() => {})
    return () => {
      clearInterval(interval)
      place.clearOrigins()
      return runners.teardown().then(() => store.flush(() => cards.flushClaims()))
    }
  }, 'ds-bot: im')

  const imView = () => ({ connections: Object.values(connections()).map(viewOf), platforms: IM_PLATFORMS.filter(platform => adaptersFor().includes(platform.id)).map(platform => platform.id) })
  const imStatusView = runners.statusView
  const imQuestionClaimed = kinds.questionClaimed
  const imQuestionAnswered = kinds.questionAnswered

  Object.assign(rt, {
    imView, imStatusView, imViaView, imEndpoint, imQuestionClaimed, imQuestionAnswered,
    holdImOrigin: place.holdOrigin, peekImOrigin: place.peekOrigin, dropImOrigin: place.dropOrigin,
  })
}
