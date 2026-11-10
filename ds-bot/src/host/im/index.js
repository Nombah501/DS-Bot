// IM: talk to Bots from chat apps. A connection is one IM bot account bound to a Bot;
// direct chats reach that Bot, platform group chats can be bound to a DS Bot group.
// The platform adapters (im/platforms/) own the wire; this module owns pairing,
// routing, cards and the send queues. Only the dsh holding the team lock connects.
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../files.js'
import { viewCardText } from '../parts.js'
import { imPlatform, IM_PLATFORMS } from '../../shared/im-platforms.js'
import { adapters } from './platforms/index.js'
import { addressKey, allows, canDeliver, cleanAccess, migrateTopics, privateTopicCreator, topicTarget } from './topics.js'

const RECONCILE_MS = 15_000
const RUNTIME_SAVE_MS = 400
const RETRY_MS = 5_000
const TYPING_MS = 4_000
// Local conservative policy; Telegram's numeric Draft rate limit is unverified.
const DRAFT_MS = 1000
const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/

const secretField = key => key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()

export function install(rt) {
  const { ctx, state } = rt
  const imDir = join(rt.home, 'im')
  const zh = () => String(rt.uiLanguage?.() ?? '').startsWith('Chinese')
  const text = (key, values = {}, languageCode) => {
    if (String(languageCode ?? '').toLowerCase().startsWith('ru')) {
      return {
        requested: 'Запрос на подключение отправлен в DS Bot; разрешите его на компьютере в Настройки → IM.',
        unbound: 'Этот IM-бот ещё не привязан к Bot; выберите его в DS Bot: Настройки → IM.',
        unboundGroup: 'Эта группа ещё не привязана; выберите для неё группу или Bot в DS Bot: Настройки → IM.',
        connected: `Подключено — теперь можно общаться с ${values.target}.`,
        stopped: 'Остановлено.',
        idle: 'Сейчас ничего не выполняется.',
        working: 'Работает',
        paired: 'Подключено — выберите Topic нужного Bot или группы.',
        denied: 'Этот Bot или группа не входят в ваш список доступа.',
        stale: 'На эту карточку уже ответили.',
        privateOnly: 'Только инициатор может ответить на эту карточку.',
        noFile: 'Этот файл нельзя отправить здесь; отправьте его на компьютере.',
        greeting: `Здравствуйте, я ${values.name}.`,
        question: `${values.bot} спрашивает: `,
        approval: `${values.bot} запрашивает разрешение: `,
        secretAsk: `${values.bot} нужен ключ ${values.name} — введите его на компьютере или в приложении на телефоне.`,
        viewShow: `${values.bot} отправил карточку — ответьте на компьютере или в приложении на телефоне.`,
        answered: 'отвечено',
        numbers: 'ответьте номером',
        numbersMulti: 'ответьте номерами через пробел',
        allow: 'Разрешить один раз',
        reject: 'Отклонить',
        done: 'Готово',
        selectOne: 'Выберите хотя бы один вариант.',
      }[key] ?? key
    }
    const line = {
      requested: zh() ? '已向 DS Bot 发出连接请求，请在电脑上的 DS Bot 设置 → IM 里允许。' : 'A connection request was sent to DS Bot; allow it in Settings → IM on the computer.',
      unbound: zh() ? '这个 IM 机器人还没绑定 Bot，请在 DS Bot 设置 → IM 里选一个。' : 'This IM bot is not bound to a Bot yet; pick one in DS Bot Settings → IM.',
      unboundGroup: zh() ? '这个群还没绑定，请在 DS Bot 设置 → IM 里给它选一个群或 Bot。' : 'This group is not bound yet; pick a group or a Bot for it in DS Bot Settings → IM.',
      connected: zh() ? `已连接，现在可以和 ${values.target} 说话了。` : `Connected — you can talk to ${values.target} now.`,
      stopped: zh() ? '已停下。' : 'Stopped.',
      idle: zh() ? '现在没有在做的活。' : 'Nothing is running.',
      working: zh() ? '进行中' : 'Working',
      paired: 'Connected — choose a Topic for the Bot or group.',
      denied: 'This Bot or group is not on your Access list.',
      stale: zh() ? '这张卡已经答过了。' : 'This card was already answered.',
      privateOnly: zh() ? '只有发起人可以回答这张卡。' : 'Only the Initiator can answer this card.',
      noFile: zh() ? '这个文件发不过去，请在电脑上发。' : 'This file cannot be sent here; send it on the computer.',
      greeting: zh() ? `你好，我是 ${values.name}。` : `Hello, I am ${values.name}.`,
      question: zh() ? `${values.bot} 问你：` : `${values.bot} asks: `,
      approval: zh() ? `${values.bot} 请你审批：` : `${values.bot} asks for approval: `,
      secretAsk: zh() ? `${values.bot} 要密钥 ${values.name}，请在电脑或手机 App 上填。` : `${values.bot} needs the key ${values.name} — fill it on the computer or the phone app.`,
      viewShow: zh() ? `${values.bot} 发了一个卡片，请在电脑或手机 App 上回复。` : `${values.bot} shared a card — answer it on the computer or the phone app.`,
      answered: zh() ? '已答' : 'answered',
      numbers: zh() ? '回复编号' : 'reply with the number',
      numbersMulti: zh() ? '回复编号，多选用空格隔开' : 'reply with the numbers, separated by spaces',
      allow: zh() ? '允许一次' : 'Allow once',
      reject: zh() ? '拒绝' : 'Reject',
      done: zh() ? '完成' : 'Done',
      selectOne: zh() ? '请至少选择一个选项。' : 'Select at least one option.',
    }[key]
    return line ?? key
  }
  const textFor = (conn, chat) => (key, values) => text(key, values, conn.platform === 'telegram' ? chat?.languageCode : undefined)

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
  // Sent cards: cardKey → [{ chatKey, messageId, answer? }]. Persisted so a restart
  // does not send a card twice; an `answer` marks it settled from this side.
  const cardsOf = async (id) => (await runtimeOf(id)).data
  const markCard = async (id, cardKey, chat, messageId, body, card, cardFormat, copy = {}) => {
    const data = await cardsOf(id)
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
    scheduleWrite(id)
  }
  const settleCard = async (id, cardKey, answer, selected) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    for (const entry of entries) {
      if (entry.answer !== undefined) continue
      entry.answer = typeof answer === 'function' ? answer(textFor(connections()[id], entry.receiverUserId === undefined ? connections()[id]?.chats?.[entry.chatKey] : entry)) : answer
      if (entry.card !== undefined) {
        const labels = selected ?? [entry.answer]
        entry.card.settled = {
          answer: entry.answer,
          options: entry.card.options.filter(option => option.submit !== true && labels.includes(option.label)).map(({ label, style }) => ({ label, ...(style ? { style } : {}) })),
        }
      }
    }
    scheduleWrite(id)
  }

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

  // ------------------------------------------------------------------ send out
  /** @type {Map<string, {handle:any, queues:Map<string, {jobs:any[], retry?:any}>, statuses:Map}>} */
  const runners = new Map()
  const statuses = new Map()
  const ensurePrivateTopics = privateTopicCreator(rt, id => runners.get(id)?.handle)
  const setStatus = (id, next) => {
    // Adapter errors can echo platform responses that quote the token; keep them out of the UI and logs.
    if (typeof next.error === 'string' && next.error !== '') return statuses.set(id, { ...next, error: rt.redactSecrets(next.error), at: Date.now() })
    return statuses.set(id, { ...next, at: Date.now() })
  }
  const targetsOf = (conn) => {
    const out = []
    for (const [chatKey, saved] of Object.entries(conn.chats ?? {})) {
      const chat = { ...saved, key: chatKey }
      const topicMode = imPlatform(conn.platform)?.topics === true
      const person = conn.paired?.find(person => person.id === chat.personId)
      if (topicMode && chat.kind === 'direct' && conn.account?.hasTopicsEnabled === true) {
        for (const [threadId, topic] of Object.entries(chat.topics ?? {})) {
          if (allows(person, topic.target)) out.push({ chatKey, chat: { ...chat, threadId: Number(threadId) }, target: topic.target })
        }
        continue
      }
      const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
      if (!topicMode || chat.kind !== 'direct' || chat.personId === undefined || allows(person, target)) out.push({ chatKey, chat, target })
      if (topicMode && chat.kind === 'group') {
        for (const [threadId, topic] of Object.entries(chat.topics ?? {})) out.push({ chatKey, chat: { ...chat, threadId: Number(threadId) }, target: topic.target })
      }
    }
    return out
  }
  // Chats of this connection that listen to a Bot's own chat or a group.
  const listeners = (conn, match) => targetsOf(conn).filter(({ target }) => {
    if (match.botId !== undefined) return target?.botId === match.botId && rt.botOf(target.botId) !== undefined
    if (match.roomId !== undefined) return target?.roomId === match.roomId && rt.roomOf(target.roomId) !== undefined
    return false
  })

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
        const draft = runner.draftChats.get(chatKey)?.sending
        if (draft !== undefined) await draft
        if (imPlatform(conn.platform)?.topics === true && !canDeliver(fresh(conn.id) ?? conn, job.chat, job.target)) {
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
      } catch (error) {
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
  const sendTo = (conn, chatKey, chat, body, buttons, after, rich = false) => enqueue(conn, addressKey(chat), { chat, target: resolveTarget(conn, chat), text: body, buttons, after, ...(rich && imPlatform(conn.platform)?.richMessages === true ? { rich: true } : {}) })

  // Drafts never enter the durable retry queue: only its latest pending text matters.
  const flushDraft = (conn, chatKey) => {
    const runner = runners.get(conn.id)
    const held = runner?.draftChats.get(chatKey)
    if (held === undefined || held.pending === undefined || held.sending !== undefined || held.timer !== undefined) return
    const wait = held.lastAt + DRAFT_MS - Date.now()
    if (wait > 0) {
      held.timer = setTimeout(() => {
        held.timer = undefined
        flushDraft(conn, chatKey)
      }, wait)
      held.timer.unref?.()
      return
    }
    const copy = held.pending
    held.pending = undefined
    if (copy.ended || !canDeliver(fresh(conn.id) ?? conn, copy.chat, copy.target)) return
    held.lastAt = Date.now()
    held.sending = Promise.resolve(runner.handle.draft(copy.chat, { draftId: copy.draftId, text: copy.attempt.text }))
      .catch(error => {
        if (runners.get(conn.id) !== runner) return
        rt.warn('ds-bot: im draft failed: %s', rt.redactSecrets(String(error?.message ?? error)))
        if (Number(error?.retryAfter) > 0) held.lastAt = Date.now() + error.retryAfter * 1000
      })
      .finally(() => {
        held.sending = undefined
        if (runners.get(conn.id) === runner) flushDraft(conn, chatKey)
      })
  }
  const finishDraft = (runner, key) => {
    const attempt = runner.drafts.get(key)
    if (attempt === undefined) return
    for (const copy of attempt.copies) {
      copy.ended = true
      const held = runner.draftChats.get(addressKey(copy.chat))
      if (held?.pending !== copy) continue
      held.pending = undefined
      clearTimeout(held.timer)
      held.timer = undefined
    }
    runner.drafts.delete(key)
  }
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
  const resolveTarget = (conn, chat) => {
    const target = imPlatform(conn.platform)?.topics === true && chat.key !== undefined
      ? topicTarget(conn, chat)
      : chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    if (target?.botId !== undefined && rt.botOf(target.botId) !== undefined) return target
    if (target?.roomId !== undefined && rt.roomOf(target.roomId) !== undefined) return target
    return undefined
  }

  // Shared Stop path for /stop, Drafts and the Status panel.
  const stopTarget = async (conn, chat, target) => {
    const runner = runners.get(conn.id)
    for (const [key, attempt] of runner?.drafts ?? []) {
      if (attempt.copies.some(copy => target.botId !== undefined ? copy.target.botId === target.botId : copy.target.roomId === target.roomId)) finishDraft(runner, key)
    }
    const stopped = target.botId !== undefined ? await rt.stopChat(target.botId) : await rt.stopRoomWork(target.roomId)
    sendText(conn, chat, textFor(conn, chat)(stopped ? 'stopped' : 'idle'))
    return stopped
  }
  const onStop = (conn) => async ({ chat, draftId }) => {
    const runner = runners.get(conn.id)
    if (imPlatform(conn.platform)?.drafts !== true || chat.kind !== 'direct' || !Number.isSafeInteger(draftId) || draftId === 0) return
    for (const attempt of runner?.drafts.values() ?? []) {
      const copy = attempt.copies.find(copy => copy.draftId === draftId && copy.chat.key === chat.key && copy.chat.threadId === chat.threadId && !copy.ended)
      if (copy === undefined) continue
      const current = conn.chats?.[chat.key]
      const target = current === undefined ? undefined : resolveTarget(conn, { ...current, ...chat })
      if (imPlatform(conn.platform)?.topics === true && !allows(conn.paired?.find(person => person.id === current?.personId), target)) return
      if (target === undefined || target.botId !== copy.target.botId || target.roomId !== copy.target.roomId) return
      await stopTarget(conn, { ...copy.chat, languageCode: current.languageCode }, target)
      return
    }
  }

  // One card this chat was sent and has not answered yet. A button names its own
  // card, so it must never fall through to a newer card of the same kind.
  const openCard = (conn, chat, cardKey, action) => {
    const entries = runtimes.get(conn.id)?.data?.cards[cardKey]
    const entry = entries?.findLast(item => item.chatKey === chat.key && item.threadId === chat.threadId && item.answer === undefined && !item.deleted
      && (action?.ephemeralMessageId === undefined || (item.ephemeralMessageId === action.ephemeralMessageId && item.receiverUserId === action.receiverUserId)))
    return entry === undefined ? undefined : { cardKey, entry }
  }
  const questionById = (id) => {
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      if (question.id === id) return { sessionId, question }
    }
    return undefined
  }
  const answerQuestionCard = async (conn, chat, cardKey, labels) => {
    const text = textFor(conn, chat)
    const held = openCard(conn, chat, cardKey)
    if (held === undefined) return false
    const found = questionById(held.cardKey.slice(2))
    if (found === undefined) {
      await sendCardReply(conn, chat, text('stale'))
      return true
    }
    const valid = labels.filter(label => (found.question.options ?? []).some(option => option.label === label))
    if (valid.length === 0) return false
    try {
      await rt.answerQuestion(found.sessionId, found.question.id, { selected: valid })
      await settleCard(conn.id, held.cardKey, valid.join(', '))
      await settledEdits(conn)
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await settleCard(conn.id, held.cardKey, text('answered'))
        await sendCardReply(conn, chat, text('stale'))
        await settledEdits(conn)
        return true
      }
      throw error
    }
    return true
  }
  const answerApprovalCard = async (conn, chat, cardKey, choice, sender, action) => {
    const text = textFor(conn, chat)
    const held = openCard(conn, chat, cardKey, action)
    if (held === undefined) return false
    if (held.entry.receiverUserId !== undefined && (
      sender?.id !== held.entry.receiverUserId
      || (action !== undefined && (action.ephemeralMessageId !== held.entry.ephemeralMessageId || action.receiverUserId !== held.entry.receiverUserId))
    )) {
      await sendCardReply(conn, chat, text('privateOnly'))
      return true
    }
    try {
      rt.answerApproval(held.cardKey.slice(2), choice)
      await settleCard(conn.id, held.cardKey, text => choice === 'allow' ? text('allow') : text('reject'))
      await settledEdits(conn)
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await sendCardReply(conn, chat, text('stale'))
        return true
      }
      throw error
    }
    return true
  }
  const sendCardReply = async (conn, chat, body) => sendText(conn, chat, body)

  // The chat's newest still-open card, questions and approvals together: a bare
  // number answers whatever arrived last, not always a question.
  const newestOpenCard = (conn, chat) => {
    const data = runtimes.get(conn.id)?.data
    if (data === undefined) return undefined
    for (const [cardKey, entries] of Object.entries(data.cards).reverse()) {
      if (!cardKey.startsWith('q:') && !cardKey.startsWith('a:')) continue
      const entry = entries.findLast(item => item.chatKey === chat.key && item.threadId === chat.threadId && item.answer === undefined && !item.deleted)
      if (entry !== undefined) return { cardKey, entry }
    }
    return undefined
  }

  const onMessage = (conn) => async (msg) => {
    const text = textFor(conn, msg.sender)
    if (conn.platform === 'telegram') msg.chat.languageCode = msg.sender.languageCode
    if (!paired(conn, msg.sender.id)) {
      if (msg.chat.kind === 'group' && !msg.mentioned) return
      if (!requested(conn, msg)) return
      await rt.save()
      await sendText(conn, msg.chat, text('requested'))
      return
    }
    conn.chats ??= {}
    if (msg.chat.kind === 'group' && !msg.mentioned) return
    if (conn.chats[msg.chat.key] === undefined) {
      conn.chats[msg.chat.key] = { kind: msg.chat.kind, title: msg.chat.title, at: Date.now() }
      await rt.save()
    }
    const body = String(msg.text ?? '').trim()
    const chat = conn.chats[msg.chat.key]
    if (imPlatform(conn.platform)?.topics === true && chat.kind === 'direct' && chat.personId !== msg.sender.id) {
      chat.personId = msg.sender.id
      await rt.save()
    }
    if (conn.platform === 'telegram' && chat.languageCode !== msg.sender.languageCode) {
      chat.languageCode = msg.sender.languageCode
      await rt.save()
    }
    const target = resolveTarget(conn, { ...chat, ...msg.chat })
    if (imPlatform(conn.platform)?.topics === true && target !== undefined && !allows(conn.paired?.find(person => person.id === msg.sender.id), target)) {
      await sendText(conn, msg.chat, text('denied'))
      return
    }
    if (/^\/start(?:@\S+)?\s*$/.test(body)) {
      const name = target === undefined ? undefined : targetName(conn, target)
      await sendText(conn, msg.chat, name === undefined ? text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound') : text('greeting', { name }))
      return
    }
    if (/^\/stop(?:@\S+)?\s*$/.test(body)) {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
        return
      }
      await stopTarget(conn, { ...msg.chat, languageCode: msg.sender.languageCode }, target)
      return
    }
    if (imPlatform(conn.platform)?.topics === true && /^\/status(?:@\S+)?\s*$/.test(body)) {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
      } else {
        sendTo(conn, msg.chat.key, msg.chat, `${targetName(conn, target)} — ${text(busyOf(target) ? 'working' : 'idle')}`, undefined, undefined, true)
      }
      return
    }
    if (NUMBERS.test(body)) {
      const picked = body.trim().split(/\s+/).map(Number)
      const held = newestOpenCard(conn, msg.chat)
      // Anything that does not clearly answer the newest open card — a stale
      // source, an out-of-range pick, several picks on a single choice — is a
      // normal message for the Bot, never swallowed and never 'stale'.
      if (held !== undefined && held.cardKey.startsWith('q:')) {
        const found = questionById(held.cardKey.slice(2))
        if (found !== undefined) {
          const options = found.question.options ?? []
          const inRange = picked.length > 0 && (found.question.multiSelect === true || picked.length === 1)
            && picked.every(index => options[index - 1] !== undefined)
          if (inRange && await answerQuestionCard(conn, msg.chat, held.cardKey, picked.map(index => options[index - 1].label))) return
        }
      } else if (held !== undefined && held.cardKey.startsWith('a:')
        && picked.length === 1 && (picked[0] === 1 || picked[0] === 2)
        && rt.approvalsView().some(entry => `a:${entry.id}` === held.cardKey)) {
        if (await answerApprovalCard(conn, msg.chat, held.cardKey, picked[0] === 1 ? 'allow' : 'reject', msg.sender)) return
      }
    }
    if (target === undefined) {
      await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
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
    const data = await cardsOf(conn.id)
    if (imPlatform(conn.platform)?.privateCards === true) {
      data.requests[requestId] = { sender: msg.sender, chatKey: msg.chat.key }
      await writeRuntime(conn.id)
    }
    try {
      await rt.sendUser({ sessionId, content, requestId })
    } catch (error) {
      delete data.requests[requestId]
      scheduleWrite(conn.id)
      throw error
    }
  }

  const onAction = (conn) => async (action) => {
    if (!paired(conn, action.sender.id)) return
    const text = textFor(conn, action.sender)
    if (conn.platform === 'telegram' && conn.chats?.[action.chat.key] !== undefined) {
      conn.chats[action.chat.key].languageCode = action.sender.languageCode
      await rt.save()
    }
    const data = String(action.data ?? '')
    const chat = { ...action.chat, languageCode: action.sender.languageCode }
    if (imPlatform(conn.platform)?.topics === true) {
      const target = resolveTarget(conn, chat)
      if (target === undefined || !allows(conn.paired?.find(person => person.id === action.sender.id), target)) {
        await sendCardReply(conn, chat, text(target === undefined ? 'stale' : 'denied'))
        return
      }
    }
    // Button data is `<kind>:<id>:<choice>`; the id is everything between the
    // first and the last colon, so an id with a colon in it still parses.
    const cut = data.lastIndexOf(':')
    const cardKey = data.slice(0, cut)
    const choice = data.slice(cut + 1)
    if (data.startsWith('m:') && cut > 2 && imPlatform(conn.platform)?.richCards === true) {
      const key = `q:${cardKey.slice(2)}`
      const held = openCard(conn, chat, key)
      const found = questionById(cardKey.slice(2))
      const handle = runners.get(conn.id)?.handle
      if (found?.question.multiSelect !== true || held?.entry.card === undefined || typeof handle?.editCard !== 'function') {
        await sendCardReply(conn, chat, text('stale'))
        return
      }
      const { entry } = held
      if (choice === 'done') {
        const selected = entry.card.options.filter(option => option.checked === true).map(option => option.label)
        if (selected.length === 0) {
          await sendCardReply(conn, chat, text('selectOne'))
          return
        }
        if (!(await answerQuestionCard(conn, chat, key, selected))) await sendCardReply(conn, chat, text('stale'))
        return
      }
      const option = /^\d+$/.test(choice) ? entry.card.options[Number(choice)] : undefined
      if (option?.checked === undefined || option.data !== data) return
      option.checked = !option.checked
      scheduleWrite(conn.id)
      if (entry.messageId !== undefined) await handle.editCard(chat, entry.messageId, entry.card, entry.cardFormat)
      return
    }
    if (data.startsWith('q:') && cut > 2) {
      const found = questionById(cardKey.slice(2))
      const label = found?.question.options?.[Number(choice)]?.label
      if (label === undefined) {
        await sendCardReply(conn, chat, text('stale'))
        return
      }
      if (!(await answerQuestionCard(conn, chat, cardKey, [label]))) await sendCardReply(conn, chat, text('stale'))
      return
    }
    if (data.startsWith('a:') && cut > 2) {
      if (choice === 'allow' || choice === 'reject') {
        if (!(await answerApprovalCard(conn, chat, cardKey, choice, action.sender, action))) await sendCardReply(conn, chat, text('stale'))
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

  const sendCard = async (conn, cardKey, targets, body, buttons, structured, initiator) => {
    for (const { chat, target } of targets) {
      const privateCard = chat.kind === 'group' && initiator !== undefined && paired(conn, initiator.sender.id)
        && imPlatform(conn.platform)?.privateCards === true && typeof runners.get(conn.id)?.handle?.sendPrivateCard === 'function'
      const copy = privateCard ? { receiverUserId: initiator.sender.id, languageCode: initiator.sender.languageCode, privateUntil: Date.now() + 5 * 60 * 1000, ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }) } : {}
      const text = textFor(conn, privateCard ? initiator.sender : chat)
      const rendered = typeof body === 'function' ? body(text) : body
      const renderedButtons = typeof buttons === 'function' ? buttons(text) : buttons
      const card = imPlatform(conn.platform)?.richCards === true && typeof runners.get(conn.id)?.handle?.sendCard === 'function' ? structured?.(text) : undefined
      await markCard(conn.id, cardKey, chat, undefined, rendered, card, undefined, copy)
      enqueue(conn, addressKey(chat), { chat, target, text: rendered, buttons: renderedButtons, card, ...copy, after: async (sent) => {
        await markCard(conn.id, cardKey, chat, sent?.messageId, rendered, card, sent?.cardFormat, { ...copy, ...(sent?.ephemeralMessageId === undefined ? {} : { ephemeralMessageId: sent.ephemeralMessageId, ephemeralMessageIds: sent.ephemeralMessageIds }) })
        await settledEdits(conn)
      } })
    }
  }

  const expirePrivateCards = async (conn) => {
    const runner = runners.get(conn.id)
    const data = runtimes.get(conn.id)?.data
    if (runner === undefined || data === undefined || rt.readOnly() !== undefined) return
    runner.privateQueued ??= new WeakSet()
    for (const entries of Object.values(data.cards)) {
      for (const entry of entries) {
        if (entry.receiverUserId === undefined || entry.deleted) continue
        const chat = conn.chats?.[entry.chatKey]
        if (chat === undefined) continue
        const address = { key: entry.chatKey, kind: chat.kind, title: chat.title, ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }) }
        let publicCopy = entries.find(copy => copy.chatKey === entry.chatKey && copy.threadId === entry.threadId && copy.receiverUserId === undefined)
        if (entry.answer === undefined && Date.now() >= entry.privateUntil && publicCopy === undefined) {
          publicCopy = { chatKey: entry.chatKey, text: entry.text, card: structuredClone(entry.card), threadId: entry.threadId }
          entries.push(publicCopy)
          scheduleWrite(conn.id)
        }
        if (publicCopy !== undefined && publicCopy.messageId === undefined && !runner.privateQueued.has(publicCopy)) {
          runner.privateQueued.add(publicCopy)
          const copy = publicCopy
          enqueue(conn, addressKey(address), { chat: address, card: copy.card, after: async sent => {
            copy.messageId = sent?.messageId
            copy.cardFormat = sent?.cardFormat
            runner.privateQueued.delete(copy)
            scheduleWrite(conn.id)
            await settledEdits(conn)
          } })
          scheduleWrite(conn.id)
        }
        if (publicCopy?.messageId !== undefined && entry.ephemeralMessageId !== undefined) {
          await runner.handle.deletePrivateCard(address, entry)
          entry.deleted = true
          entry.edited = true
          scheduleWrite(conn.id)
        }
      }
    }
  }

  const diffCards = async () => {
    if (rt.readOnly() !== undefined) return
    for (const conn of Object.values(connections())) {
      const runner = runners.get(conn.id)
      if (runner === undefined) continue
      const data = await cardsOf(conn.id)
      // Questions: one card per open question id, sent to the Bot's chats.
      for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
        const cardKey = `q:${question.id}`
        if (data.cards[cardKey] !== undefined) continue
        const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined
        await sendCard(conn, cardKey, listeners(conn, { botId }), text => cardText.question(bot.name, question, text), buttons,
          text => ({ text: cardText.question(bot.name, question, text), options: question.multiSelect === true ? cardButtons.multiSelect(question, text) : cardButtons.question(question) }))
      }
      // Secret requests: text only — the key is typed on the computer or phone.
      for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        for (const request of list) {
          const cardKey = `s:${request.id}`
          if (request.status !== 'pending' || data.cards[cardKey] !== undefined) continue
          await sendCard(conn, cardKey, listeners(conn, { botId }), text => text('secretAsk', { bot: bot.name, name: request.name }))
        }
      }
      // Views awaiting a reply: text form only.
      for (const [sessionId, view] of Object.entries(state.views ?? {})) {
        const cardKey = `v:${view.id}`
        if (data.cards[cardKey] !== undefined) continue
        const botId = rt.chatOwners.get(sessionId)
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const form = viewCardText({ title: view.title, view: view.view })
        await sendCard(conn, cardKey, listeners(conn, { botId }), text => `${text('viewShow', { bot: bot.name })}${form !== '' ? `\n${form}` : view.title ? `\n${view.title}` : ''}`)
      }
    }
  }

  // Buttons drop and the answer shows wherever the card was settled.
  const settledEdits = async (conn) => {
    const runner = runners.get(conn.id)
    const data = runtimes.get(conn.id)?.data
    if (runner?.handle.edit === undefined || data === undefined) return
    for (const entries of Object.values(data.cards)) {
      for (const entry of entries) {
        if (entry.deleted || entry.answer === undefined || (entry.messageId === undefined && entry.ephemeralMessageId === undefined) || entry.edited === true) continue
        const chat = conn.chats?.[entry.chatKey]
        if (chat === undefined) continue
        const text = textFor(conn, chat)
        entry.edited = true
        const body = entry.text !== undefined ? `${entry.text}\n— ${entry.answer}` : `(${text('answered')})`
        const address = { key: entry.chatKey, kind: chat.kind, title: chat.title, ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }) }
        const editing = entry.receiverUserId !== undefined && typeof runner.handle.editPrivateCard === 'function'
          ? runner.handle.editPrivateCard(address, entry, entry.card)
          : entry.card !== undefined && imPlatform(conn.platform)?.richCards === true && typeof runner.handle.editCard === 'function'
            ? runner.handle.editCard(address, entry.messageId, entry.card, entry.cardFormat)
            : runner.handle.edit(address, entry.messageId, { text: body })
        await editing.catch(error => {
          entry.edited = false
          if (!error?.stopped) rt.warn('ds-bot: im settled card edit failed: %s', error)
        })
        scheduleWrite(conn.id)
      }
    }
  }
  // A card answered on the computer leaves the state; its IM copy settles too.
  const settleGone = async () => {
    for (const conn of Object.values(connections())) {
      const data = runtimes.get(conn.id)?.data
      if (data === undefined) continue
      let touched = false
      const openIds = new Set(Object.values(state.questions ?? {}).map(question => `q:${question.id}`))
      const openSecret = new Set(Object.values(state.secretRequests ?? {}).flat().filter(entry => entry.status === 'pending').map(entry => `s:${entry.id}`))
      const openViews = new Set(Object.values(state.views ?? {}).map(view => `v:${view.id}`))
      const openCard = cardKey => cardKey.startsWith('q:') ? openIds.has(cardKey)
        : cardKey.startsWith('a:') ? rt.approvalsView().some(entry => `a:${entry.id}` === cardKey)
          : cardKey.startsWith('s:') ? openSecret.has(cardKey)
            : cardKey.startsWith('v:') ? openViews.has(cardKey) : false
      for (const [cardKey, entries] of Object.entries(data.cards)) {
        if (openCard(cardKey)) continue
        for (const entry of entries) {
          if (entry.answer === undefined) {
            entry.answer = textFor(conn, conn.chats?.[entry.chatKey])('answered')
            if (entry.card !== undefined) entry.card.settled = { answer: entry.answer, options: [] }
            touched = true
          }
        }
      }
      if (touched) {
        scheduleWrite(conn.id)
        await settledEdits(conn)
      }
      // A card whose source is gone stays only until its copies are settled and
      // edited where the platform can edit; keeping it forever grows the file.
      const editable = runners.get(conn.id)?.handle?.edit !== undefined
      let pruned = false
      for (const [cardKey, entries] of Object.entries(data.cards)) {
        if (openCard(cardKey)) continue
        const droppable = entries.length === 0 || entries.every(entry => entry.answer !== undefined
          && (entry.edited === true || (entry.messageId === undefined && entry.ephemeralMessageId === undefined) || !editable || conn.chats?.[entry.chatKey] === undefined))
        if (droppable) {
          delete data.cards[cardKey]
          pruned = true
        }
      }
      if (pruned) scheduleWrite(conn.id)
    }
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
    const runner = { handle: undefined, queues: new Map(), typing: undefined, drafts: new Map(), draftChats: new Map(), nextDraftId: randomBytes(4).readUInt32BE(0) || 1 }
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
        onStatus: onStatus(conn.id),
      })
      // A stop() during connect took the slot back: undo the just-started
      // adapter instead of leaving it running unreachable.
      if (runners.get(conn.id) !== runner) {
        void Promise.resolve(handle?.stop?.()).catch(() => {})
        return
      }
      runner.handle = handle
      for (const chatKey of runner.queues.keys()) void drain(conn, chatKey)
      if (platform?.topics === true) {
        for (const chatKey of Object.keys(conn.chats ?? {})) await ensurePrivateTopics(conn, chatKey)
      }
      if (typeof runner.handle?.typing === 'function') {
        runner.typing = setInterval(() => {
          for (const { chatKey, chat, target } of targetsOf(fresh(conn.id) ?? conn)) {
            if (target !== undefined && busyOf(target)) void runner.handle.typing({ key: chatKey, kind: chat.kind, title: chat.title, ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }) }).catch?.(() => {})
          }
        }, TYPING_MS)
        runner.typing.unref?.()
      }
      if (platform?.privateCards === true && typeof handle.deletePrivateCard === 'function') {
        runner.privateTimer = setInterval(() => {
          const current = fresh(conn.id)
          if (current !== undefined) void expirePrivateCards(current).catch(error => rt.warn('ds-bot: Private card fallback failed: %s', error))
        }, 1000)
        runner.privateTimer.unref?.()
      }
      await diffCards()
    } catch (error) {
      runners.delete(conn.id)
      setStatus(conn.id, { state: 'error', error: String(error?.message ?? error).slice(0, 300), at: Date.now() })
    }
  }
  const stop = async (id) => {
    const runner = runners.get(id)
    runners.delete(id)
    if (runner?.typing !== undefined) clearInterval(runner.typing)
    clearInterval(runner?.privateTimer)
    for (const queue of runner?.queues.values() ?? []) clearTimeout(queue.retry)
    for (const held of runner?.draftChats.values() ?? []) clearTimeout(held.timer)
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
        const text = textFor(conn, chat)
        const target = resolveTarget(conn, chat)
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
      if (imPlatform(conn.platform)?.drafts !== true || typeof runner?.handle?.draft !== 'function') continue
      if (frame.type === 'start') {
        const botId = rt.chatOwners.get(agent.id)
        const roomId = rt.groupOwners.get(agent.id)?.roomId
        const match = roomId === undefined ? { botId } : { roomId }
        if ((botId === undefined && roomId === undefined) || (roomId === undefined && (state.exchangeTurns[agent.id] ?? []).includes(frame.turn))) continue
        finishDraft(runner, key)
        const attempt = { sessionId: agent.id, turn: frame.turn, step: frame.step, text: '', copies: [] }
        for (const { chatKey, chat, target } of listeners(conn, match)) {
          if (chat.kind !== 'direct') continue
          attempt.copies.push({ attempt, target, draftId: runner.nextDraftId++, chat: { key: chatKey, kind: chat.kind, title: chat.title, ...(chat.threadId === undefined ? {} : { threadId: chat.threadId }) } })
        }
        if (attempt.copies.length > 0) runner.drafts.set(key, attempt)
        continue
      }
      const attempt = runner.drafts.get(key)
      if (attempt === undefined) continue
      if (frame.type === 'end') {
        finishDraft(runner, key)
      } else if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') {
        attempt.text += frame.chunk.text
        for (const copy of attempt.copies) {
          const chatKey = addressKey(copy.chat)
          let held = runner.draftChats.get(chatKey)
          if (held === undefined) runner.draftChats.set(chatKey, held = { lastAt: 0 })
          held.pending = copy
          flushDraft(conn, chatKey)
        }
      }
    }
  })
  ctx.on('session/event', (session, event) => {
    const initiatorRpcId = event.type === 'user/message' ? event.data?.source?.rpcId : undefined
    const request = initiatorRpcId === undefined ? undefined : [...runtimes.entries()]
      .filter(([id]) => connections()[id] !== undefined).map(([, held]) => held.data.requests[initiatorRpcId]).find(Boolean)
    for (const [id, held] of runtimes) {
      if (imPlatform(connections()[id]?.platform)?.privateCards !== true
        || !['turn/start', 'user/message', 'turn/end'].includes(event.type)) continue
      const data = held.data
      if (event.type === 'turn/start') data.turns[session.id] = { turn: event.data.turn }
      if (event.type === 'user/message') {
        const turn = data.turns[session.id]
        if (turn !== undefined && turn.opened !== true) {
          turn.opened = true
          if (request !== undefined) turn.initiator = request
        }
        if (request !== undefined) delete data.requests[initiatorRpcId]
      }
      if (event.type === 'turn/end') delete data.turns[session.id]
      scheduleWrite(id)
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      for (const runner of runners.values()) {
        for (const [key, attempt] of runner.drafts) {
          if (attempt.sessionId === session.id
            && (event.data?.turn === undefined || attempt.turn === event.data.turn)
            && (event.data?.step === undefined || attempt.step === event.data.step)) finishDraft(runner, key)
        }
      }
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
        for (const { chatKey, chat } of listeners(conn, { botId })) sendTo(conn, chatKey, chat, body, undefined, undefined, item.kind === 'bot')
      }
    }
  })

  rt.onRoomLine((room, line) => {
    if (line.botId === undefined || line.kind !== undefined || typeof line.text !== 'string' || line.text.trim() === '') return
    const body = `**${line.who}**: ${line.text}`
    for (const conn of Object.values(connections())) {
      if (!runners.has(conn.id)) continue
      for (const { chatKey, chat } of listeners(conn, { roomId: room.id })) sendTo(conn, chatKey, chat, body, undefined, undefined, true)
    }
  })

  rt.onApproval((kind, data) => {
    if (kind === 'open') {
      void (async () => {
        for (const conn of Object.values(connections())) {
          const runner = runners.get(conn.id)
          if (runner === undefined) continue
          const bot = rt.botOf(data.botId)
          const targets = data.roomId !== undefined ? listeners(conn, { roomId: data.roomId }) : listeners(conn, { botId: data.botId })
          const buttons = imPlatform(conn.platform)?.buttons === true ? text => cardButtons.approval(data.id, text) : undefined
          const initiator = (await cardsOf(conn.id)).turns[data.sessionId]?.initiator
          await sendCard(conn, `a:${data.id}`, targets, text => cardText.approval(bot?.name ?? '?', data, text), buttons,
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
        await settleCard(conn.id, `a:${data.id}`, text => data.outcome === 'allowed-once' ? text('allow') : data.outcome === 'rejected' ? text('reject') : text('answered'))
        await settledEdits(conn)
      }
    })().catch(() => {})
  })

  rt.onSaved(() => {
    void diffCards().then(settleGone).catch(() => {})
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
      await settleCard(conn.id, `q:${question.id}`, labels.length ? labels.join(', ') : text => text('answered'), labels)
      await settledEdits(conn)
    }
  }

  Object.assign(rt, { imView, imStatusView, imViaView, imEndpoint, imQuestionAnswered })
}
