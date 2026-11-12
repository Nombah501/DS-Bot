import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import telegram from '../src/host/im/platforms/telegram.js'

// A fake Bot API: requests are recorded and answered from `replies`; updates the
// adapter polls come from `updates`, newest first.
function fakeApi({ getMe = { id: 7, username: 'fakebot', is_bot: true } } = {}) {
  const calls = []
  const updates = []
  const replies = {}
  const files = {}
  let out
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname.startsWith('/file/bot')) {
      const path = url.pathname.slice('/file/botTOKEN/'.length)
      const body = files[path]
      if (body === undefined) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(body)
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const [, , method] = url.pathname.split('/') // /bot<token>/<method>
      const params = JSON.parse(body || '{}')
      calls.push({ method, params })
      if (method === 'getUpdates' && out?.holdPoll === true && updates.length === 0) {
        out.heldPoll.push(res)
        return
      }
      let answer = replies[method]
      if (answer === undefined && method === 'getUpdates') answer = { result: updates.splice(0) }
      if (answer === undefined && method === 'getMe') answer = { result: getMe }
      if (answer === undefined && method === 'getFile') answer = { result: { file_id: params.file_id, file_path: 'photos/p1.jpg' } }
      if (typeof answer === 'function') answer = answer(params)
      if (answer === undefined) answer = { result: true }
      if (answer.error) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error_code: answer.error, description: answer.description, parameters: answer.parameters }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: answer.result, message_id: answer.message_id ?? calls.length }))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const api = `http://127.0.0.1:${server.address().port}`
    out = { api, calls, updates, replies, files, holdPoll: false, heldPoll: [], close: () => server.close() }
    resolve(out)
  }))
}

const env = (api, runtime = {}) => ({
  fetch: globalThis.fetch,
  config: { api },
  runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
  log: { warn: (...args) => console.error('[im-telegram]', ...args) },
})

const until = async (fn, tries = 60) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 10))
  }
  throw new Error('timed out waiting')
}

test('check validates the token with getMe and names the account', async () => {
  const api = await fakeApi()
  try {
    const account = await telegram.check({ token: 'TOKEN' }, env(api.api))
    assert.deepEqual(account.account, { id: '7', name: '@fakebot' })
    assert.equal(api.calls[0].method, 'getMe')
    await assert.rejects(telegram.check({ token: 'bad' }, { ...env(api.api), fetch: async () => ({ json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) }) }))
  } finally { api.close() }
})

test('private text, group mention and photo become adapter messages', async () => {
  const api = await fakeApi()
  const got = { messages: [], actions: [] }
  try {
    api.files['photos/p1.jpg'] = Buffer.from('jpeg-bytes')
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
      onMessage: msg => got.messages.push(msg),
      onAction: action => got.actions.push(action),
      onStatus: () => {},
    })
    api.updates.push({ update_id: 1, message: { message_id: 11, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann', username: 'ann' }, text: 'hi there' } })
    api.updates.push({ update_id: 2, message: { message_id: 12, chat: { id: -8, type: 'supergroup', title: 'Crew' }, from: { id: 9, first_name: 'Ann' }, text: '@fakebot look', entities: [{ type: 'mention', offset: 0, length: 8 }] } })
    api.updates.push({ update_id: 3, message: { message_id: 13, chat: { id: 5, type: 'private' }, from: { id: 9, first_name: 'Ann' }, caption: 'see', photo: [{ file_id: 'sm', file_size: 10 }, { file_id: 'big', file_size: 99 }] } })
    await until(() => got.messages.length >= 3)
    const [dm, gm, photo] = got.messages
    assert.deepEqual({ key: dm.chat.key, kind: dm.chat.kind }, { key: '5', kind: 'direct' })
    assert.equal(dm.text, 'hi there')
    assert.deepEqual(dm.sender, { id: '9', name: '@ann' })
    assert.equal(gm.chat.kind, 'group')
    assert.equal(gm.mentioned, true)
    assert.equal(gm.text, 'look', 'the mention is stripped')
    assert.equal(photo.images.length, 1)
    assert.equal(photo.images[0].data, Buffer.from('jpeg-bytes').toString('base64'))
    assert.ok(api.calls.some(call => call.method === 'getFile' && call.params.file_id === 'big'))
    handle.stop()
  } finally { api.close() }
})

test('callback_query answers the query and reports the action', async () => {
  const api = await fakeApi()
  const got = { actions: [] }
  try {
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage: () => {}, onAction: action => got.actions.push(action), onStatus: () => {} })
    api.updates.push({ update_id: 4, callback_query: { id: 'cq1', from: { id: 9, first_name: 'Ann' }, data: 'a:x:allow', message: { message_id: 44, chat: { id: 5, type: 'private' } } } })
    await until(() => got.actions.length === 1)
    assert.equal(got.actions[0].data, 'a:x:allow')
    assert.equal(got.actions[0].messageId, 44)
    await until(() => api.calls.some(call => call.method === 'answerCallbackQuery' && call.params.callback_query_id === 'cq1'))
    assert.equal(api.calls.filter(call => call.method === 'answerCallbackQuery' && call.params.callback_query_id === 'cq1').length, 1)
    handle.stop()
  } finally { api.close() }
})

for (const failure of ['slow', 'throw', 'reject']) {
  test(`callback_query is answered once even when core is ${failure}`, async t => {
    const api = await fakeApi()
    api.holdPoll = true
    let release
    const pending = new Promise(resolve => { release = resolve })
    t.after(() => { release(); api.close() })
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
      onMessage() {}, onStatus() {},
      onAction(action) {
        if (failure === 'throw') throw new Error('Core failed')
        if (failure === 'reject') return Promise.reject(new Error('Core rejected'))
        return pending.then(() => action.answer('Too late'))
      },
    })
    t.after(() => handle.stop())
    api.updates.push({ update_id: 1, callback_query: { id: failure, from: { id: 9 }, data: 'q:x:0', message: { message_id: 44, chat: { id: 5, type: 'private' } } } })
    const answer = await until(() => api.calls.find(call => call.method === 'answerCallbackQuery'), 250)
    assert.deepEqual(answer.params, { callback_query_id: failure })
    release()
    await until(() => api.calls.filter(call => call.method === 'getUpdates').length >= 2)
    assert.equal(api.calls.filter(call => call.method === 'answerCallbackQuery').length, 1)
  })
}

test('callback toast wins the acknowledgement once, even if Telegram rejects it', async t => {
  const api = await fakeApi()
  api.holdPoll = true
  api.replies.answerCallbackQuery = { error: 400, description: 'Query is too old' }
  t.after(() => api.close())
  const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
    onMessage() {}, onStatus() {},
    async onAction(action) {
      await action.answer('Select at least one option.')
      await action.answer('Duplicate')
    },
  })
  t.after(() => handle.stop())
  api.updates.push({ update_id: 1, callback_query: { id: 'toast', from: { id: 9 }, data: 'm:x:done', message: { message_id: 44, chat: { id: 5, type: 'private' } } } })
  await until(() => api.calls.filter(call => call.method === 'getUpdates').length >= 2)
  assert.deepEqual(api.calls.filter(call => call.method === 'answerCallbackQuery').map(call => call.params), [{ callback_query_id: 'toast', text: 'Select at least one option.' }])
})

test('send renders HTML, chunks long text, buttons go on the last chunk', async () => {
  const api = await fakeApi()
  try {
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
    await handle.send({ key: '5' }, { text: '**bold** ' + 'word '.repeat(1500), buttons: [{ data: 'a:1:allow', label: 'Allow once' }] })
    const sends = api.calls.filter(call => call.method === 'sendMessage')
    assert.equal(sends.length, 2)
    for (const call of sends) assert.ok(call.params.text.length <= 4096, call.params.text.length)
    assert.equal(sends[0].params.parse_mode, 'HTML')
    assert.equal(sends[1].params.reply_markup.inline_keyboard[0][0].callback_data, 'a:1:allow')
    handle.stop()
  } finally { api.close() }
})

test('a chunk Telegram cannot parse goes again as plain text', async () => {
  const api = await fakeApi()
  try {
    let parsed = false
    api.replies.sendMessage = (params) => {
      if (params.parse_mode === 'HTML' && !parsed) { parsed = true; return { error: 400, description: "Bad Request: can't parse entities" } }
      return { result: { message_id: 7 } }
    }
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
    await handle.send({ key: '5' }, { text: 'plain < enough' })
    const sends = api.calls.filter(call => call.method === 'sendMessage')
    assert.equal(sends.length, 2)
    assert.equal(sends[1].params.parse_mode, undefined, 'resent without a parse mode')
    handle.stop()
  } finally { api.close() }
})

test('429 is honored with retry_after and 409 becomes a status error', async () => {
  const api = await fakeApi()
  try {
    let hits = 0
    api.replies.getUpdates = () => { hits += 1; return hits === 1 ? { error: 429, description: 'Too Many', parameters: { retry_after: 0 } } : { error: 409, description: 'Conflict' } }
    const statuses = []
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
    await until(() => statuses.some(next => next.state === 'error' && /webhook or another program/i.test(next.error ?? '')))
    handle.stop()
  } finally { api.close() }
})

test('stop ends a long poll promptly, and a send in flight does not kill it', async () => {
  const api = await fakeApi()
  api.holdPoll = true
  const handle = telegram.connect({ token: 'tok' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  await until(() => api.calls.some(call => call.method === 'getUpdates'))
  // A send while the poll waits goes on its own controller; the poll stays.
  await handle.send({ key: '1', kind: 'direct' }, { text: 'hi' })
  assert.ok(api.calls.some(call => call.method === 'sendMessage'))
  assert.equal(api.heldPoll.length, 1)
  const before = api.calls.length
  await handle.stop()
  await new Promise(done => setTimeout(done, 150))
  assert.equal(api.calls.length, before, 'stop aborts the poll instead of retrying')
  await api.close()
})

test('a network failure before the first reply is retried until the Bot API answers (#1119)', async (t) => {
  const api = await fakeApi()
  const statuses = []
  const base = env(api.api)
  let down = true
  let requests = 0
  const fetch = async (...args) => {
    requests += 1
    if (down) throw new TypeError('fetch failed')
    return base.fetch(...args)
  }
  const handle = telegram.connect({ token: 'TOKEN' }, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); api.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  const tried = requests
  down = false
  await until(() => statuses.some(status => status.state === 'ready'), 120)
  assert.ok(requests > tried, 'a new request went out after the failure')
  assert.equal(api.calls.filter(call => call.method === 'getMe').length, 1)
})

test('a refused token stops at once instead of retrying (#1119)', async (t) => {
  const api = await fakeApi()
  api.replies.getMe = () => ({ error: 401, description: 'Unauthorized' })
  const statuses = []
  const handle = telegram.connect({ token: 'bad' }, env(api.api), { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); api.close() })
  await until(() => statuses.some(status => status.state === 'error'))
  await new Promise(done => setTimeout(done, 400))
  assert.equal(api.calls.filter(call => call.method === 'getMe').length, 1, 'a refused token is not retried')
})

test('a drop after getMe succeeds is retried, not reported as an error (#1119)', async (t) => {
  const api = await fakeApi()
  const statuses = []
  const base = env(api.api)
  let down = true
  let polls = 0
  const fetch = async (url, ...rest) => {
    if (String(url).includes('/getUpdates')) {
      polls += 1
      if (down) throw new TypeError('fetch failed')
    }
    return base.fetch(url, ...rest)
  }
  const handle = telegram.connect({ token: 'TOKEN' }, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); api.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  assert.ok(statuses.indexOf(failed) > statuses.findIndex(status => status.state === 'ready'), 'getMe already made the connection ready')
  down = false
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 120)
  assert.ok(ready !== undefined, 'polling became ready again after the retry')
  assert.equal(api.calls.filter(call => call.method === 'getMe').length, 1, 'the identity is not fetched again')
  assert.ok(polls >= 2, 'a new long poll went out after the failure')
  assert.equal(statuses.filter(status => status.state === 'error').length, 0, 'a network drop is not shown as an error while it retries')
})

test('rich sends carry format for edits and never degrade other errors', async t => {
  const api = await fakeApi()
  api.holdPoll = true
  const warnings = []
  const handle = telegram.connect({ token: 'TOKEN' }, { ...env(api.api), log: { warn: (...args) => warnings.push(args) } }, { onMessage() {}, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); api.close() })
  api.replies.sendRichMessage = { result: { message_id: 42 } }
  const chat = { key: '5', kind: 'direct' }
  const sent = await handle.send(chat, { text: '**Rich**', rich: true })
  await handle.edit(chat, 42, { text: '# Changed', format: sent.format })
  const edited = api.calls.find(call => call.method === 'editMessageText')
  assert.equal(edited.params.rich_message.html, '<h1>Changed</h1>')
  assert.equal(edited.params.text, undefined)
  await handle.edit({ key: '6', kind: 'direct' }, 42, { text: 'Plain' })
  assert.equal(api.calls.filter(call => call.method === 'editMessageText')[1].params.text, 'Plain')
  for (const error of [400, 403, 429, 500]) {
    api.replies.sendRichMessage = { error, description: 'rich failure' }
    await assert.rejects(handle.send(chat, { text: 'Never degrade', rich: true }), /rich failure/)
  }
  assert.equal(api.calls.some(call => call.method === 'sendMessage'), false)
  assert.equal(warnings.length, 4)
})

test('S2: rich edit format survives reconnect without retaining sent message identities', async t => {
  const api = await fakeApi()
  api.holdPoll = true
  let handle
  t.after(() => { handle?.stop(); api.close() })
  const connect = () => telegram.connect({ token: 'TOKEN' }, env(api.api), { onMessage() {}, onAction() {}, onStatus() {} })
  handle = connect()
  api.replies.sendRichMessage = { result: { message_id: 42 } }
  const chat = { key: '5', kind: 'direct' }
  const sent = await handle.send(chat, { text: 'First', rich: true })
  assert.equal(sent.format, 'rich')
  handle.stop()
  handle = connect()
  await handle.edit(chat, sent.messageId, { text: '# Restored', format: sent.format })
  const edited = api.calls.find(call => call.method === 'editMessageText')
  assert.equal(edited.params.rich_message.html, '<h1>Restored</h1>')
  assert.equal(edited.params.text, undefined)
})

test('message and callback parsing preserve chat and sender data shapes', async t => {
  const api = await fakeApi()
  api.holdPoll = true
  const cases = [
    {
      rawChat: { id: 5, type: 'private' }, from: { id: 9, username: 'ann', first_name: 'Ann', language_code: 'ru' },
      chat: { key: '5', kind: 'direct', title: '@ann' }, sender: { id: '9', name: '@ann', languageCode: 'ru' },
    },
    {
      rawChat: { id: -8, type: 'supergroup', title: 'Crew', is_forum: true }, threadId: 17,
      from: { id: 9, first_name: 'Ann', last_name: 'Lee' },
      chat: { key: '-8', kind: 'group', title: 'Crew', isForum: true, threadId: 17 }, sender: { id: '9', name: 'Ann Lee' },
    },
    {
      rawChat: { id: -9, type: 'group', title: '', is_forum: true }, threadId: 0, from: { id: 0 },
      chat: { key: '-9', kind: 'group', title: '', threadId: 0 }, sender: { id: '0', name: '0' },
    },
    {
      rawChat: { id: -10, type: 'supergroup', is_forum: false }, from: { id: 12, first_name: ' Ann ', last_name: 'Lee ' },
      chat: { key: '-10', kind: 'group', title: 'Ann  Lee' }, sender: { id: '12', name: 'Ann  Lee' },
    },
    {
      chat: { key: 'undefined', kind: 'group', title: '' }, sender: { id: '', name: '' },
    },
  ]
  const messages = []
  const actions = []
  for (const [index, data] of cases.entries()) {
    const message = { message_id: index, chat: data.rawChat, message_thread_id: data.threadId, text: 'hello' }
    api.updates.push({ update_id: index * 2, message: { ...message, from: data.from } })
    api.updates.push({ update_id: index * 2 + 1, callback_query: { id: `query-${index}`, from: data.from, data: 'answer', message } })
  }
  const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
    onMessage: message => messages.push(message), onAction: action => actions.push(action), onStatus() {},
  })
  t.after(() => { handle.stop(); api.close() })
  await until(() => messages.length === cases.length && actions.length === cases.length)
  await until(() => api.calls.filter(call => call.method === 'getUpdates').length >= 2)
  const expected = cases.map(({ chat, sender }) => ({ chat, sender }))
  for (const events of [messages, actions]) {
    assert.deepEqual(events.map(({ chat, sender }) => ({ chat, sender })), expected)
  }
})

test('widget and Draft Stop parsing retain their smaller chat shapes', async t => {
  const api = await fakeApi()
  api.holdPoll = true
  const widgets = []
  const stops = []
  for (const chat of [{ id: 5, type: 'private', title: 'Private' }, { id: -8, type: 'supergroup', title: 'Crew', is_forum: true }]) {
    api.updates.push({ widget_query: { id: 'widget', chat, from: { id: 9, username: 'ann', language_code: 'ru' }, message_thread_id: 17, message_id: 42, data: 'stop', type: { type: 'button' } } })
    api.updates.push({ stopped_message_generation: { chat, message_thread_id: 17, draft_id: 3 } })
  }
  api.updates.push({ widget_query: { id: 'empty' } })
  api.updates.push({ stopped_message_generation: { draft_id: 4 } })
  const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), {
    onWidgetQuery: event => widgets.push(event), onStop: event => stops.push(event), onStatus() {},
  })
  t.after(() => { handle.stop(); api.close() })
  await until(() => widgets.length === 3 && stops.length === 3)
  assert.deepEqual(widgets, [
    { chat: { key: '5', kind: 'direct' }, sender: { id: '9', languageCode: 'ru' }, messageId: 42, data: 'stop', type: 'button' },
    { chat: { key: '-8', kind: 'group' }, sender: { id: '9', languageCode: 'ru' }, messageId: 42, data: 'stop', type: 'button' },
    { chat: { key: 'undefined', kind: 'group' }, sender: { id: '', languageCode: undefined }, messageId: undefined, data: undefined, type: undefined },
  ])
  assert.deepEqual(stops, [
    { chat: { key: '5', kind: 'direct', threadId: 17 }, draftId: 3 },
    { chat: { key: '-8', kind: 'group', threadId: 17 }, draftId: 3 },
    { chat: { key: 'undefined', kind: 'group' }, draftId: 4 },
  ])
})

for (const method of ['send', 'sendCard']) {
  test(`${method} applies the rich-unsupported rule without masking other errors`, async t => {
    const api = await fakeApi()
    api.holdPoll = true
    const warnings = []
    const handle = telegram.connect({ token: 'TOKEN' }, { ...env(api.api), log: { warn: (...args) => warnings.push(args) } }, { onStatus() {} })
    t.after(() => { handle.stop(); api.close() })
    const chat = { key: '5', threadId: 17 }
    const buttons = [{ label: 'Choose', data: 'choice' }]
    const send = () => method === 'send'
      ? handle.send(chat, { text: '**Body**', rich: true, buttons })
      : handle.sendCard(chat, { text: '**Body**', options: buttons })
    api.replies.sendRichMessage = { result: { message_id: 41 } }
    assert.deepEqual(await send(), method === 'send' ? { messageId: 41, format: 'rich' } : { messageId: 41, cardFormat: 'rich' })
    for (const [error, description] of [[404, 'Not Found'], [400, 'METHOD NOT FOUND'], [500, 'Unknown method'], [400, 'Method unknown']]) {
      api.replies.sendRichMessage = { error, description }
      api.replies.sendMessage = { result: { message_id: 42 } }
      const after = api.calls.length
      assert.deepEqual(await send(), method === 'send' ? { messageId: 42 } : { messageId: 42, cardFormat: 'text' })
      assert.deepEqual(api.calls.slice(after).filter(call => call.method !== 'getUpdates'), [
        { method: 'sendRichMessage', params: { chat_id: '5', message_thread_id: 17, rich_message: { html: method === 'send' ? '<p><b>Body</b></p>' : '<p><b>Body</b></p>\n<tg-button-row><tg-button type="callback_data" data="choice">Choose</tg-button></tg-button-row>' } } },
        { method: 'sendMessage', params: { chat_id: '5', message_thread_id: 17, text: '<b>Body</b>', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Choose', callback_data: 'choice' }]] } } },
      ])
    }
    assert.deepEqual(warnings, [])
    for (const [error, description] of [[400, "can't parse entities"], [403, 'Forbidden'], [429, 'Too Many Requests'], [500, 'Internal error'], [400, 'Unsupported rich content']]) {
      api.replies.sendRichMessage = { error, description }
      const after = api.calls.length
      await assert.rejects(send(), failure => failure.status === error && failure.message === description)
      assert.equal(api.calls.slice(after).filter(call => call.method === 'sendMessage').length, 0)
      assert.deepEqual(warnings.at(-1), [method === 'send' ? 'ds-bot: Telegram rich send failed: %s' : 'ds-bot: Telegram rich card send failed: %s', description])
    }
    assert.equal(warnings.length, 5)
  })
}

for (const method of ['send', 'edit']) {
  test(`${method} retries only parse-entities failures with the original plain text and markup`, async t => {
    const api = await fakeApi()
    api.holdPoll = true
    const handle = telegram.connect({ token: 'TOKEN' }, env(api.api), { onStatus() {} })
    t.after(() => { handle.stop(); api.close() })
    const chat = { key: '5', threadId: 17 }
    const buttons = [{ label: 'Choose', data: 'choice' }]
    const apiMethod = method === 'send' ? 'sendMessage' : 'editMessageText'
    const send = text => method === 'send' ? handle.send(chat, { text, buttons }) : handle.edit(chat, 42, { text, buttons })
    for (const { text, html, description, retry, error = 400 } of [
      { text: '**Body**', html: '<b>Body</b>', description: "Bad Request: can't parse entities", retry: true },
      { text: 'a < b', html: 'a &lt; b', description: 'PARSE ENTITIES invalid', retry: true },
      { text: 'plain', html: 'plain', description: "can't parse entities", retry: method === 'edit' },
      { text: '**Body**', html: '<b>Body</b>', description: 'Forbidden', retry: false, error: 403 },
      { text: '**Body**', html: '<b>Body</b>', description: 'parse entities', retry: true, error: 429 },
    ]) {
      api.replies[apiMethod] = params => params.parse_mode === 'HTML' ? { error, description } : { result: { message_id: 43 } }
      const after = api.calls.length
      if (retry) {
        assert.deepEqual(await send(text), method === 'send' ? { messageId: 43 } : undefined)
      } else await assert.rejects(send(text), failure => failure.status === error && failure.message === description)
      const params = { chat_id: '5', ...(method === 'send' ? { message_thread_id: 17 } : { message_id: 42 }), reply_markup: { inline_keyboard: [[{ text: 'Choose', callback_data: 'choice' }]] } }
      assert.deepEqual(api.calls.slice(after).filter(call => call.method === apiMethod).map(call => call.params), [
        { ...params, text: html, parse_mode: 'HTML' },
        ...(retry ? [{ ...params, text: text === '**Body**' ? 'Body' : text }] : []),
      ])
    }
    api.replies[apiMethod] = params => params.parse_mode === 'HTML'
      ? { error: 400, description: 'parse entities' }
      : { error: 500, description: 'Plain retry failed' }
    const after = api.calls.length
    await assert.rejects(send('**Body**'), /Plain retry failed/)
    assert.equal(api.calls.slice(after).filter(call => call.method === apiMethod).length, 2)
  })
}
