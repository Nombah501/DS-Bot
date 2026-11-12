import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cardJournal, settledCard } from '../src/host/im/cards.js'
import { telegram } from './placement-fixture.js'

const forum = { key: '-60', kind: 'group', threadId: 40 }
const ann = { id: '9', languageCode: 'en' }

// A Card journal over one Telegram connection, an in-memory runtime store and a
// scripted adapter: queued jobs wait in `queue` until `deliver` sends the oldest.
const bench = ({ conn = telegram(), open = () => false, failEdits = 0, unloaded = false, loadGate, onLoad = () => {}, onSave = () => {} } = {}) => {
  const data = { cards: {} }
  let loaded = !unloaded
  const calls = []
  const queue = []
  let nextId = 700
  const handle = {
    sendCard: async () => {},
    sendPrivateCard: async () => {},
    edit: async (chat, messageId, { text }) => { calls.push(['edit', chat.key, messageId, text]) },
    editCard: async (chat, messageId, card) => {
      if (failEdits > 0) {
        failEdits--
        throw new Error('Bad Gateway')
      }
      calls.push(['editCard', chat.key, messageId, card.settled])
    },
    editPrivateCard: async (chat, copy) => { calls.push(['editPrivateCard', chat.key, copy.ephemeralMessageId]) },
    deletePrivateCard: async (chat, copy) => { calls.push(['deletePrivateCard', chat.key, copy.ephemeralMessageId]) },
  }
  const cards = cardJournal({
    store: { of: async () => { onLoad(); await loadGate; loaded = true; return data }, peek: () => loaded ? data : undefined, save: () => onSave(data) },
    connections: () => ({ [conn.id]: conn }),
    textForChat: () => key => `<${key}>`,
    textForPerson: () => key => `<${key}>`,
    handleOf: () => handle,
    enqueue: (_conn, chatKey, job) => { queue.push({ chatKey, job }) },
    paired: (_conn, id) => conn.paired.some(person => person.id === id),
    sourceOpen: () => open,
    warn: () => {},
    readOnly: () => false,
  })
  const deliver = async (sent = {}) => {
    const { job } = queue.shift()
    await job.after({ messageId: nextId++, ...sent })
    return job
  }
  return { conn, data, calls, queue, cards, deliver, reveal: () => { loaded = true } }
}
const question = { text: 'Pick one', options: [{ label: 'Red', data: 'q:1:0', style: 'success' }, { label: 'Blue', data: 'q:1:1' }] }
const sendQuestion = (b, chat = forum, initiator) => b.cards.send(b.conn, 'q:1', [{ chat, target: { botId: 'a' } }], 'Pick one', undefined, () => structuredClone(question), initiator)

test('Card journal: a Card is recorded before it is queued, and learns its message once sent', async () => {
  const b = bench()
  await sendQuestion(b)
  assert.equal(b.cards.sent('c1', 'q:1'), true, 'a dropped job must not be sent again')
  assert.equal(b.queue.length, 1)
  assert.equal(b.data.cards['q:1'][0].messageId, undefined)
  await b.deliver()
  assert.deepEqual(b.data.cards['q:1'].map(({ chatKey, threadId, messageId, target }) => ({ chatKey, threadId, messageId, target })),
    [{ chatKey: '-60', threadId: 40, messageId: 700, target: { botId: 'a' } }])
})

test('Card journal: the Settled card rule keeps only the chosen options, never Done', () => {
  const card = { options: [...question.options, { label: 'Done', data: 'm:1:done', submit: true }] }
  assert.deepEqual(settledCard(card, 'Red', ['Red', 'Done']), { answer: 'Red', options: [{ label: 'Red', style: 'success' }] })
  assert.deepEqual(settledCard(card, 'answered', []), { answer: 'answered', options: [] })
  assert.deepEqual(settledCard({ options: [{ label: 'Chief', data: 'b:x:0' }, { label: 'Scout', data: 'b:x:1' }] }, 'Bound to Chief', ['Chief']),
    { answer: 'Bound to Chief', options: [{ label: 'Chief' }] })
})

test('Card journal: settle answers every copy once and edits each the way it was sent', async () => {
  const b = bench()
  await b.cards.send(b.conn, 'q:1', [{ chat: forum, target: { botId: 'a' } }, { chat: { key: '5', kind: 'direct', threadId: 101 }, target: { botId: 'a' } }], 'Pick one')
  await b.deliver()
  await b.deliver()
  b.data.cards['q:1'][0].card = structuredClone(question)
  await b.cards.settle(b.conn, 'q:1', 'Red', ['Red'])
  await b.cards.settle(b.conn, 'q:1', 'Blue', ['Blue'])
  assert.deepEqual(b.calls, [
    ['editCard', '-60', 700, { answer: 'Red', options: [{ label: 'Red', style: 'success' }] }],
    ['edit', '5', 701, 'Pick one\n— Red'],
  ])
  assert.deepEqual(b.data.cards['q:1'].map(({ answer }) => answer), ['Red', 'Red'])
})

test('Card journal: a failed settle edit is retried by the next edit pass', async () => {
  const b = bench({ failEdits: 1 })
  await sendQuestion(b)
  await b.deliver()
  await b.cards.settle(b.conn, 'q:1', 'Red', ['Red'])
  assert.deepEqual(b.calls, [])
  await b.cards.edits(b.conn)
  assert.deepEqual(b.calls.map(([kind, , messageId]) => [kind, messageId]), [['editCard', 700]])
})

test('Card journal: an answer press finds its own open copy; a bare number finds the newest answerable one', async () => {
  const b = bench()
  await sendQuestion(b)
  await b.cards.send(b.conn, 'a:2', [{ chat: forum, target: { botId: 'a' } }], 'Allow?')
  await b.cards.send(b.conn, 's:3', [{ chat: forum, target: { botId: 'a' } }], 'Secret?')
  await b.deliver()
  assert.equal(b.cards.open(b.conn, forum, 'q:1')?.entry.messageId, 700)
  assert.equal(b.cards.open(b.conn, { ...forum, threadId: 41 }, 'q:1'), undefined, 'another Topic')
  assert.equal(b.cards.open(b.conn, forum, 'q:9'), undefined, 'unknown Card')
  assert.equal(b.cards.byMessage(b.conn, forum, 'q:1', 700)?.chatKey, '-60')
  assert.equal(b.cards.byMessage(b.conn, forum, 'q:1', 701), undefined)
  const answerable = cardKey => cardKey.startsWith('q:') || cardKey.startsWith('a:')
  assert.equal(b.cards.newest(b.conn, forum, answerable)?.cardKey, 'a:2')
  await b.cards.settle(b.conn, 'a:2', 'allow')
  assert.equal(b.cards.newest(b.conn, forum, answerable)?.cardKey, 'q:1')
  assert.equal(b.cards.open(b.conn, forum, 'a:2'), undefined, 'answered')
})

test('Card journal: a group Card from a paired person goes to them alone and matches only their press', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const b = bench()
  await sendQuestion(b, forum, { sender: ann })
  const [copy] = b.data.cards['q:1']
  assert.deepEqual([copy.receiverUserId, copy.privateUntil], ['9', 1_000_000 + 5 * 60 * 1000])
  await b.deliver({ messageId: undefined, ephemeralMessageId: 'e1', ephemeralMessageIds: ['e1'] })
  assert.equal(b.cards.open(b.conn, forum, 'q:1', { ephemeralMessageId: 'e1', receiverUserId: '9' })?.entry, copy)
  assert.equal(b.cards.open(b.conn, forum, 'q:1', { ephemeralMessageId: 'e2', receiverUserId: '9' }), undefined)
  await b.cards.settle(b.conn, 'q:1', 'Red', ['Red'])
  assert.deepEqual(b.calls, [['editPrivateCard', '-60', 'e1']])
})

test('Card journal: an unanswered Private card past its time gets a public copy, then is deleted', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const b = bench()
  await sendQuestion(b, forum, { sender: ann })
  await b.deliver({ messageId: undefined, ephemeralMessageId: 'e1' })
  await b.cards.expirePrivate(b.conn)
  assert.equal(b.queue.length, 0, 'still private')
  t.mock.timers.tick(5 * 60 * 1000)
  await b.cards.expirePrivate(b.conn)
  await b.cards.expirePrivate(b.conn)
  assert.equal(b.queue.length, 1, 'the public copy is queued once')
  assert.deepEqual(b.queue[0].job.card.options, question.options)
  await b.deliver()
  await b.cards.expirePrivate(b.conn)
  assert.deepEqual(b.calls, [['deletePrivateCard', '-60', 'e1']])
  assert.deepEqual(b.data.cards['q:1'].map(({ receiverUserId, messageId, deleted }) => [receiverUserId, messageId, deleted]), [['9', undefined, true], [undefined, 701, undefined]])
  assert.equal(b.cards.open(b.conn, forum, 'q:1')?.entry.messageId, 701)
})

test('Card journal: a Card whose source is gone settles as answered, is edited, then dropped', async () => {
  const live = new Set(['q:2'])
  const b = bench({ open: cardKey => live.has(cardKey) })
  await sendQuestion(b)
  await b.cards.send(b.conn, 'q:2', [{ chat: forum, target: { botId: 'a' } }], 'Other')
  await b.deliver()
  await b.deliver()
  await b.cards.settleGone()
  assert.deepEqual(b.calls, [['editCard', '-60', 700, { answer: '<answered>', options: [] }]])
  assert.deepEqual(Object.keys(b.data.cards), ['q:2'])
  assert.equal(b.data.cards['q:2'][0].answer, undefined)
})

test('Card journal: a restored Topic takes only the copies not yet sent', async () => {
  const b = bench()
  await sendQuestion(b)
  await b.deliver()
  await b.cards.send(b.conn, 'a:2', [{ chat: forum, target: { botId: 'a' } }], 'Allow?')
  await b.cards.moved('c1', '-60', 40, 41)
  assert.deepEqual([b.data.cards['q:1'][0].threadId, b.data.cards['a:2'][0].threadId], [40, 41])
})

test('Card journal: an unloaded connection keeps the selected answer before reconciliation', async () => {
  const gate = Promise.withResolvers()
  const b = bench({ unloaded: true, loadGate: gate.promise })
  b.data.cards['q:1'] = [{ chatKey: '-60', threadId: 40, messageId: 700, text: question.text, card: structuredClone(question) }]
  b.cards.claim(b.conn, 'q:1', 'Red', ['Red'])
  const loading = b.cards.load(b.conn.id)
  gate.resolve()
  await loading
  await b.cards.settleGone()
  assert.deepEqual(b.calls, [['editCard', '-60', 700, { answer: 'Red', options: [{ label: 'Red', style: 'success' }] }]])
})

test('Card journal: reconciliation applies a pending localized approval before reading externally loaded records', async () => {
  const b = bench({ unloaded: true })
  b.data.cards['a:1'] = [{ chatKey: '-60', threadId: 40, messageId: 700, card: { text: 'Allow?', options: [{ label: '<allow>', style: 'success' }] } }]
  b.cards.claim(b.conn, 'a:1', text => text('allow'))
  b.cards.claim(b.conn, 'a:1', text => text('reject'))
  b.reveal()
  await b.cards.settleGone()
  assert.deepEqual(b.calls, [['editCard', '-60', 700, { answer: '<allow>', options: [{ label: '<allow>', style: 'success' }] }]])
})

test('Card journal: a failed delivery removes its pending claim before the records load', async () => {
  const b = bench({ unloaded: true, open: () => true })
  b.data.cards['q:1'] = [{ chatKey: '-60', threadId: 40, messageId: 700, card: structuredClone(question) }]
  const rollback = b.cards.claim(b.conn, 'q:1', 'Red', ['Red'])
  assert.equal(typeof rollback, 'function')
  await rollback()
  await b.cards.load(b.conn.id)
  assert.equal(b.cards.open(b.conn, forum, 'q:1')?.entry.answer, undefined)
  assert.deepEqual(b.calls, [])
  await b.cards.settle(b.conn, 'q:1', 'Blue', ['Blue'])
  assert.deepEqual(b.calls, [['editCard', '-60', 700, { answer: 'Blue', options: [{ label: 'Blue' }] }]])
})

test('Card journal: a failed pending delivery can reopen its copies after the records load', async () => {
  const b = bench({ unloaded: true, open: () => true })
  b.data.cards['q:1'] = [{ chatKey: '-60', threadId: 40, messageId: 700, card: structuredClone(question) }]
  const rollback = b.cards.claim(b.conn, 'q:1', 'Red', ['Red'])
  await b.cards.load(b.conn.id)
  assert.equal(b.data.cards['q:1'][0].answer, 'Red')
  await rollback()
  assert.equal(b.cards.open(b.conn, forum, 'q:1')?.entry.card.settled, undefined)
  assert.equal(b.calls.at(-1)[3], undefined)
})

test('Card journal: an unloaded claim loads and saves its selected answer without another journal read', async () => {
  const gate = Promise.withResolvers()
  const saved = []
  const b = bench({ unloaded: true, loadGate: gate.promise, onSave: data => saved.push(structuredClone(data)) })
  b.data.cards['q:1'] = [{ chatKey: '-60', threadId: 40, messageId: 700, card: structuredClone(question) }]
  b.cards.claim(b.conn, 'q:1', 'Red', ['Red'])
  gate.resolve()
  await new Promise(setImmediate)
  assert.equal(saved.length, 1, 'a pending claim must persist without a later journal read')
  assert.deepEqual(saved[0].cards['q:1'][0].card.settled, { answer: 'Red', options: [{ label: 'Red', style: 'success' }] })
})

test('Card journal: loading an empty journal clears a claim with no matching Card', async () => {
  let loads = 0
  const b = bench({ unloaded: true, onLoad: () => { loads++ } })
  b.cards.claim(b.conn, 'q:1', 'Red', ['Red'])
  await new Promise(setImmediate)
  assert.equal(loads, 1, 'even a missing Card must drain its pending claim')
  b.data.cards['q:1'] = [{ chatKey: '-60', threadId: 40, messageId: 700, card: structuredClone(question) }]
  b.cards.claim(b.conn, 'q:1', 'Blue', ['Blue'])
  assert.equal(b.data.cards['q:1'][0].answer, 'Blue', 'a drained claim cannot answer a later Card')
})
