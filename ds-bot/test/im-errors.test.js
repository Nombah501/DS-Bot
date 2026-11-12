import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify, platformError, recoverMissingTopic } from '../src/host/im/errors.js'

const cases = [
  ['absent', undefined, { kind: 'retry' }],
  ['null', null, { kind: 'retry' }],
  ['plain exception', new Error('network'), { kind: 'retry' }],
  ['404', { status: 404 }, { kind: 'permanent' }],
  ['400', { status: 400 }, { kind: 'permanent' }],
  ['499', { status: 499 }, { kind: 'permanent' }],
  ['string status', { status: '404' }, { kind: 'retry' }],
  ['429', { status: 429 }, { kind: 'retry' }],
  ['429 explicitly permanent', { status: 429, permanent: true }, { kind: 'permanent' }],
  ['429 explicitly retryable', { status: 429, permanent: false }, { kind: 'retry' }],
  ['500', { status: 500 }, { kind: 'retry' }],
  ['503', { status: 503 }, { kind: 'retry' }],
  ['explicit permanent', { permanent: true }, { kind: 'permanent' }],
  ['truthy permanent is not true', { permanent: 1 }, { kind: 'retry' }],
  ['unknown delivery', { unknown: true }, { kind: 'drop' }],
  ['stopped', { stopped: true }, { kind: 'drop' }],
  ['permanent precedes unknown', { status: 404, unknown: true }, { kind: 'permanent' }],
  ['permanent precedes stopped', { permanent: true, stopped: true }, { kind: 'permanent' }],
  ['Topic precedes permanent', { status: 400, permanent: true, topicMissing: true }, { kind: 'topicMissing' }],
  ['Topic without status', { topicMissing: true }, { kind: 'topicMissing' }],
  ['truthy Topic is not true', { topicMissing: 1 }, { kind: 'retry' }],
  ['numeric seconds', { status: 429, retryAfter: 1.5 }, { kind: 'retry', retryAfterMs: 1500 }],
  ['string seconds', { retryAfter: '3' }, { kind: 'retry', retryAfterMs: 3000 }],
  ['zero seconds', { retryAfter: 0 }, { kind: 'retry', retryAfterMs: 0 }],
  ['negative seconds', { retryAfter: -1 }, { kind: 'retry', retryAfterMs: -1000 }],
  ['invalid seconds', { retryAfter: 'bad' }, { kind: 'retry', retryAfterMs: NaN }],
  ['null seconds', { retryAfter: null }, { kind: 'retry', retryAfterMs: 0 }],
  ['permanent with seconds', { permanent: true, retryAfter: '2' }, { kind: 'permanent', retryAfterMs: 2000 }],
]

for (const [name, error, expected] of cases) {
  test(`platform error classification: ${name}`, () => assert.deepEqual(classify(error), expected))
}

test('an unrecovered Topic keeps the original failure policy', () => {
  assert.deepEqual(classify({ status: 400, topicMissing: true }, { topicRecovery: false }), { kind: 'permanent' })
  assert.deepEqual(classify({ topicMissing: true, unknown: true }, { topicRecovery: false }), { kind: 'drop' })
  assert.deepEqual(classify({ topicMissing: true }, { topicRecovery: false }), { kind: 'retry' })
})

test('platformError names the contract without losing adapter fields', () => {
  const error = platformError('limited', { status: 429, retryAfter: '2', permanent: false })
  assert.ok(error instanceof Error)
  assert.equal(error.message, 'limited')
  assert.equal(error.kind, 'retry')
  assert.equal(error.status, 429)
  assert.equal(error.retryAfter, '2')
  assert.equal(error.permanent, false)
})

test('Topic recovery only invokes the injected hook for a missing Topic', async () => {
  const chat = { key: '5', threadId: 101 }
  let calls = 0
  const recover = async address => { assert.equal(address, chat); calls += 1; return true }
  assert.equal(await recoverMissingTopic({ status: 400 }, chat, recover), false)
  assert.equal(calls, 0)
  assert.equal(await recoverMissingTopic({ topicMissing: true }, chat, recover), true)
  assert.equal(calls, 1)
  assert.equal(await recoverMissingTopic({ topicMissing: true }, chat, async () => false), false)
  const refused = new Error('restoration refused')
  await assert.rejects(recoverMissingTopic({ topicMissing: true }, chat, async () => { throw refused }), error => error === refused)
})
