import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftStream } from '../src/host/im/drafts.js'
import { setup, telegram } from './placement-fixture.js'

// Lets settled sends run their follow-up flush; setImmediate is not mocked.
const settle = () => new Promise(resolve => setImmediate(resolve))

// A Draft stream for Bot a on one Telegram connection. `answers` scripts the
// Bot API: each call takes the next answer (a function may throw), then succeeds.
const bench = (t, { conn = telegram(), answers = [], recover = async () => false } = {}) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const { place } = setup([conn])
  const sent = []
  const drafts = draftStream({
    connOf: () => conn,
    place,
    send: async (chat, draft) => {
      sent.push({ address: [chat.key, chat.threadId], ...draft })
      const answer = answers.shift()
      if (typeof answer === 'function') return answer()
    },
    recover: chat => recover(chat),
    warn: () => {},
  })
  t.after(() => drafts.dispose())
  return { conn, place, drafts, sent }
}
const begin = (drafts, key = 'attempt-1') => drafts.start(key, { sessionId: 'a', owner: { botId: 'a' }, turn: 1, step: 1 })

test('Draft stream: a fast stream sends at most one Draft per second, carrying the latest text', async t => {
  const { drafts, sent } = bench(t)
  begin(drafts)
  drafts.text('attempt-1', 'Hel')
  drafts.text('attempt-1', 'lo')
  drafts.text('attempt-1', ' there')
  await settle()
  assert.deepEqual(sent.map(({ address, text }) => [address, text]), [[['5', 101], 'Hel']])
  t.mock.timers.tick(999)
  await settle()
  assert.equal(sent.length, 1)
  t.mock.timers.tick(1)
  await settle()
  assert.deepEqual(sent.map(({ text }) => text), ['Hel', 'Hello there'])
  assert.equal(sent[0].draftId, sent[1].draftId, 'one step keeps its Draft id')
})

test('Draft stream: a 429 pushes the next Draft past Telegram retry_after', async t => {
  const tooMany = () => { throw Object.assign(new Error('Too Many Requests'), { status: 429, retryAfter: 3 }) }
  const { drafts, sent } = bench(t, { answers: [tooMany] })
  begin(drafts)
  drafts.text('attempt-1', 'one')
  await settle()
  drafts.text('attempt-1', ' two')
  t.mock.timers.tick(2999)
  await settle()
  assert.equal(sent.length, 1)
  t.mock.timers.tick(1001)
  await settle()
  assert.deepEqual(sent.map(({ text }) => text), ['one', 'one two'])
})

test('Draft stream: Stop finds only a live Draft at its own chat and Topic', async t => {
  const { drafts, sent } = bench(t)
  begin(drafts)
  drafts.text('attempt-1', 'working')
  await settle()
  const { draftId } = sent[0]
  assert.deepEqual(drafts.find({ key: '5', threadId: 101 }, draftId)?.target, { botId: 'a' })
  assert.equal(drafts.find({ key: '5', threadId: 102 }, draftId), undefined, 'another Topic')
  assert.equal(drafts.find({ key: '6', threadId: 101 }, draftId), undefined, 'another chat')
  assert.equal(drafts.find({ key: '5', threadId: 101 }, draftId + 1), undefined, 'unknown id')
  drafts.endTarget({ botId: 'a' })
  assert.equal(drafts.find({ key: '5', threadId: 101 }, draftId), undefined, 'ended by Stop')
})

test('Draft stream: a Step message waits for the Draft in flight, and an ended step sends no more', async t => {
  let release
  const { drafts, sent } = bench(t, { answers: [() => new Promise(resolve => { release = resolve })] })
  begin(drafts)
  drafts.text('attempt-1', 'almost')
  await settle()
  const inFlight = drafts.sending(JSON.stringify(['5', 101]))
  assert.ok(inFlight instanceof Promise)
  drafts.text('attempt-1', ' done')
  drafts.endStep('a', 1, 1)
  release()
  await inFlight
  await settle()
  t.mock.timers.tick(5000)
  await settle()
  assert.deepEqual(sent.map(({ text }) => text), ['almost'], 'the pending text died with its step')
  assert.equal(drafts.sending(JSON.stringify(['5', 101])), undefined)
})

test('Draft stream: a replaced Topic carries the Draft on with the same id', async t => {
  const { conn, drafts, sent } = bench(t)
  begin(drafts)
  drafts.text('attempt-1', 'before')
  await settle()
  conn.chats[5].topics[101].replacedBy = 102
  conn.chats[5].topics[102] = { target: { botId: 'a' }, name: 'Chief' }
  drafts.moved('5', 101, 102)
  t.mock.timers.tick(1000)
  drafts.text('attempt-1', ' after')
  await settle()
  assert.deepEqual(sent.map(({ address, text }) => [address, text]), [[['5', 101], 'before'], [['5', 102], 'before after']])
  assert.equal(sent[0].draftId, sent[1].draftId)
})

test('Draft stream: a place that disappears mid-step ends its copy', async t => {
  const { conn, drafts, sent } = bench(t)
  begin(drafts)
  drafts.text('attempt-1', 'visible')
  await settle()
  conn.paired[0].access = { botIds: [], roomIds: [] }
  t.mock.timers.tick(1000)
  drafts.text('attempt-1', ' hidden')
  await settle()
  t.mock.timers.tick(5000)
  await settle()
  assert.deepEqual(sent.map(({ text }) => text), ['visible'])
})

test('Draft stream: a missing Topic is restored once and the same Draft is sent there', async t => {
  const topicMissing = () => { throw Object.assign(new Error('Bad Request: message thread not found'), { status: 400, topicMissing: true }) }
  let streams
  const recover = async chat => {
    conn.chats[5].topics[101].replacedBy = 102
    conn.chats[5].topics[102] = { target: { botId: 'a' }, name: 'Chief' }
    chat.threadId = 102
    streams.moved('5', 101, 102)
    return true
  }
  const conn = telegram()
  const b = bench(t, { conn, answers: [topicMissing], recover })
  streams = b.drafts
  begin(b.drafts)
  b.drafts.text('attempt-1', 'lost')
  await settle()
  await settle()
  assert.deepEqual(b.sent.map(({ address, text }) => [address, text]), [[['5', 101], 'lost'], [['5', 102], 'lost']])
})
