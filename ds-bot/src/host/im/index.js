// IM: talk to Bots from chat apps. A connection is one IM bot account bound to a Bot;
// direct chats reach that Bot, platform group chats can be bound to a DS Bot group.
// The platform adapters (im/platforms/) own the wire; placement.js decides where output
// goes; cards.js keeps the Card journal; this module owns pairing, Card answers and the
// send queues. Only the dsh holding the team lock connects.
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../files.js'
import { viewCardText } from '../parts.js'
import { imPlatform, IM_PLATFORMS } from '../../shared/im-platforms.js'
import { adapters } from './platforms/index.js'
import { addressKey, cleanAccess, migrateTopics, privateTopicCreator, topicRestorer } from './topics.js'
import { placement } from './placement.js'
import { draftStream } from './drafts.js'
import { cardJournal } from './cards.js'
import { localeOf, translate } from './locale.js'
import { forumBinder } from './forum-bind.js'
import { statusData, statusPanels } from './status-panel.js'

const RECONCILE_MS = 15_000
const RUNTIME_SAVE_MS = 400
const RETRY_MS = 5_000
const TYPING_MS = 4_000
const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/

const secretField = key => key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()

export function install(rt) {
  const { ctx, state } = rt
  const statusSteps = new Map()
  const imDir = join(rt.home, 'im')
  // Telegram notices follow one Paired person: their /lang choice, else their
  // Telegram language. Other platforms, and unknown people, use DS Bot's language.
  const translator = (conn, who) => (key, values) => {
    if (conn.platform !== 'telegram') return translate(localeOf({ uiLanguage: rt.uiLanguage?.() }), key, values)
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
  // The single writer of who last spoke in a saved chat and in which language.
  const heard = async (conn, chat, sender) => {
    if (conn.platform !== 'telegram' || chat === undefined || (chat.languageCode === sender.languageCode && chat.lastSenderId === sender.id)) return
    chat.languageCode = sender.languageCode
    chat.lastSenderId = sender.id
    await rt.save()
  }

  // ---------------------------------------------------------------- runtime file
  const runtimes = new Map() // id → { data: {runtime, cards, open}, timer }
  const runtimeOf = async (id) => {
    let held = runtimes.get(id)
    if (held !== undefined) return held
    let data
    try {
      data = JSON.parse(await readFile(join(imDir, `${id}.json`), 'utf8'))
    } catch { data = undefined }
    held = {
      data: {
        runtime: data?.runtime !== null && typeof data?.runtime === 'object' ? data.runtime : {},
        cards: data?.cards !== null && typeof data?.cards === 'object' ? data.cards : {},
        requests: data?.requests ?? {},
        turns: data?.turns ?? {},
        panels: Array.isArray(data?.panels) ? data.panels : [],
      },
      timer: undefined,
    }
    runtimes.set(id, held)
    return held
  }
  const scheduleWrite = (id) => {
    const held = runtimes.get(id)
    if (held === undefined || held.timer !== undefined) return
    held.timer = setTimeout(() => {
      held.timer = undefined
      void writeRuntime(id).catch(error => rt.warn('ds-bot: im runtime %s not saved: %s', id, error))
    }, RUNTIME_SAVE_MS)
    held.timer.unref?.()
  }
  const writeRuntime = async (id) => {
    const held = runtimes.get(id)
    if (held === undefined || rt.readOnly() !== undefined) return
    await mkdir(imDir, { recursive: true })
    const temp = join(imDir, `${id}.${process.pid}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(held.data), { encoding: 'utf8', mode: 0o600 })
      await chmod(temp, 0o600)
      await replaceFile(temp, join(imDir, `${id}.json`))
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
  const runtimeEnv = async (id) => {
    const held = await runtimeOf(id)
    return {
      get: () => held.data.runtime,
      set: (patch) => {
        Object.assign(held.data.runtime, patch)
        scheduleWrite(id)
      },
    }
  }
  const cardsOf = async (id) => (await runtimeOf(id)).data

  // ------------------------------------------------------------- connections
  let topicsMigrated = false
  const connections = () => {
    const conns = (state.im ??= { connections: {} }).connections
    for (const conn of Object.values(conns)) if (imPlatform(conn.platform)?.topics === true) topicsMigrated = migrateTopics(conn) || topicsMigrated
    return conns
  }
  const adaptersFor = () => Object.keys(adapters)
  const hasSecrets = conn => Object.values(conn.secrets ?? {}).every(name => rt.secretValue(name) !== undefined)
  const fieldsOf = (conn) => {
    const fields = { ...conn.settings }
    for (const [key, name] of Object.entries(conn.secrets ?? {})) fields[key] = rt.secretValue(name)
    return fields
  }
  const envFor = async (conn, runtime) => ({
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    config: rt.config.im?.[conn.platform],
    runtime: runtime ?? await runtimeEnv(conn.id),
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
    store: {
      * loaded() { for (const [id, held] of runtimes) yield [id, held.data] },
      of: cardsOf,
      save: scheduleWrite,
      saveNow: writeRuntime,
    },
    botOf: id => rt.botOf(id),
    roomOf: id => rt.roomOf(id),
  })
  const cards = cardJournal({
    store: { of: cardsOf, peek: id => runtimes.get(id)?.data, save: scheduleWrite },
    connections,
    textForChat,
    textForPerson,
    handleOf: id => runners.get(id)?.handle,
    enqueue: (conn, chatKey, job) => enqueue(conn, chatKey, job),
    paired: (conn, personId) => paired(conn, personId),
    sourceOpen: conn => sourceOpen(conn),
    warn: (template, ...args) => rt.warn(template, ...args),
    readOnly: () => rt.readOnly() !== undefined,
  })

  // ------------------------------------------------------------------ send out
  /** @type {Map<string, {handle:any, queues:Map<string, {jobs:any[], retry?:any}>, statuses:Map}>} */
  const runners = new Map()
  const statuses = new Map()
  const ensurePrivateTopics = privateTopicCreator(rt, id => runners.get(id)?.handle, textForChat)
  const restoreTopic = topicRestorer(rt, id => runners.get(id)?.handle, (conn, address, target) => place.deliverable(conn, address, { target }))
  const recoverTopic = async (conn, chat) => {
    const oldThreadId = chat.threadId
    const threadId = await restoreTopic(conn, chat)
    if (threadId === undefined) return false
    chat.threadId = threadId
    runners.get(conn.id)?.drafts?.moved(chat.key, oldThreadId, threadId)
    await cards.moved(conn.id, chat.key, oldThreadId, threadId)
    const data = await cardsOf(conn.id)
    for (const panel of data.panels) {
      if (panel.chat.key === chat.key && panel.chat.threadId === oldThreadId) {
        panel.chat.threadId = threadId
        delete panel.messageId
      }
    }
    scheduleWrite(conn.id)
    return true
  }
  const setStatus = (id, next) => {
    // Adapter errors can echo platform responses that quote the token; keep them out of the UI and logs.
    if (typeof next.error === 'string' && next.error !== '') return statuses.set(id, { ...next, error: rt.redactSecrets(next.error), at: Date.now() })
    return statuses.set(id, { ...next, at: Date.now() })
  }
  const failClass = (error) => {
    if (error?.permanent === true || (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 429)) return 'permanent'
    if (error?.unknown === true || error?.stopped === true) return 'drop'
    return 'retry'
  }

  const enqueue = (conn, chatKey, job) => {
    const runner = runners.get(conn.id)
    if (runner === undefined) return
    let queue = runner.queues.get(chatKey)
    if (queue === undefined) runner.queues.set(chatKey, queue = { jobs: [] })
    queue.jobs.push(job)
    if (queue.jobs.length === 1) void drain(conn, chatKey)
  }
  const drain = async (conn, chatKey) => {
    const runner = runners.get(conn.id)
    const queue = runner?.queues.get(chatKey)
    // A reserved slot has no handle until connect() lands; start() re-kicks
    // anything queued in the meantime.
    if (runner?.handle === undefined || queue === undefined) return
    while (queue.jobs.length > 0) {
      const job = queue.jobs[0]
      if (job.receiverUserId !== undefined && Date.now() >= job.privateUntil) {
        queue.jobs.shift()
        continue
      }
      try {
        const draft = runner.drafts?.sending(chatKey)
        if (draft !== undefined) await draft
        // In place: a Card's `after` keeps this address object and records the moved Topic.
        place.follow(conn, job.chat)
        if (!place.deliverable(conn, job.chat, job)) {
          queue.jobs.shift()
          continue
        }
        const sent = job.receiverUserId !== undefined
          ? await runner.handle.sendPrivateCard(job.chat, job.receiverUserId, job.card)
          : job.card !== undefined && typeof runner.handle.sendCard === 'function'
            ? await runner.handle.sendCard(job.chat, job.card)
            : await runner.handle.send(job.chat, job)
        await job.after?.(sent)
        queue.jobs.shift()
      } catch (caught) {
        let error = caught
        if (imPlatform(conn.platform)?.topics === true && error?.topicMissing === true && !job.topicRecovered) {
          try {
            if (await recoverTopic(fresh(conn.id) ?? conn, job.chat)) {
              job.topicRecovered = true
              continue
            }
          } catch (recoveryError) { error = recoveryError }
        }
        const how = failClass(error)
        if (how === 'retry') {
          const wait = Number(error?.retryAfter) > 0 ? error.retryAfter * 1000 : RETRY_MS
          queue.retry = setTimeout(() => { void drain(conn, chatKey) }, wait)
          queue.retry.unref?.()
          return
        }
        queue.jobs.shift()
        if (how === 'permanent') setStatus(conn.id, { state: 'error', error: String(error?.message ?? error).slice(0, 300) })
      }
    }
  }
  const sendText = (conn, chat, body, buttons, after) => enqueue(conn, addressKey(chat), { chat, text: body, buttons, after })
  // `output` is the turn output a Placement place carries; queued output is rechecked against it.
  const sendTo = (conn, chatKey, chat, body, buttons, after, rich = false, output = undefined) => enqueue(conn, addressKey(chat), { chat, target: place.targetOf(conn, chat), output, text: body, buttons, after, ...(rich && imPlatform(conn.platform)?.richMessages === true ? { rich: true } : {}) })

  // ----------------------------------------------------------------- inbound
  const paired = (conn, senderId) => (conn.paired ?? []).some(entry => entry.id === senderId)
  const requested = (conn, msg) => {
    if ((conn.requests ?? []).some(entry => entry.id === msg.sender.id)) return false
    conn.requests = [...(conn.requests ?? []), { id: msg.sender.id, name: msg.sender.name, chatKey: msg.chat.key, chatKind: msg.chat.kind, ...(conn.platform === 'telegram' ? { languageCode: msg.sender.languageCode } : {}), at: Date.now() }]
    return true
  }

  const targetName = (conn, target) => {
    if (target?.botId !== undefined) return rt.botOf(target.botId)?.name
    if (target?.roomId !== undefined) return rt.roomOf(target.roomId)?.name
    return undefined
  }

  // Shared Stop path for /stop, Drafts and the Status panel.
  const stopTarget = async (conn, chat, target, text, action) => {
    runners.get(conn.id)?.drafts?.endTarget(target)
    const stopped = target.botId !== undefined ? await rt.stopChat(target.botId) : await rt.stopRoomWork(target.roomId)
    await sendCardReply(conn, chat, text(stopped ? 'stopped' : 'idle'), action)
    return stopped
  }
  const onStop = (conn) => async ({ chat, draftId }) => {
    const runner = runners.get(conn.id)
    if (imPlatform(conn.platform)?.drafts !== true || chat.kind !== 'direct' || !Number.isSafeInteger(draftId) || draftId === 0) return
    const copy = runner?.drafts?.find(chat, draftId)
    if (copy === undefined) return
    const current = conn.chats?.[chat.key]
    const target = current === undefined ? undefined : place.targetOf(conn, chat)
    if (!place.may(conn, current?.personId, target)) return
    if (target === undefined || target.botId !== copy.target.botId || target.roomId !== copy.target.roomId) return
    await stopTarget(conn, copy.chat, target, textForChat(conn, chat.key))
  }
  const onWidgetQuery = conn => async action => {
    if (imPlatform(conn.platform)?.statusPanel !== true || action.chat.kind !== 'direct'
      || action.type !== 'data' || action.data !== 'stop' || !paired(conn, action.sender.id)) return
    const record = runners.get(conn.id)?.panels?.find(action.chat.key, action.messageId)
    if (record === undefined || !place.may(conn, action.sender.id, record.target)) return
    // A widget press may not carry the sender's language; the chat's last one stands in.
    const sender = { id: action.sender.id, languageCode: action.sender.languageCode ?? conn.chats?.[action.chat.key]?.languageCode }
    await stopTarget(conn, record.chat, record.target, textForPerson(conn, sender))
  }

  const questionById = (id) => {
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      if (question.id === id) return { sessionId, question }
    }
    return undefined
  }
  const answerQuestionCard = async (conn, chat, cardKey, labels, sender, action) => {
    const text = textForPerson(conn, sender)
    const held = cards.open(conn, chat, cardKey)
    if (held === undefined) return false
    const found = questionById(held.cardKey.slice(2))
    if (found === undefined) {
      await sendCardReply(conn, chat, text('stale'), action)
      return true
    }
    const valid = labels.filter(label => (found.question.options ?? []).some(option => option.label === label))
    if (valid.length === 0) return false
    try {
      await rt.answerQuestion(found.sessionId, found.question.id, { selected: valid })
      await cards.settle(conn, held.cardKey, valid.join(', '))
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await cards.claim(conn, held.cardKey, text('answered'))
        await sendCardReply(conn, chat, text('stale'), action)
        await cards.edits(conn)
        return true
      }
      throw error
    }
    return true
  }
  const answerApprovalCard = async (conn, chat, cardKey, choice, sender, action) => {
    const text = textForPerson(conn, sender)
    const held = cards.open(conn, chat, cardKey, action)
    if (held === undefined) return false
    if (held.entry.receiverUserId !== undefined && (
      sender?.id !== held.entry.receiverUserId
      || (action !== undefined && (action.ephemeralMessageId !== held.entry.ephemeralMessageId || action.receiverUserId !== held.entry.receiverUserId))
    )) {
      await sendCardReply(conn, chat, text('privateOnly'), action)
      return true
    }
    try {
      rt.answerApproval(held.cardKey.slice(2), choice)
      await cards.settle(conn, held.cardKey, text => choice === 'allow' ? text('allow') : text('reject'))
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await sendCardReply(conn, chat, text('stale'), action)
        return true
      }
      throw error
    }
    return true
  }
  const sendCardReply = async (conn, chat, body, action) => {
    if (conn.platform === 'telegram' && typeof action?.answer === 'function') return action.answer(body)
    return sendText(conn, chat, body)
  }

  const forumBind = forumBinder(rt, { handleOf: id => runners.get(id)?.handle, enqueue, sendText, sendCardReply, textForPerson, may: place.may })

  const onMessage = (conn) => async (msg) => {
    const text = textForPerson(conn, msg.sender)
    if (!paired(conn, msg.sender.id)) {
      if (msg.chat.kind === 'group' && !msg.mentioned) return
      if (!requested(conn, msg)) return
      await rt.save()
      await sendText(conn, msg.chat, text('requested'))
      return
    }
    conn.chats ??= {}
    if (msg.chat.kind === 'group' && !msg.mentioned && !(imPlatform(conn.platform)?.topics === true && msg.chat.isForum === true)) return
    if (conn.chats[msg.chat.key] === undefined) {
      conn.chats[msg.chat.key] = { kind: msg.chat.kind, title: msg.chat.title, at: Date.now() }
      await rt.save()
    }
    const body = String(msg.text ?? '').trim()
    const chat = conn.chats[msg.chat.key]
    if (imPlatform(conn.platform)?.topics === true && msg.chat.isForum === true && chat.isForum !== true) {
      chat.isForum = true
      await rt.save()
    }
    if (imPlatform(conn.platform)?.topics === true && /^\/bind(?:@\S+)?\s*$/.test(body)) {
      await forumBind.command(conn, msg)
      return
    }
    const unboundKey = chat.isForum === true ? 'bindHint' : msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'
    if (imPlatform(conn.platform)?.topics === true && chat.kind === 'direct' && chat.personId !== msg.sender.id) {
      chat.personId = msg.sender.id
      await rt.save()
    }
    await heard(conn, chat, msg.sender)
    if (conn.platform === 'telegram' && /^\/lang(?:@\S+)?(?:\s|$)/.test(body)) {
      const person = conn.paired.find(person => person.id === msg.sender.id)
      const language = body.split(/\s+/).slice(1).join(' ')
      if (['ru', 'en', 'auto'].includes(language)) {
        person.language = language
        await rt.save()
      }
      await sendText(conn, msg.chat, text('language', { language: person.language ?? 'auto' }))
      return
    }
    const target = place.targetOf(conn, msg.chat)
    if (!NUMBERS.test(body) && target !== undefined && !place.may(conn, msg.sender.id, target)) {
      await sendText(conn, msg.chat, text('denied'))
      return
    }
    if (/^\/start(?:@\S+)?\s*$/.test(body)) {
      const name = target === undefined ? undefined : targetName(conn, target)
      await sendText(conn, msg.chat, name === undefined ? text(unboundKey) : text('greeting', { name }))
      return
    }
    if (/^\/stop(?:@\S+)?\s*$/.test(body)) {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(unboundKey))
        return
      }
      await stopTarget(conn, msg.chat, target, text)
      return
    }
    if (imPlatform(conn.platform)?.topics === true && /^\/status(?:@\S+)?\s*$/.test(body)) {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(unboundKey))
      } else {
        const panels = runners.get(conn.id)?.panels
        if (panels !== undefined && msg.chat.kind === 'direct') {
          await panels.show(msg.chat, target, text)
        } else if (imPlatform(conn.platform)?.statusPanel === true) {
          const data = statusData(rt, target, text, statusSteps)
          const body = `${data.name} — ${data.state}\n${text('statusTool')}: ${data.tool || '—'}\n${text('statusStep')}: ${data.step}\n${text('statusElapsed')}: ${data.since === null ? 0 : Math.max(0, Math.floor((Date.now() - data.since) / 1000))} s`
          if (msg.chat.kind === 'group' && data.active && imPlatform(conn.platform)?.richCards === true
            && typeof runners.get(conn.id)?.handle?.sendCard === 'function') {
            const key = `t:${randomUUID()}`
            await cards.send(conn, key, [{ chat: msg.chat, target }], body, undefined,
              () => ({ text: body, options: [{ data: `${key}:stop`, label: text('stop') }] }))
          } else {
            sendTo(conn, msg.chat.key, msg.chat, body, undefined, undefined, true)
          }
        } else {
          sendTo(conn, msg.chat.key, msg.chat, `${targetName(conn, target)} — ${text(busyOf(target) ? 'working' : 'idle')}`, undefined, undefined, true)
        }
      }
      return
    }
    if (NUMBERS.test(body)) {
      const picked = body.trim().split(/\s+/).map(Number)
      // The newest open question or approval: a bare number answers whatever arrived last.
      const held = cards.newest(conn, msg.chat, cardKey => cardKey.startsWith('q:') || cardKey.startsWith('a:'))
      const denied = held !== undefined && !place.may(conn, msg.sender.id, held.entry.target)
      // Anything that does not clearly answer the newest open card — a stale
      // source, an out-of-range pick, several picks on a single choice — is a
      // normal message for the Bot, never swallowed and never 'stale'.
      if (held !== undefined && held.cardKey.startsWith('q:')) {
        const found = questionById(held.cardKey.slice(2))
        if (found !== undefined) {
          const options = found.question.options ?? []
          const inRange = picked.length > 0 && (found.question.multiSelect === true || picked.length === 1)
            && picked.every(index => options[index - 1] !== undefined)
          if (inRange && denied) {
            await sendCardReply(conn, msg.chat, text(held.entry.target === undefined ? 'stale' : 'denied'))
            return
          }
          if (inRange && await answerQuestionCard(conn, msg.chat, held.cardKey, picked.map(index => options[index - 1].label), msg.sender)) return
        }
      } else if (held !== undefined && held.cardKey.startsWith('a:')
        && picked.length === 1 && (picked[0] === 1 || picked[0] === 2)
        && rt.approvalsView().some(entry => `a:${entry.id}` === held.cardKey)) {
        if (denied) {
          await sendCardReply(conn, msg.chat, text(held.entry.target === undefined ? 'stale' : 'denied'))
          return
        }
        if (await answerApprovalCard(conn, msg.chat, held.cardKey, picked[0] === 1 ? 'allow' : 'reject', msg.sender)) return
      }
    }
    if (target !== undefined && !place.may(conn, msg.sender.id, target)) {
      await sendText(conn, msg.chat, text('denied'))
      return
    }
    if (target === undefined) {
      await sendText(conn, msg.chat, text(unboundKey))
      return
    }
    const sessionId = target.botId ?? target.roomId
    const content = []
    if (body !== '') content.push({ type: 'text', text: body })
    for (const image of msg.images ?? []) content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
    const env = await envFor(conn)
    for (const file of msg.files ?? []) {
      try {
        const receiptId = await env.uploadFile(rt.botOf(sessionId) ? rt.chatOf(sessionId) : sessionId, file)
        content.push({ type: 'file', receiptId })
      } catch {
        await sendText(conn, msg.chat, text('noFile'))
      }
    }
    if (content.length === 0) return
    const requestId = `im:${conn.platform}:${randomUUID()}`
    await place.asked(conn, requestId, msg.sender, msg.chat)
    try {
      await rt.sendUser({ sessionId, content, requestId })
    } catch (error) {
      await place.unasked(conn, requestId)
      throw error
    }
  }

  const onAction = (conn) => async (action) => {
    if (!paired(conn, action.sender.id)) {
      if (imPlatform(conn.platform)?.statusPanel === true && String(action.data ?? '').startsWith('t:')) {
        await sendCardReply(conn, action.chat, textForPerson(conn, action.sender)('denied'), action)
      }
      return
    }
    const text = textForPerson(conn, action.sender)
    await heard(conn, conn.chats?.[action.chat.key], action.sender)
    const data = String(action.data ?? '')
    const { chat } = action
    if (imPlatform(conn.platform)?.topics === true && data.startsWith('b:')) {
      await forumBind.action(conn, action)
      return
    }
    // Button data is `<kind>:<id>:<choice>`; the id is everything between the
    // first and the last colon, so an id with a colon in it still parses.
    const cut = data.lastIndexOf(':')
    const cardKey = data.slice(0, cut)
    const choice = data.slice(cut + 1)
    if (imPlatform(conn.platform)?.statusPanel === true && data.startsWith('t:')) {
      const entry = cards.byMessage(conn, chat, cardKey, action.messageId)
      if (chat.kind !== 'group' || choice !== 'stop' || entry === undefined) {
        await sendCardReply(conn, chat, text('idle'), action)
        return
      }
      if (!place.may(conn, action.sender.id, entry.target) || !place.deliverable(conn, chat, { target: entry.target })) {
        await sendCardReply(conn, chat, text('denied'), action)
        return
      }
      if (entry.answer !== undefined || !statusData(rt, entry.target, text, statusSteps).active) {
        await cards.settle(conn, cardKey, text => text('idle'), [])
        await sendCardReply(conn, chat, text('idle'), action)
        return
      }
      // Claim this snapshot before cancellation yields, so a second press cannot stop twice.
      await cards.claim(conn, cardKey, text => text('stopped'), [])
      await stopTarget(conn, chat, entry.target, text, action)
      await cards.edits(conn)
      return
    }
    if (imPlatform(conn.platform)?.topics === true) {
      const key = data.startsWith('m:') ? `q:${cardKey.slice(2)}` : cardKey
      const target = cards.open(conn, chat, key, action)?.entry.target
      if (!place.may(conn, action.sender.id, target)) {
        await sendCardReply(conn, chat, text(target === undefined ? 'stale' : 'denied'), action)
        return
      }
    }
    if (data.startsWith('m:') && cut > 2 && imPlatform(conn.platform)?.richCards === true) {
      const key = `q:${cardKey.slice(2)}`
      const held = cards.open(conn, chat, key)
      const found = questionById(cardKey.slice(2))
      const handle = runners.get(conn.id)?.handle
      if (found?.question.multiSelect !== true || held?.entry.card === undefined || typeof handle?.editCard !== 'function') {
        await sendCardReply(conn, chat, text('stale'), action)
        return
      }
      const { entry } = held
      if (choice === 'done') {
        const selected = entry.card.options.filter(option => option.checked === true).map(option => option.label)
        if (selected.length === 0) {
          await sendCardReply(conn, chat, text('selectOne'), action)
          return
        }
        if (!(await answerQuestionCard(conn, chat, key, selected, action.sender, action))) await sendCardReply(conn, chat, text('stale'), action)
        return
      }
      const option = /^\d+$/.test(choice) ? entry.card.options[Number(choice)] : undefined
      if (option?.checked === undefined || option.data !== data) return
      option.checked = !option.checked
      await cards.redraw(conn, chat, entry)
      return
    }
    if (data.startsWith('q:') && cut > 2) {
      const found = questionById(cardKey.slice(2))
      const label = found?.question.options?.[Number(choice)]?.label
      if (label === undefined) {
        await sendCardReply(conn, chat, text('stale'), action)
        return
      }
      if (!(await answerQuestionCard(conn, chat, cardKey, [label], action.sender, action))) await sendCardReply(conn, chat, text('stale'), action)
      return
    }
    if (data.startsWith('a:') && cut > 2) {
      if (choice === 'allow' || choice === 'reject') {
        if (!(await answerApprovalCard(conn, chat, cardKey, choice, action.sender, action))) await sendCardReply(conn, chat, text('stale'), action)
      }
    }
  }

  // ------------------------------------------------------------------ cards
  const cardText = {
    question: (bot, question, text) => {
      const options = (question.options ?? []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')
      const hint = question.multiSelect === true ? text('numbersMulti') : text('numbers')
      return `${text('question', { bot })}${question.question}${question.detail ? `\n${question.detail}` : ''}\n${options}\n(${hint})`
    },
    approval: (bot, entry, text) => `${text('approval', { bot })}${entry.tool}${entry.reason ? ` — ${entry.reason}` : ''}${entry.detail?.text ? `\n${entry.detail.text}` : ''}${entry.detail?.code ? `\n${entry.detail.code}` : ''}`,
  }
  const cardButtons = {
    question: (question) => (question.multiSelect === true ? undefined : (question.options ?? []).map((option, index) => ({ data: `q:${question.id}:${index}`, label: option.label }))),
    multiSelect: (question, text) => [
      ...(question.options ?? []).map((option, index) => ({ data: `m:${question.id}:${index}`, label: option.label, checked: false })),
      { data: `m:${question.id}:done`, label: text('done'), submit: true },
    ],
    approval: (id, text) => [{ data: `a:${id}:allow`, label: text('allow') }, { data: `a:${id}:reject`, label: text('reject') }],
  }

  const diffCards = async () => {
    if (rt.readOnly() !== undefined) return
    for (const conn of Object.values(connections())) {
      const runner = runners.get(conn.id)
      if (runner === undefined) continue
      await cards.load(conn.id)
      // Questions: one card per open question id, sent to the Bot's chats.
      for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
        const cardKey = `q:${question.id}`
        if (cards.sent(conn.id, cardKey)) continue
        const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined
        await cards.send(conn, cardKey, place.places(conn, { botId }, sessionId, 'card'), text => cardText.question(bot.name, question, text), buttons,
          text => ({ text: cardText.question(bot.name, question, text), options: question.multiSelect === true ? cardButtons.multiSelect(question, text) : cardButtons.question(question) }))
      }
      // Secret requests: text only — the key is typed on the computer or phone.
      for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        for (const request of list) {
          const cardKey = `s:${request.id}`
          if (request.status !== 'pending' || cards.sent(conn.id, cardKey)) continue
          await cards.send(conn, cardKey, place.places(conn, { botId }, request.sessionId, 'card'), text => text('secretAsk', { bot: bot.name, name: request.name }))
        }
      }
      // Views awaiting a reply: text form only.
      for (const [sessionId, view] of Object.entries(state.views ?? {})) {
        const cardKey = `v:${view.id}`
        if (cards.sent(conn.id, cardKey)) continue
        const botId = rt.chatOwners.get(sessionId)
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const form = viewCardText({ title: view.title, view: view.view })
        await cards.send(conn, cardKey, place.places(conn, { botId }, sessionId, 'card'), text => `${text('viewShow', { bot: bot.name })}${form !== '' ? `\n${form}` : view.title ? `\n${view.title}` : ''}`)
      }
    }
  }

  // Whether the thing a Card asks about still waits for an answer.
  const sourceOpen = (conn) => {
    const openIds = new Set(Object.values(state.questions ?? {}).map(question => `q:${question.id}`))
    const openSecret = new Set(Object.values(state.secretRequests ?? {}).flat().filter(entry => entry.status === 'pending').map(entry => `s:${entry.id}`))
    const openViews = new Set(Object.values(state.views ?? {}).map(view => `v:${view.id}`))
    return (cardKey, entries) => cardKey.startsWith('q:') ? openIds.has(cardKey)
      : cardKey.startsWith('a:') ? rt.approvalsView().some(entry => `a:${entry.id}` === cardKey)
        : cardKey.startsWith('s:') ? openSecret.has(cardKey)
          : cardKey.startsWith('v:') ? openViews.has(cardKey)
            : cardKey.startsWith('t:') && imPlatform(conn.platform)?.statusPanel === true
              ? entries.some(entry => place.deliverable(conn, { key: entry.chatKey, kind: conn.chats?.[entry.chatKey]?.kind, threadId: entry.threadId }, { target: entry.target })
                && statusData(rt, entry.target, textForChat(conn, entry.chatKey), statusSteps).active)
              : false
  }

  // ---------------------------------------------------------------- lifecycle
  // `state.im.connections` is replaced wholesale when a save is adopted, so anything
  // bound at connect time looks the connection up again by id instead of keeping it.
  const fresh = id => connections()[id]
  const onStatus = (id) => (next) => {
    setStatus(id, { state: next.state, error: next.error, at: Date.now() })
    const conn = fresh(id)
    if (conn !== undefined && next.account !== undefined && (conn.account?.id !== next.account.id || conn.account?.name !== next.account.name || conn.account?.hasTopicsEnabled !== next.account.hasTopicsEnabled)) {
      conn.account = next.account
      void rt.save().catch(() => {})
      if (imPlatform(conn.platform)?.topics === true) {
        void Promise.all(Object.keys(conn.chats ?? {}).map(chatKey => ensurePrivateTopics(conn, chatKey)))
          .catch(error => rt.warn('ds-bot: im topics failed: %s', rt.redactSecrets(String(error?.message ?? error))))
      }
    }
  }

  const busyOf = (target) => {
    if (target?.botId !== undefined) return rt.live.get(rt.chatOf(target.botId))?.turn !== undefined
    if (target?.roomId !== undefined) return (rt.roomWorkView?.()[target.roomId] ?? []).length > 0
    return false
  }

  const start = async (conn) => {
    const adapter = adapters[conn.platform]
    if (adapter === undefined || runners.has(conn.id)) return
    const platform = imPlatform(conn.platform)
    if (platform?.ws === true && globalThis.WebSocket === undefined) {
      setStatus(conn.id, { state: 'error', error: 'This dsh runs on a Node without WebSocket', at: Date.now() })
      return
    }
    // The slot is reserved before the async work: a concurrent sync cannot
    // start a second adapter for the same connection.
    const runner = { handle: undefined, queues: new Map(), typing: undefined, drafts: undefined }
    runners.set(conn.id, runner)
    setStatus(conn.id, { state: 'connecting', at: Date.now() })
    try {
      const env = await envFor(conn)
      const handle = adapter.connect(fieldsOf(conn), env, {
        onMessage: (msg) => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onMessage(current)(msg).catch(error => rt.warn('ds-bot: im message failed: %s', error))
        },
        onAction: (action) => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onAction(current)(action).catch(error => rt.warn('ds-bot: im action failed: %s', error))
        },
        onStop: (event) => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onStop(current)(event).catch(error => rt.warn('ds-bot: im stop failed: %s', error))
        },
        onWidgetQuery: action => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onWidgetQuery(current)(action).catch(error => rt.warn('ds-bot: widget query failed: %s', error))
        },
        onStatus: onStatus(conn.id),
      })
      // A stop() during connect took the slot back: undo the just-started
      // adapter instead of leaving it running unreachable.
      if (runners.get(conn.id) !== runner) {
        void Promise.resolve(handle?.stop?.()).catch(() => {})
        return
      }
      runner.handle = handle
      if (typeof handle.draft === 'function') {
        runner.drafts = draftStream({
          connOf: () => fresh(conn.id) ?? conn,
          place,
          send: (chat, draft) => handle.draft(chat, draft),
          recover: async chat => imPlatform(conn.platform)?.topics === true && await recoverTopic(fresh(conn.id) ?? conn, chat),
          warn: message => rt.warn('ds-bot: im draft failed: %s', rt.redactSecrets(message)),
        })
      }
      if (platform?.statusPanel === true && typeof handle.sendStatusPanel === 'function' && typeof handle.editStatusPanel === 'function') {
        runner.panels = statusPanels(handle, {
          records: (await runtimeOf(conn.id)).data.panels,
          snapshot: record => statusData(rt, record.target, textForChat(fresh(conn.id) ?? conn, record.chat.key), statusSteps),
          valid: record => {
            const current = fresh(conn.id)
            return current !== undefined && place.deliverable(current, record.chat, { target: record.target })
              && (record.target.botId !== undefined ? rt.botOf(record.target.botId) : rt.roomOf(record.target.roomId)) !== undefined
          },
          save: () => scheduleWrite(conn.id),
          recover: chat => recoverTopic(fresh(conn.id) ?? conn, chat),
          textOf: record => textForChat(fresh(conn.id) ?? conn, record.chat.key),
          warn: error => rt.warn('ds-bot: Status panel update failed: %s', rt.redactSecrets(String(error?.message ?? error))),
        })
      }
      for (const chatKey of runner.queues.keys()) void drain(conn, chatKey)
      if (platform?.topics === true) {
        for (const chatKey of Object.keys(conn.chats ?? {})) await ensurePrivateTopics(conn, chatKey)
      }
      if (typeof runner.handle?.typing === 'function') {
        runner.typing = setInterval(() => {
          const current = fresh(conn.id) ?? conn
          const owners = [...Object.keys(state.bots).map(botId => ({ botId })), ...Object.keys(state.rooms).map(roomId => ({ roomId }))]
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
      if (platform?.privateCards === true && typeof handle.deletePrivateCard === 'function') {
        runner.privateTimer = setInterval(() => {
          const current = fresh(conn.id)
          if (current !== undefined) void cards.expirePrivate(current).catch(error => rt.warn('ds-bot: Private card fallback failed: %s', error))
        }, 1000)
        runner.privateTimer.unref?.()
      }
      await diffCards()
    } catch (error) {
      if (runners.get(conn.id) === runner) await stop(conn.id)
      setStatus(conn.id, { state: 'error', error: String(error?.message ?? error).slice(0, 300), at: Date.now() })
    }
  }
  const stop = async (id) => {
    const runner = runners.get(id)
    runners.delete(id)
    if (runner?.typing !== undefined) clearInterval(runner.typing)
    clearInterval(runner?.privateTimer)
    runner?.panels?.stop()
    for (const queue of runner?.queues.values() ?? []) clearTimeout(queue.retry)
    runner?.drafts?.dispose()
    await Promise.resolve(runner?.handle?.stop?.()).catch(() => {})
    if (statuses.get(id)?.state !== 'error') setStatus(id, { state: 'off', at: Date.now() })
  }

  // Syncs run one behind the other: endpoints, onSaved and the interval can all
  // fire while a sync is still starting an adapter, and they must see its
  // reserved slots rather than start a second adapter.
  let syncing = Promise.resolve()
  const sync = () => {
    const run = syncing.then(async () => {
      const conns = connections()
      if (topicsMigrated && rt.readOnly() === undefined) {
        topicsMigrated = false
        await rt.save()
      }
      for (const conn of Object.values(conns)) {
        const wants = stopped !== true && adapters[conn.platform] !== undefined && conn.enabled !== false
          && rt.readOnly() === undefined && hasSecrets(conn)
        if (wants && !runners.has(conn.id)) await start(conn)
        else if (!wants && runners.has(conn.id)) await stop(conn.id)
        if (wants && imPlatform(conn.platform)?.topics === true) {
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

  let stopped = false

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
      const { account } = await adapters[platform.id].check(fields, env)
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
        const { account } = await adapters[conn.platform].check(check, env)
        conn.account = account
        await saveSecrets(conn, platform, fields)
        for (const field of platform.fields) {
          if (!field.secret && fields[field.key] !== undefined) conn.settings[field.key] = fields[field.key]
        }
      }
      await rt.save()
      if (runners.has(conn.id)) await stop(conn.id)
      await sync()
      return viewOf(conn)
    },
    async 'im-remove'(body) {
      const id = String(body.id ?? '')
      const conn = connections()[id]
      if (conn === undefined) throw new Error('No such IM bot')
      await stop(id)
      for (const name of Object.values(conn.secrets ?? {})) {
        await rt.secretEndpoint('secret-delete', { name }).catch(() => {})
      }
      delete connections()[id]
      runtimes.delete(id)
      await rm(join(imDir, `${id}.json`), { force: true }).catch(() => {})
      await rt.save()
      return true
    },
    async 'im-pair'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const at = (conn.requests ?? []).findIndex(entry => entry.id === String(body.senderId ?? ''))
      if (at === -1) throw new Error('This request is gone')
      const access = imPlatform(conn.platform)?.topics === true ? cleanAccess(body.access, rt) : undefined
      const [request] = conn.requests.splice(at, 1)
      if (body.allow === true) {
        conn.paired = [...(conn.paired ?? []), { id: request.id, name: request.name, at: Date.now(), ...(access === undefined ? {} : { access }) }]
        conn.chats ??= {}
        conn.chats[request.chatKey] ??= { kind: request.chatKind, title: request.name, at: Date.now() }
        if (conn.platform === 'telegram') {
          conn.chats[request.chatKey].languageCode = request.languageCode
          if (request.chatKind === 'direct') conn.chats[request.chatKey].personId = request.id
        }
        await rt.save()
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
      if (body.remove === true) {
        delete conn.chats[String(body.chatKey ?? '')]
      } else if (body.target === null) {
        delete chat.target
      } else if (body.target !== undefined) {
        const target = body.target
        if (target.botId !== undefined && rt.botOf(target.botId) === undefined) throw new Error('Choose a Bot or a group')
        if (target.roomId !== undefined && rt.roomOf(target.roomId) === undefined) throw new Error('Choose a Bot or a group')
        chat.target = target.botId !== undefined ? { botId: String(target.botId) } : { roomId: String(target.roomId) }
      }
      await rt.save()
      return true
    },
    async 'im-retry'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      if (runners.has(conn.id)) await stop(conn.id)
      await sync()
      return true
    },
    async 'im-login-start'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform === undefined || typeof adapter?.loginStart !== 'function') throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginStart(env)
      return { loginId: login.loginId, qr: login.qr, expiresAt: login.expiresAt, botId: bot.id }
    },
    async 'im-login-wait'(body) {
      const platform = imPlatform(String(body.platform ?? 'weixin'))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform === undefined || typeof adapter?.loginWait !== 'function') throw new Error('This platform has no QR login')
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
        chats: login.owner === undefined ? {} : { [login.owner.id]: { kind: 'direct', title: login.owner.name, at: Date.now() } },
        createdAt: Date.now(),
      }
      for (const [key, value] of Object.entries(login.connection.secrets ?? {})) {
        const name = secretName(conn, key)
        await rt.secretEndpoint('secret-set', { name, value, purpose: `${platform.name} IM bot`, scope: [] })
        conn.secrets[key] = name
      }
      connections()[conn.id] = conn
      await rt.save()
      await sync()
      return { status: 'done', id: conn.id }
    },
  }

  const imEndpoint = async (endpoint, body) => {
    const result = await endpoints[endpoint]?.(body ?? {})
    if (result === undefined) throw new Error(`Unknown endpoint ${endpoint}`)
    void sync()
    void diffCards()
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
    for (const conn of Object.values(connections())) {
      const runner = runners.get(conn.id)
      if (imPlatform(conn.platform)?.drafts !== true || runner?.drafts === undefined) continue
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
    if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) statusSteps.set(session.id, event.data.step)
    if (event.type === 'turn/start' || event.type === 'turn/end') statusSteps.delete(session.id)
    place.sessionEvent(session, event)
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      for (const runner of runners.values()) runner.drafts?.endStep(session.id, event.data?.turn, event.data?.step)
    }
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) {
      imVia.delete(session.id)
      return
    }
    const rpcId = event.type === 'user/message' ? event.data?.source?.rpcId : undefined
    if (typeof rpcId === 'string' && rpcId.startsWith('im:') && Number.isInteger(event.seq)) {
      imVia.set(session.id, { ...imVia.get(session.id), [event.seq]: rpcId.split(':')[1] })
    }
    for (const item of rt.displayItems(session.id, [event])) {
      if (item.kind !== 'bot' && item.kind !== 'view') continue
      const body = item.kind === 'bot' ? item.text : viewCardText({ title: item.title, view: item.view }) || (item.title ?? '')
      for (const conn of Object.values(connections())) {
        if (!runners.has(conn.id)) continue
        for (const { chatKey, chat, output } of place.places(conn, { botId }, session.id, item.kind === 'view' ? 'card' : 'message')) sendTo(conn, chatKey, chat, body, undefined, undefined, item.kind === 'bot', output)
      }
    }
  })

  rt.onRoomLine((room, line) => {
    if (line.botId === undefined || line.kind !== undefined || typeof line.text !== 'string' || line.text.trim() === '') return
    const body = `**${line.who}**: ${line.text}`
    for (const conn of Object.values(connections())) {
      if (!runners.has(conn.id)) continue
      for (const { chatKey, chat, output } of place.places(conn, { roomId: room.id }, undefined, 'message')) sendTo(conn, chatKey, chat, body, undefined, undefined, true, output)
    }
  })

  rt.onApproval((kind, data) => {
    if (kind === 'open') {
      void (async () => {
        for (const conn of Object.values(connections())) {
          const runner = runners.get(conn.id)
          if (runner === undefined) continue
          const bot = rt.botOf(data.botId)
          const targets = place.places(conn, data.roomId === undefined ? { botId: data.botId } : { roomId: data.roomId }, data.sessionId, 'card')
          const buttons = imPlatform(conn.platform)?.buttons === true ? text => cardButtons.approval(data.id, text) : undefined
          const initiator = await place.initiatorOf(conn, data.sessionId)
          await cards.send(conn, `a:${data.id}`, targets, text => cardText.approval(bot?.name ?? '?', data, text), buttons,
            text => ({
              text: cardText.approval(bot?.name ?? '?', { ...data, detail: undefined }, text),
              details: data.detail,
              options: cardButtons.approval(data.id, text).map((option, index) => ({ ...option, style: index === 0 ? 'success' : 'danger' })),
            }), initiator)
        }
      })().catch(error => rt.warn('ds-bot: im approval card failed: %s', error))
      return
    }
    void (async () => {
      for (const conn of Object.values(connections())) {
        await cards.settle(conn, `a:${data.id}`, text => data.outcome === 'allowed-once' ? text('allow') : data.outcome === 'rejected' ? text('reject') : text('answered'))
      }
    })().catch(() => {})
  })

  rt.onSaved(() => {
    void diffCards().then(cards.settleGone).catch(() => {})
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
      stopped = true
      clearInterval(interval)
      return Promise.all([...runners.keys()].map(stop)).then(async () => {
        for (const held of runtimes.values()) if (held.timer !== undefined) clearTimeout(held.timer)
        await Promise.all([...runtimes.keys()].map(writeRuntime)).catch(() => {})
      })
    }
  }, 'ds-bot: im')

  const imView = () => ({ connections: Object.values(connections()).map(viewOf), platforms: IM_PLATFORMS.filter(platform => adaptersFor().includes(platform.id)).map(platform => platform.id) })
  const imStatusView = () => Object.fromEntries([...statuses.entries()].map(([id, status]) => [id, { state: status.state, ...(status.error !== undefined ? { error: status.error } : {}), at: status.at }]))
  const imQuestionAnswered = async (question, answer) => {
    const selected = (answer?.selected ?? []).filter(label => question.options?.some(option => option.label === label))
    const labels = question.multiSelect === true ? [...new Set(selected)] : selected.slice(0, 1)
    for (const conn of Object.values(connections())) {
      if (imPlatform(conn.platform)?.richCards !== true) continue
      await cards.settle(conn, `q:${question.id}`, labels.length ? labels.join(', ') : text => text('answered'), labels)
    }
  }

  Object.assign(rt, { imView, imStatusView, imViaView, imEndpoint, imQuestionAnswered })
}
