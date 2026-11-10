// Telegram Bot API adapter: getUpdates long polling in, sendMessage out. Parts of the
// protocol mapping follow dsh-im (MIT, © 2026 xmanrui — see NOTICE).
import { chunkTelegram } from '../format.js'
import { chunkRich, RICH_LIMIT } from '../rich-format.js'
import { retryDelay, retryWait } from './retry.js'

const TEXT_LIMIT = 4096
const POLL_TIMEOUT = 50
const UPDATES = ['message', 'callback_query', 'stopped_message_generation', 'widget_query']
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const thread = chat => chat.threadId === undefined ? {} : { message_thread_id: chat.threadId }
const optionLabel = option => option.checked === undefined ? option.label : `${option.checked ? '☑' : '☐'} ${option.label}`
const keyboard = buttons => ({ inline_keyboard: (buttons ?? []).map(button => [{ text: button.label, ...(button.disabled ? { disabled: {} } : { callback_data: button.data }) }]) })
const plainCard = card => ({
  text: [card.text, card.details?.text, card.details?.code, card.settled ? `— ${card.settled.answer}` : undefined].filter(Boolean).join('\n'),
  buttons: card.settled ? card.settled.options.map(option => ({ ...option, disabled: true })) : (card.options ?? []).map(option => ({ ...option, label: optionLabel(option) })),
})
const cardChunks = card => {
  const options = card.settled === undefined ? (card.options ?? []) : card.settled.options
  const rows = options.map(option => {
    if (card.settled === undefined && (Buffer.byteLength(option.data) > 64 || option.data.length === 0)) throw Object.assign(new Error('Telegram card callback must be 1–64 bytes'), { permanent: true })
    const action = card.settled === undefined ? `type="callback_data" data="${escape(option.data)}"` : 'type="disabled"'
    return `<tg-button-row><tg-button ${action}${option.style ? ` style="${escape(option.style)}"` : ''}>${escape(optionLabel(option))}</tg-button></tg-button-row>`
  }).join('\n')
  const buttonSize = (card.options ?? []).reduce((size, option) => size + Array.from(optionLabel(option)).length + 1, 0)
  // Keep the same content chunks on settlement; reserve both labels and the answer footer.
  const limit = Math.max(1, RICH_LIMIT - buttonSize * 2 - 32)
  const chunks = chunkRich(card.text, limit)
  const details = [
    ...chunkRich(card.details?.text, limit),
    ...Array.from(card.details?.code ?? '').reduce((parts, point, index) => {
      if (index % limit === 0) parts.push('')
      parts[parts.length - 1] += point
      return parts
    }, []).map(code => ({ html: `<pre><code>${escape(code)}</code></pre>`, size: Array.from(code).length })),
  ]
  for (const detail of details) {
    const html = `<blockquote expandable>${detail.html}</blockquote>`
    const last = chunks.at(-1)
    if (last && last.size + detail.size + 1 <= limit) {
      last.html += `\n${html}`
      last.size += detail.size + 1
    } else chunks.push({ html, size: detail.size })
  }
  if (rows) {
    if (chunks.length === 0) chunks.push({ html: '', size: 0 })
    chunks.at(-1).html += `\n${rows}`
  }
  if (card.settled) chunks.at(-1).html += `\n<p>— ${escape(card.settled.answer)}</p>`
  return chunks
}

const reason = (error) => {
  const text = [error, error?.cause].map(part => String(part?.message ?? part ?? '')).filter(Boolean).join(': ')
  return text.slice(0, 300) || 'error'
}

const nameOf = (from) => {
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim()
  return from?.username ? `@${from.username}` : (name || String(from?.id ?? ''))
}

export default {
  id: 'telegram',

  async check(fields, env) {
    const token = String(fields.token ?? '').trim()
    if (token === '') throw new Error('Paste the bot token first')
    const me = await callApi(env, token, 'getMe', {})
    if (typeof me?.id !== 'number' || typeof me.username !== 'string') throw new Error('Telegram did not say who this token belongs to')
    return { account: { id: String(me.id), name: `@${me.username}`, ...(me.has_topics_enabled === true ? { hasTopicsEnabled: true } : {}) } }
  },

  connect(fields, env, handlers) {
    const token = String(fields.token ?? '').trim()
    const base = `${apiBase(env)}/bot${token}`
    const fileBase = `${apiBase(env)}/file/bot${token}`
    let stopped = false
    // Every call in flight keeps its own controller, so stop() ends them all —
    // a long poll must not outlive the adapter by ~65 s and collide with the
    // restarted one (Telegram answers 409).
    const inFlight = new Set()
    let selfName = ''

    const call = async (method, params, { download = false, timeout = 30_000 } = {}) => {
      const abort = new AbortController()
      inFlight.add(abort)
      if (stopped) abort.abort(stoppedError())
      const timer = setTimeout(() => abort.abort(new Error('timeout')), timeout)
      try {
        const response = await env.fetch(download ? `${fileBase}/${method}` : `${base}/${method}`, download ? { signal: abort.signal } : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: abort.signal,
        })
        if (download) {
          if (!response.ok) throw Object.assign(new Error(`Telegram answered ${response.status}`), { status: response.status, permanent: response.status >= 400 && response.status < 500 })
          return new Uint8Array(await response.arrayBuffer())
        }
        const body = await response.json().catch(() => ({}))
        if (!body.ok) {
          const error = new Error(String(body.description ?? `Telegram answered ${response.status}`))
          error.status = body.error_code ?? response.status
          if (body.parameters?.retry_after !== undefined) error.retryAfter = Number(body.parameters.retry_after)
          error.permanent = error.status >= 400 && error.status < 500 && error.status !== 429
          throw error
        }
        return body.result
      } catch (error) {
        if (stopped) throw stoppedError()
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          const timeout = new Error('Telegram did not answer in time')
          timeout.unknown = true
          throw timeout
        }
        throw error
      } finally {
        clearTimeout(timer)
        inFlight.delete(abort)
      }
    }
    const stoppedError = () => Object.assign(new Error('stopped'), { stopped: true })

    const getMe = async () => {
      const me = await call('getMe', {})
      selfName = me.username ? `@${me.username}` : ''
      return me
    }

    const strip = (text) => {
      if (selfName === '') return text
      return text.replaceAll(selfName, ' ').replace(/\s+/g, ' ').trim()
    }

    const fileBlocks = async (message) => {
      const images = []
      const files = []
      const photo = Array.isArray(message.photo) && message.photo.length > 0 ? message.photo.reduce((a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a)) : undefined
      if (photo !== undefined) {
        try {
          const file = await call('getFile', { file_id: photo.file_id })
          const data = await call(file.file_path, {}, { download: true, timeout: 60_000 })
          images.push({ mediaType: 'image/jpeg', data: Buffer.from(data).toString('base64') })
        } catch (error) { env.log?.warn?.('ds-bot im: telegram photo not fetched: %s', reason(error)) }
      }
      const doc = message.document ?? message.voice ?? message.audio
      if (doc?.file_id !== undefined) {
        try {
          const file = await call('getFile', { file_id: doc.file_id })
          const data = await call(file.file_path, {}, { download: true, timeout: 60_000 })
          files.push({ name: doc.file_name ?? file.file_path?.split('/').pop() ?? 'file', data })
        } catch (error) { env.log?.warn?.('ds-bot im: telegram file not fetched: %s', reason(error)) }
      }
      return { images, files }
    }

    const onUpdate = async (update) => {
      if (update.widget_query !== undefined) {
        const query = update.widget_query
        // Acknowledge before cancellation/network work can consume the 15-second deadline.
        await call('answerWidgetQuery', { widget_query_id: query.id }, { timeout: 10_000 }).catch(error => env.log?.warn?.('ds-bot: widget answer failed: %s', reason(error)))
        await handlers.onWidgetQuery?.({
          chat: { key: String(query.chat?.id), kind: query.chat?.type === 'private' ? 'direct' : 'group' },
          sender: { id: String(query.from?.id ?? ''), languageCode: query.from?.language_code },
          messageId: query.message_id, data: query.data, type: query.type?.type,
        })
        return
      }
      if (update.stopped_message_generation !== undefined) {
        const event = update.stopped_message_generation
        await handlers.onStop?.({
          chat: { key: String(event.chat?.id), kind: event.chat?.type === 'private' ? 'direct' : 'group', ...(event.message_thread_id === undefined ? {} : { threadId: event.message_thread_id }) },
          draftId: event.draft_id,
        })
        return
      }
      if (update.message !== undefined) {
        const message = update.message
        const chat = message.chat ?? {}
        const kind = chat.type === 'private' ? 'direct' : 'group'
        const from = message.from ?? {}
        const raw = String(message.text ?? message.caption ?? '')
        const commandBot = /^\/\w+(@\w+)(?:\s|$)/.exec(raw)?.[1]
        if (chat.is_forum === true && commandBot !== undefined && commandBot.toLowerCase() !== selfName.toLowerCase()) return
        const mentioned = kind === 'group' && (
          (selfName !== '' && raw.includes(selfName))
          || (message.entities ?? []).some(entity => entity.type === 'mention' && raw.slice(entity.offset, entity.offset + entity.length) === selfName)
          || message.reply_to_message?.from?.is_bot === true && selfName !== '' && message.reply_to_message?.from?.username === selfName.slice(1)
          || /^\/\w+@/.test(raw) && raw.toLowerCase().includes(selfName.toLowerCase())
        )
        const { images, files } = await fileBlocks(message)
        await handlers.onMessage({
          chat: { key: String(chat.id), kind, title: chat.title ?? nameOf(from), ...(chat.type === 'supergroup' && chat.is_forum === true ? { isForum: true } : {}), ...(message.message_thread_id === undefined ? {} : { threadId: message.message_thread_id }) },
          sender: { id: String(from.id ?? ''), name: nameOf(from), ...(from.language_code === undefined ? {} : { languageCode: from.language_code }) },
          text: kind === 'group' ? strip(raw) : raw,
          images,
          files,
          mentioned,
          messageId: message.message_id,
        })
        return
      }
      if (update.callback_query !== undefined) {
        const query = update.callback_query
        const message = query.message ?? {}
        const chat = message.chat ?? {}
        const from = query.from ?? {}
        await call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {})
        await handlers.onAction({
          chat: { key: String(chat.id), kind: chat.type === 'private' ? 'direct' : 'group', title: chat.title ?? nameOf(from), ...(chat.type === 'supergroup' && chat.is_forum === true ? { isForum: true } : {}), ...(message.message_thread_id === undefined ? {} : { threadId: message.message_thread_id }) },
          sender: { id: String(from.id ?? ''), name: nameOf(from), ...(from.language_code === undefined ? {} : { languageCode: from.language_code }) },
          data: String(query.data ?? ''),
          messageId: message.message_id,
          callbackQueryId: query.id,
          ephemeralMessageId: message.ephemeral_message_id,
          receiverUserId: message.receiver_user?.id === undefined ? undefined : String(message.receiver_user.id),
        })
      }
    }

    let attempt = 0
    let ready = false
    // The first getMe is part of the poll loop: a network failure there is a retry,
    // not the end of the connection (#1119). A refused token stops instead.
    const poll = async () => {
      while (!stopped) {
        try {
          if (!ready) {
            const me = await getMe()
            ready = true
            attempt = 0
            handlers.onStatus({ state: 'ready', account: { id: String(me.id), name: selfName || String(me.id), ...(me.has_topics_enabled === true ? { hasTopicsEnabled: true } : {}) } })
          }
          const updates = await call('getUpdates', { offset: env.runtime.get().offset ?? 0, timeout: POLL_TIMEOUT, allowed_updates: UPDATES }, { timeout: (POLL_TIMEOUT + 15) * 1000 })
          for (const update of Array.isArray(updates) ? updates : []) {
            if (typeof update.update_id === 'number') env.runtime.set({ offset: update.update_id + 1 })
            await onUpdate(update).catch(error => env.log?.warn?.('ds-bot im: telegram update failed: %s', reason(error)))
          }
          attempt = 0
          handlers.onStatus({ state: 'ready' })
        } catch (error) {
          if (error.stopped || stopped) return
          if (error.status === 409) {
            handlers.onStatus({ state: 'error', error: 'A webhook or another program uses this bot' })
            return
          }
          // A refused token will not fix itself; a network failure is retried at the
          // preset's retry_after, or after a growing wait.
          if (error?.permanent === true) {
            handlers.onStatus({ state: 'error', error: reason(error) })
            return
          }
          handlers.onStatus({ state: 'retrying', error: reason(error) })
          const wait = error.retryAfter !== undefined ? Math.max(0, Number(error.retryAfter)) * 1000 : retryDelay(attempt)
          attempt += 1
          await retryWait(wait)
        }
      }
    }
    void poll()

    const richIds = new Set()
    const identity = (chat, id) => JSON.stringify([chat.key, chat.threadId, id])
    const send = async (chat, { text, buttons, rich = false }) => {
      if (rich) {
        let messageId
        try {
          for (const chunk of chunkRich(text)) {
            const sent = await call('sendRichMessage', { chat_id: chat.key, ...thread(chat), rich_message: { html: chunk.html } })
            messageId = sent?.message_id ?? messageId
            richIds.add(identity(chat, messageId))
          }
          return { messageId }
        } catch (error) {
          if (error.status !== 404 && !/method (?:not found|unknown)|unknown method/i.test(error.message)) {
            env.log?.warn('ds-bot: Telegram rich send failed: %s', reason(error))
            throw error
          }
        }
      }
      const chunks = chunkTelegram(text, TEXT_LIMIT)
      let messageId
      for (const [index, chunk] of chunks.entries()) {
        const markup = index === chunks.length - 1 && buttons?.length > 0
          ? { reply_markup: keyboard(buttons) }
          : {}
        const sendOne = async (body) => {
          try {
            return await call('sendMessage', { chat_id: chat.key, ...thread(chat), text: body, parse_mode: 'HTML', ...markup })
          } catch (error) {
            // Telegram rejects entities it cannot parse; the same text goes plain.
            if (body !== chunk.text && /can't parse entities|parse entities/i.test(String(error?.message ?? ''))) {
              return await call('sendMessage', { chat_id: chat.key, ...thread(chat), text: chunk.text, ...markup })
            }
            throw error
          }
        }
        const sent = await sendOne(chunk.html)
        messageId = sent?.message_id ?? messageId
      }
      return { messageId }
    }

    return {
      send,
      isAdmin: async (chat, userId) => {
        const member = await call('getChatMember', { chat_id: chat.key, user_id: Number(userId) })
        return member?.status === 'creator' || member?.status === 'administrator'
      },
      sendStatusPanel: async (chat, { html, data, caption }) => {
        if (chat.kind !== 'direct') throw new Error('Status widgets require a private chat')
        const sent = await call('sendWidget', { chat_id: chat.key, ...thread(chat), html, chat_data: data, caption, allow_queries: true })
        if (!Number.isSafeInteger(sent?.message_id)) throw new Error('Telegram did not return a Status panel identity')
        await call('pinChatMessage', { chat_id: chat.key, message_id: sent.message_id, disable_notification: true })
        return { messageId: sent.message_id }
      },
      editStatusPanel: (chat, messageId, data) => call('editMessageWidgetData', { chat_id: chat.key, message_id: messageId, chat_data: data }),
      createTopic: async (chat, name) => {
        const topic = await call('createForumTopic', { chat_id: chat.key, name: Array.from(name).slice(0, 128).join('') })
        if (!Number.isSafeInteger(topic?.message_thread_id) || topic.message_thread_id <= 0) throw new Error('Telegram did not return a Topic ID')
        return { threadId: topic.message_thread_id }
      },
      sendCard: async (chat, card) => {
        let messageId
        try {
          for (const chunk of cardChunks(card)) {
            const sent = await call('sendRichMessage', { chat_id: chat.key, ...thread(chat), rich_message: { html: chunk.html } })
            messageId = sent?.message_id ?? messageId
          }
          return { messageId, cardFormat: 'rich' }
        } catch (error) {
          if (error.status !== 404 && !/method (?:not found|unknown)|unknown method/i.test(error.message)) {
            env.log?.warn('ds-bot: Telegram rich card send failed: %s', reason(error))
            throw error
          }
          return { ...await send(chat, plainCard(card)), cardFormat: 'text' }
        }
      },
      editCard: async (chat, messageId, card, format) => {
        if (format === 'text') {
          const body = plainCard(card)
          await call('editMessageText', { chat_id: chat.key, message_id: messageId, text: chunkTelegram(body.text, TEXT_LIMIT).at(-1)?.html ?? '', parse_mode: 'HTML', reply_markup: keyboard(body.buttons) })
          return
        }
        await call('editMessageText', { chat_id: chat.key, message_id: messageId, rich_message: { html: cardChunks(card).at(-1)?.html ?? '<p></p>' } })
      },
      sendPrivateCard: async (chat, receiverUserId, card) => {
        const ephemeralMessageIds = []
        for (const chunk of cardChunks(card)) {
          const sent = await call('sendRichMessage', {
            chat_id: chat.key,
            ...(chat.threadId === undefined ? {} : { message_thread_id: chat.threadId }),
            ephemeral_message_parameters: { receiver_user_id: Number(receiverUserId) },
            rich_message: { html: chunk.html },
          })
          if (!Number.isSafeInteger(sent?.ephemeral_message_id)) throw Object.assign(new Error('Telegram did not return a Private card identity'), { permanent: true })
          ephemeralMessageIds.push(sent.ephemeral_message_id)
        }
        return { ephemeralMessageId: ephemeralMessageIds.at(-1), ephemeralMessageIds, cardFormat: 'rich' }
      },
      editPrivateCard: (chat, copy, card) => call('editEphemeralMessageText', {
        chat_id: chat.key, receiver_user_id: Number(copy.receiverUserId), ephemeral_message_id: copy.ephemeralMessageId,
        rich_message: { html: cardChunks(card).at(-1)?.html ?? '<p></p>' },
      }),
      deletePrivateCard: async (chat, copy) => {
        for (const id of copy.ephemeralMessageIds ?? [copy.ephemeralMessageId]) {
          await call('deleteEphemeralMessage', { chat_id: chat.key, receiver_user_id: Number(copy.receiverUserId), ephemeral_message_id: id })
        }
      },
      draft: async (chat, { draftId, text }) => {
        if (chat.kind !== 'direct') return
        const chunks = chunkRich(text)
        await call('sendRichMessageDraft', {
          chat_id: Number(chat.key),
          ...(chat.threadId === undefined ? {} : { message_thread_id: chat.threadId }),
          draft_id: draftId,
          rich_message: { html: chunks.at(-1)?.html ?? '<p></p>' },
          can_stop: true,
        })
      },
      edit: async (chat, messageId, { text, buttons }) => {
        const markup = { reply_markup: keyboard(buttons) }
        if (richIds.has(identity(chat, messageId))) {
          const chunks = chunkRich(text)
          await call('editMessageText', { chat_id: chat.key, message_id: messageId, rich_message: { html: chunks[0]?.html ?? '<p></p>' }, ...markup })
          for (const chunk of chunks.slice(1)) {
            const sent = await call('sendRichMessage', { chat_id: chat.key, ...thread(chat), rich_message: { html: chunk.html } })
            richIds.add(identity(chat, sent?.message_id))
          }
          return
        }
        try {
          await call('editMessageText', { chat_id: chat.key, message_id: messageId, text: chunkTelegram(text, TEXT_LIMIT)[0]?.html ?? '', parse_mode: 'HTML', ...markup })
        } catch (error) {
          if (/can't parse entities|parse entities/i.test(String(error?.message ?? ''))) {
            await call('editMessageText', { chat_id: chat.key, message_id: messageId, text: chunkTelegram(text, TEXT_LIMIT)[0]?.text ?? '', ...markup })
            return
          }
          throw error
        }
      },
      typing: chat => call('sendChatAction', { chat_id: chat.key, ...thread(chat), action: 'typing' }).catch(() => {}),
      stop: () => {
        stopped = true
        for (const abort of inFlight) abort.abort(stoppedError())
      },
    }
  },
}

const apiBase = env => String(env.config?.api ?? 'https://api.telegram.org').replace(/\/+$/, '')

// One Bot API call without the connection's abort bookkeeping, used by `check`
// before a connection exists.
async function callApi(env, token, method, params) {
  const response = await env.fetch(`${apiBase(env)}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  const body = await response.json().catch(() => ({}))
  if (!body.ok) throw new Error(String(body.description ?? `Telegram answered ${response.status}`))
  return body.result
}
