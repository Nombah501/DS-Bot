import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IM_PLATFORMS, imPlatform } from '../src/shared/im-platforms.js'
import { adapters } from '../src/host/im/platforms/index.js'
import { fakeWsServer } from './fake-ws.js'

// Payload capabilities (buttons, groups, richMessages, personLanguage and
// callbackAnswer) are exercised at the message/action boundary by adapter tests.
const handleMethods = {
  edit: ['edit'],
  typing: ['typing'],
  richCards: ['sendCard', 'editCard'],
  drafts: ['draft'],
  topics: ['createTopic', 'renameTopic', 'closeTopic'],
  privateCards: ['sendPrivateCard', 'editPrivateCard', 'deletePrivateCard'],
  forumAdmin: ['isAdmin'],
  statusPanel: ['sendStatusPanel', 'editStatusPanel', 'pinStatusPanel'],
}

for (const [id, adapter] of Object.entries(adapters)) {
  test(`${id}: declared capabilities match the adapter handle and login interface`, async t => {
    const platform = imPlatform(id)
    assert.ok(platform, 'every adapter has one shared platform declaration')
    assert.equal(IM_PLATFORMS.filter(entry => entry.id === id).length, 1)
    assert.equal(typeof adapter.check, 'function')
    const socket = await fakeWsServer()
    const requests = []
    t.after(() => {
      for (const resolve of requests) resolve(new Response('{}'))
      socket.close()
    })
    const runtime = {}
    const handle = adapter.connect({}, {
      // Hold startup at its first request: this test inspects the public handle,
      // not authentication or polling. No request can reach a real platform.
      fetch: () => new Promise(resolve => requests.push(resolve)),
      config: { gateway: socket.url },
      runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
    }, { onStatus: () => {} })
    t.after(() => handle.stop())
    assert.equal(typeof handle.send, 'function')
    assert.equal(typeof handle.stop, 'function')
    for (const [capability, methods] of Object.entries(handleMethods)) {
      for (const method of methods) {
        assert.equal(typeof handle[method] === 'function', platform[capability] === true, `${id}.${method} agrees with ${capability}`)
      }
    }
    for (const method of ['loginStart', 'loginWait']) {
      assert.equal(typeof adapter[method] === 'function', platform.login === 'qr', `${id}.${method} agrees with QR login`)
    }
  })
}
