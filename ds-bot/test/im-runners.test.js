import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectionRunners } from '../src/host/im/runners.js'

const settle = () => new Promise(setImmediate)
const chat = { key: 'dm', kind: 'direct', title: 'Ann' }
const bench = (t, { capabilities = {}, connecting, records = [] } = {}) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 })
  const conn = { id: 'c1', platform: 'fake', enabled: true, chats: { dm: { kind: 'direct' } } }
  const connections = { c1: conn }
  const calls = []
  const events = []
  const callbacks = []
  const handles = []
  const rt = {
    state: { bots: { a: {}, idle: {} }, rooms: { r: {}, quiet: {} }, questions: {} },
    live: new Map([['session-a', { turn: 1 }]]),
    chatOf: id => `session-${id}`,
    roomWorkView: () => ({ r: [{}] }),
    botOf: id => ({ id, name: 'Chief' }), roomOf: id => ({ id, name: 'Ops' }),
    approvalsView: () => [], save: async () => { calls.push('save') },
    redactSecrets: text => text.replaceAll('TOKEN', '[redacted]'), warn: (...args) => calls.push(args),
  }
  const place = {
    places: (current, owner, sessionId, kind) => {
      calls.push(['places', current, owner, sessionId, kind])
      return [{ chatKey: 'dm', chat, target: owner }]
    },
    deliverable: current => current !== undefined,
    follow: () => {},
  }
  const runners = connectionRunners(rt, {
    connections: () => connections, platformOf: () => capabilities,
    wants: current => current.enabled !== false,
    connect: async (current, handlers) => {
      callbacks.push(handlers)
      if (connecting !== undefined) await connecting()
      const handle = {
        send: async (_chat, content) => { calls.push(['send', content.text]); return { messageId: 7 } },
        draft: async (_chat, draft) => { calls.push(['draft', draft.text]) },
        typing: async address => { calls.push(['typing', address]) },
        sendStatusPanel: async () => { calls.push('panel'); return { messageId: 8 } },
        editStatusPanel: async () => { calls.push('panel-edit') },
        stop: () => { calls.push('stop') },
      }
      handles.push(handle)
      return handle
    },
    place, steps: new Map(), textForChat: current => key => `${current.language ?? 'en'}:${key}`,
    store: { of: async () => ({ panels: records }), save: () => calls.push('panels-save') },
    ensurePrivateTopics: async current => calls.push(['topics', current]),
    recoverTopic: async () => false,
    expirePrivate: async current => calls.push(['private', current]),
    syncCards: async () => calls.push('cards'), migrate: async () => calls.push('migrate'),
    message: async (current, event) => events.push(['message', current, event]),
    action: async (current, event) => events.push(['action', current, event]),
    stop: async (current, event) => events.push(['stop', current, event]),
    widgetQuery: async (current, event) => events.push(['widgetQuery', current, event]),
  })
  t.after(() => runners.teardown())
  return { runners, conn, connections, calls, events, callbacks, handles, rt, place }
}

test('Connection runners: concurrent syncs reserve one slot and Delivery drains after connect', async t => {
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const b = bench(t, { connecting: () => { entered.resolve(); return gate.promise } })
  const first = b.runners.sync()
  await entered.promise
  const runner = b.runners.get('c1')
  assert.ok(runner.delivery)
  assert.equal(runner.handle, undefined)
  const sent = runner.delivery.notice(chat, { text: 'queued' })
  const second = b.runners.sync()
  gate.resolve()
  await Promise.all([first, second, sent])
  assert.equal(b.handles.length, 1)
  assert.deepEqual(b.calls.filter(call => call[0] === 'send'), [['send', 'queued']])
  assert.deepEqual([...b.runners.running()], [{ conn: b.conn, runner }])
})

test('Connection runners: stopping during connect stops the late handle and leaves no runner', async t => {
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const b = bench(t, { connecting: () => { entered.resolve(); return gate.promise } })
  const syncing = b.runners.sync()
  await entered.promise
  await b.runners.stop('c1')
  gate.resolve()
  await syncing
  assert.equal(b.runners.get('c1'), undefined)
  assert.deepEqual(b.calls.filter(call => call === 'stop'), ['stop'])
})

test('Connection runners: callbacks and account changes use adopted records and ignore removed connections', async t => {
  const b = bench(t, { capabilities: { topics: true } })
  await b.runners.sync()
  const replacement = structuredClone(b.conn)
  b.connections.c1 = replacement
  const handlers = b.callbacks[0]
  for (const name of ['Message', 'Action', 'Stop', 'WidgetQuery']) await handlers[`on${name}`]({ name })
  handlers.onStatus({ state: 'ready', account: { id: 'bot', name: 'Bot', hasTopicsEnabled: true } })
  await settle()
  assert.equal(b.events.length, 4)
  assert.ok(b.events.every(([, current]) => current === replacement))
  assert.equal(b.conn.account, undefined)
  assert.deepEqual(replacement.account, { id: 'bot', name: 'Bot', hasTopicsEnabled: true })
  const before = b.calls.length
  const status = b.runners.statusView()
  delete b.connections.c1
  for (const name of ['Message', 'Action', 'Stop', 'WidgetQuery']) await handlers[`on${name}`]({ name })
  handlers.onStatus({ state: 'error', error: 'gone', account: { id: 'gone' } })
  await settle()
  assert.equal(b.events.length, 4)
  assert.equal(b.calls.length, before)
  assert.deepEqual(b.runners.statusView(), status)
  assert.deepEqual([...b.runners.running()], [])
})

test('Connection runners: typing uses Placement only for busy Bot and room owners and current records', async t => {
  const b = bench(t, { capabilities: { typing: true, privateCards: true } })
  await b.runners.sync()
  const replacement = { ...b.conn, language: 'ru' }
  b.connections.c1 = replacement
  t.mock.timers.tick(4000)
  await settle()
  assert.deepEqual(b.calls.filter(call => call[0] === 'places'), [
    ['places', replacement, { botId: 'a' }, 'session-a', 'typing'],
    ['places', replacement, { roomId: 'r' }, 'r', 'typing'],
  ])
  assert.deepEqual(b.calls.filter(call => call[0] === 'typing'), [['typing', chat], ['typing', chat]])
  assert.equal(b.calls.filter(call => call[0] === 'private').length, 4)
  assert.ok(b.calls.filter(call => call[0] === 'private').every(([, current]) => current === replacement))
  const before = b.calls.length
  delete b.connections.c1
  t.mock.timers.tick(4000)
  await settle()
  assert.equal(b.calls.length, before, 'removed connections must not type or expire Cards')
})

test('Connection runners: pending Drafts go quiet after removal without sync', async t => {
  const b = bench(t, { capabilities: { drafts: true } })
  await b.runners.sync()
  const drafts = b.runners.get('c1').drafts
  drafts.start('attempt', { sessionId: 'session-a', owner: { botId: 'a' }, turn: 1, step: 1 })
  drafts.text('attempt', 'first')
  await settle()
  drafts.text('attempt', ' pending')
  delete b.connections.c1
  t.mock.timers.tick(1000)
  await settle()
  assert.deepEqual(b.calls.filter(call => call[0] === 'draft'), [['draft', 'first']])
})

test('Connection runners: stop and teardown dispose all parts and timers, then sync starts nothing', async t => {
  const records = [{ chat, target: { botId: 'a' } }]
  const b = bench(t, { capabilities: { drafts: true, typing: true, privateCards: true, statusPanel: true }, records })
  for (const teardown of [false, true]) {
    await b.runners.sync()
    const runner = b.runners.get('c1')
    assert.ok(runner.panels)
    runner.drafts.start('attempt', { sessionId: 'session-a', owner: { botId: 'a' }, turn: 1, step: 1 })
    runner.drafts.text('attempt', 'first')
    await settle()
    runner.drafts.text('attempt', ' pending')
    if (teardown) await b.runners.teardown()
    else await b.runners.stop('c1')
    assert.equal(b.runners.get('c1'), undefined)
    const before = b.calls.length
    await runner.delivery.notice(chat, { text: 'closed' })
    t.mock.timers.tick(4000)
    await settle()
    assert.equal(b.calls.length, before, 'closed Delivery, Draft, panel and both runner timers must stay silent')
  }
  await b.runners.sync()
  assert.equal(b.handles.length, 2, 'sync after teardown cannot reconnect')
  assert.equal(b.calls.filter(call => call === 'stop').length, 2)
})

test('Connection runners: restart stops the old adapter and connects a new one, migration runs first, and status errors stay redacted', async t => {
  const b = bench(t)
  await b.runners.sync()
  assert.equal(b.calls[0], 'migrate')
  b.callbacks[0].onStatus({ state: 'error', error: `TOKEN${'x'.repeat(400)}` })
  assert.equal(b.runners.statusView().c1.error.startsWith('[redacted]'), true)
  await b.runners.restart('c1')
  assert.equal(b.handles.length, 2)
  assert.equal(b.calls.filter(call => call === 'stop').length, 1)
  assert.equal(b.runners.statusView().c1.state, 'connecting')
  assert.equal(typeof b.runners.statusView().c1.at, 'number')
})

test('Connection runners: a failed connect cuts errors at 300 characters before redaction and closes its slot', async t => {
  const b = bench(t, { connecting: () => { throw new Error(`TOKEN${'x'.repeat(400)}`) } })
  await b.runners.sync()
  assert.equal(b.runners.get('c1'), undefined)
  assert.deepEqual(b.runners.statusView(), { c1: { state: 'error', error: `[redacted]${'x'.repeat(295)}`, at: 1_000_000 } })
  await b.runners.stop('c1')
  assert.equal(b.runners.statusView().c1.state, 'error', 'stopping must preserve an error status')
})

test('Connection runners: stop preserves queued and Retained sends through a failed reconnect; retry replays and forget clears them', async t => {
  let failConnect = false
  const b = bench(t, { connecting: () => { if (failConnect) throw new Error('connect failed') } })
  await b.runners.sync()
  b.callbacks[0].onStatus({ state: 'ready' })
  const old = b.runners.get('c1')
  b.handles[0].send = async () => { throw Object.assign(new Error('TOKEN denied'), { permanent: true }) }
  await old.delivery.notice(chat, { text: 'Retained' })
  b.handles[0].send = async () => { throw new Error('network') }
  const queued = old.delivery.notice(chat, { text: 'Queued' })
  await settle()
  await b.runners.stop('c1')
  await queued
  failConnect = true
  await b.runners.retry('c1')
  assert.equal(b.runners.get('c1'), undefined)
  assert.match(b.runners.statusView().c1.error, /connect failed/)
  failConnect = false
  await b.runners.retry('c1')
  await settle()
  assert.deepEqual(b.calls.filter(call => Array.isArray(call) && call[0] === 'send'), [['send', 'Retained'], ['send', 'Queued']])
  b.callbacks.at(-1).onStatus({ state: 'ready' })
  assert.equal(b.runners.statusView().c1.state, 'ready')
  b.handles.at(-1).send = async () => { throw Object.assign(new Error('retained again'), { permanent: true }) }
  await b.runners.get('c1').delivery.notice(chat, { text: 'Forgotten' })
  b.runners.forget('c1')
  await b.runners.stop('c1')
  await b.runners.retry('c1')
  await settle()
  assert.equal(b.calls.some(call => Array.isArray(call) && call[0] === 'send' && call[1] === 'Forgotten'), false)
  assert.notEqual(b.runners.statusView().c1.state, 'error')
})

test('Connection runners: per-chat send status preserves other chat failures and restores the adapter state', async t => {
  const b = bench(t)
  await b.runners.sync()
  const runner = b.runners.get('c1')
  b.callbacks[0].onStatus({ state: 'ready' })
  b.handles[0].send = async address => {
    if (address.key === 'bad') throw Object.assign(new Error('TOKEN bad chat'), { permanent: true })
    return { messageId: 1 }
  }
  await runner.delivery.notice({ key: 'bad', kind: 'direct' }, { text: 'bad' })
  assert.deepEqual(b.runners.statusView().c1, { state: 'error', error: '[redacted] bad chat', at: 1_000_000 })
  await runner.delivery.notice(chat, { text: 'good' })
  assert.equal(b.runners.statusView().c1.state, 'error', 'a different chat cannot clear the failure')
  b.callbacks[0].onStatus({ state: 'error', error: 'adapter error' })
  assert.equal(b.runners.statusView().c1.error, 'adapter error')
  b.callbacks[0].onStatus({ state: 'polling' })
  b.handles[0].send = async () => ({ messageId: 2 })
  await b.runners.retry('c1')
  await settle()
  b.callbacks.at(-1).onStatus({ state: 'polling' })
  assert.equal(b.runners.statusView().c1.state, 'polling')
})

test('Connection runners: retry interrupts a retry timer without reconnecting a ready adapter', async t => {
  const b = bench(t)
  await b.runners.sync()
  b.callbacks[0].onStatus({ state: 'ready' })
  b.handles[0].send = async () => { throw new Error('retry TOKEN') }
  const sent = b.runners.get('c1').delivery.notice(chat, { text: 'waiting' })
  await settle()
  assert.equal(b.runners.statusView().c1.state, 'retrying')
  b.handles[0].send = async () => ({ messageId: 1 })
  await b.runners.retry('c1')
  await sent
  assert.equal(b.handles.length, 1)
  assert.equal(b.runners.statusView().c1.state, 'ready')
})
