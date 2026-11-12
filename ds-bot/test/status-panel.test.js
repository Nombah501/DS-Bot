import assert from 'node:assert/strict'
import { test } from 'node:test'
import { showStatus, statusPanels } from '../src/host/im/status-panel.js'
import { translate } from '../src/host/im/locale.js'

const setup = () => {
  const rt = {
    chatOf: id => id,
    botOf: () => ({ name: 'Chief' }),
    roomOf: () => ({ name: 'Ops', sessions: { a: 'ar1', b: 'br1' } }),
    live: new Map(),
    state: {},
    approvalsView: () => [],
  }
  const sent = []
  const options = {
    chat: { key: '-20', kind: 'group', threadId: 101 },
    target: { botId: 'a' },
    text: key => translate('en', key),
    steps: new Map(),
    richCards: true,
    sendText: body => sent.push({ text: body }),
    sendCard: (...args) => sent.push({ card: args }),
  }
  return { rt, sent, options }
}

test('Status view: an idle group gets the exact multi-line text without Stop', async () => {
  const { rt, sent, options } = setup()
  await showStatus(rt, options)
  assert.deepEqual(sent, [{ text: 'Chief — Idle\nTool: —\nStep: 0\nTurn elapsed: 0 s' }])
})

test('Status view: active groups get a Card with the same text and a fresh Stop key', async t => {
  const { rt, sent, options } = setup()
  t.mock.method(Date, 'now', () => 123456)
  rt.live.set('a', { turn: 1, since: 58000, tool: 'read_file' })
  options.steps.set('a', 4)
  await showStatus(rt, options)
  await showStatus(rt, options)
  const [key, places, body, output, content] = sent[0].card
  assert.match(key, /^t:[0-9a-f-]{36}$/)
  assert.notEqual(sent[1].card[0], key)
  assert.deepEqual(places, [{ chat: options.chat, target: options.target }])
  assert.equal(body, 'Chief — Working\nTool: read_file\nStep: 4\nTurn elapsed: 65 s')
  assert.equal(output, undefined)
  assert.deepEqual(content(), { text: body, options: [{ data: `${key}:stop`, label: 'Stop' }] })
})

test('Status view: private chats prefer their Status panel over a Card', async () => {
  const { rt, sent, options } = setup()
  options.chat.kind = 'direct'
  rt.live.set('a', { turn: 1 })
  options.panels = { show: (...args) => sent.push({ panel: args }) }
  await showStatus(rt, options)
  assert.deepEqual(sent, [{ panel: [options.chat, options.target, options.text] }])
})

for (const variant of ['private without panels', 'group without rich Cards', 'group without Card sending']) {
  test(`Status view: ${variant} falls back to text even while working`, async t => {
    const { rt, sent, options } = setup()
    t.mock.method(Date, 'now', () => 1000)
    rt.live.set('a', { turn: 1, since: 2000 })
    if (variant === 'private without panels') options.chat.kind = 'direct'
    if (variant === 'group without rich Cards') options.richCards = false
    if (variant === 'group without Card sending') options.sendCard = undefined
    options.panels = { show: () => assert.fail('Group status cannot use a Status panel') }
    if (options.chat.kind === 'direct') options.panels = undefined
    await showStatus(rt, options)
    assert.deepEqual(sent, [{ text: 'Chief — Working\nTool: —\nStep: 0\nTurn elapsed: 0 s' }])
  })
}

test('Status view: a waiting room uses localized text, its earliest turn and highest step', async t => {
  const { rt, sent, options } = setup()
  t.mock.method(Date, 'now', () => 123456)
  options.target = { roomId: 'r1' }
  options.text = key => translate('ru', key)
  rt.live.set('ar1', { turn: 1, since: 60000 })
  rt.live.set('br1', { turn: 2, since: 58000, tool: 'search' })
  rt.state.questions = { ar1: {} }
  options.steps.set('ar1', 2)
  options.steps.set('br1', 7)
  await showStatus(rt, options)
  const [, , body, , content] = sent[0].card
  assert.equal(body, 'Ops — Ждёт ответа на карточку\nИнструмент: search\nШаг: 7\nВремя хода: 65 s')
  assert.equal(content().options[0].label, 'Остановить')
})

test('Status panel: computes its own snapshot, saves before pinning and rejects removed targets', async t => {
  const { rt, options } = setup()
  const records = []
  const calls = []
  const handle = {
    sendStatusPanel: async (chat, content) => { calls.push({ chat, content }); return { messageId: 42 } },
    editStatusPanel: async () => assert.fail('Unchanged data needs no edit'),
    pinStatusPanel: async (chat, messageId) => {
      assert.equal(records[0].messageId, messageId)
      calls.push('pin')
    },
  }
  const panels = statusPanels(handle, {
    rt, steps: options.steps, records,
    textForChat: () => options.text,
    deliverable: () => true,
    save: () => calls.push('save'),
    recover: async () => false,
    warn: error => assert.fail(String(error)),
  })
  t.after(() => panels.stop())
  const chat = { key: '5', kind: 'direct', threadId: 102 }
  await panels.show(chat, options.target, options.text)
  assert.deepEqual(JSON.parse(calls[0].content.data), {
    name: 'Chief', state: 'Idle', tool: '', step: 0, since: null, active: false,
  })
  assert.equal(calls[0].content.caption, 'Status panel: Chief — Idle')
  assert.match(calls[0].content.html, /Math\.floor\(seconds\/60\)\+':'.*padStart\(2,'0'\)/)
  assert.deepEqual(calls.slice(1), ['save', 'pin'])
  assert.equal(panels.find('5', 42), records[0])
  await panels.show(chat, options.target, options.text)
  assert.equal(calls.length, 3)
  rt.botOf = () => undefined
  assert.equal(panels.find('5', 42), undefined)
})

test('Status panel: refreshes saved panels from current runtime data and chat language', async t => {
  const { rt, options } = setup()
  const chat = { key: '5', kind: 'direct' }
  const record = { chat, target: options.target, messageId: 42, data: '{}' }
  const calls = []
  rt.live.set('a', { turn: 1, since: 58000, tool: 'read_file' })
  options.steps.set('a', 4)
  const panels = statusPanels({
    sendStatusPanel: async () => assert.fail('A saved panel must not be duplicated'),
    editStatusPanel: async (...args) => calls.push(args),
  }, {
    rt, steps: options.steps, records: [record],
    textForChat: address => {
      assert.equal(address, chat)
      return key => translate('ru', key)
    },
    deliverable: () => true,
    save: () => calls.push('save'),
    recover: async () => false,
    warn: error => assert.fail(String(error)),
  })
  t.after(() => panels.stop())
  await panels.show(chat, options.target, options.text)
  assert.deepEqual(calls, [[chat, 42, JSON.stringify({
    name: 'Chief', state: 'Работает', tool: 'read_file', step: 4, since: 58000, active: true,
  })], 'save'])
  assert.equal(record.data, calls[0][2])
})

test('Status panel: recreates a missing panel with chat-localized text and recovers its Topic before saving', async t => {
  const { rt, options } = setup()
  const record = { chat: { key: '5', kind: 'direct', threadId: 101 }, target: options.target }
  const calls = []
  let attempts = 0
  const panels = statusPanels({
    sendStatusPanel: async (chat, content) => {
      calls.push(['send', chat.threadId, content.caption])
      if (++attempts === 1) throw Object.assign(new Error('Topic missing'), { topicMissing: true })
      return { messageId: 43 }
    },
    pinStatusPanel: async () => calls.push('pin'),
  }, {
    rt, steps: options.steps, records: [record],
    textForChat: () => key => translate('ru', key),
    deliverable: () => true,
    save: () => calls.push('save'),
    recover: async chat => { chat.threadId = 102; calls.push('recover'); return true },
    warn: error => assert.fail(String(error)),
  })
  t.after(() => panels.stop())
  await panels.show(record.chat, options.target, options.text)
  assert.deepEqual(calls, [
    ['send', 101, 'Панель состояния: Chief — Свободен'],
    'recover',
    ['send', 102, 'Панель состояния: Chief — Свободен'],
    'save', 'pin',
  ])
  assert.equal(record.messageId, 43)
})
