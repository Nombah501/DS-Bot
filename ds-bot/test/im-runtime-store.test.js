import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runtimeStore } from '../src/host/im/runtime-store.js'

const empty = () => ({ runtime: {}, cards: {}, requests: {}, turns: {}, panels: [] })
const settle = () => new Promise(setImmediate)
const bench = async (t, overrides = {}) => {
  const home = await fs.mkdtemp(join(tmpdir(), 'dsb-runtime-store-'))
  const warnings = []
  const rt = { home, readOnly: () => undefined, warn: (...args) => warnings.push(args) }
  const store = runtimeStore(rt, { fs: { ...fs, ...overrides } })
  t.after(async () => {
    await store.flush(async () => {})
    await fs.rm(home, { recursive: true, force: true })
  })
  const path = id => join(home, 'im', `${id}.json`)
  const seed = async (id, data) => {
    await fs.mkdir(join(home, 'im'), { recursive: true })
    await fs.writeFile(path(id), JSON.stringify(data))
  }
  const saved = async id => JSON.parse(await fs.readFile(path(id), 'utf8'))
  return { store, rt, warnings, path, seed, saved }
}

test('Runtime store: missing, unreadable and invalid JSON files give five empty sections', async t => {
  const b = await bench(t)
  assert.deepEqual(await b.store.of('missing'), empty())
  await fs.mkdir(b.path('unreadable'), { recursive: true })
  assert.deepEqual(await b.store.of('unreadable'), empty())
  await fs.writeFile(b.path('invalid'), '{')
  assert.deepEqual(await b.store.of('invalid'), empty())
})

test('Runtime store: concurrent first loads share one read and one live holder', async t => {
  const gate = Promise.withResolvers()
  const reading = Promise.withResolvers()
  let reads = 0
  const b = await bench(t, { readFile: async (...args) => {
    reads++
    reading.resolve()
    await gate.promise
    return fs.readFile(...args)
  } })
  t.after(() => gate.resolve())
  await b.seed('c1', { ...empty(), cards: { question: [{ messageId: 7 }] } })
  const first = b.store.of('c1')
  await reading.promise
  const second = b.store.of('c1')
  gate.resolve()
  const [a, c] = await Promise.all([first, second])
  assert.equal(reads, 1)
  assert.equal(a, c)
  assert.equal(b.store.peek('c1'), a)
  assert.deepEqual([...b.store.loaded()], [['c1', a]])
  a.runtime.cursor = 'shared'
  await b.store.saveNow('c1')
  assert.deepEqual(await b.saved('c1'), { ...empty(), runtime: { cursor: 'shared' }, cards: { question: [{ messageId: 7 }] } })
})

test('Runtime store: saves debounce at 400 ms and write once with the latest sections', async t => {
  const writing = Promise.withResolvers()
  const gate = Promise.withResolvers()
  let writes = 0
  let written
  const b = await bench(t, { writeFile: async (...args) => {
    writes++
    written = JSON.parse(args[1])
    writing.resolve()
    await gate.promise
    return fs.writeFile(...args)
  } })
  t.after(() => gate.resolve())
  const data = await b.store.of('c1')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  data.runtime.cursor = 'first'
  b.store.save('c1')
  t.mock.timers.tick(200)
  data.runtime.cursor = 'last'
  b.store.save('c1')
  b.store.save('c1')
  t.mock.timers.tick(199)
  await settle()
  assert.equal(writes, 0)
  t.mock.timers.tick(1)
  await writing.promise
  t.mock.timers.tick(800)
  await settle()
  assert.equal(writes, 1, 'several saves must produce one debounced write')
  gate.resolve()
  // Removal waits for that write, so no second save is needed to drain it.
  await b.store.remove('c1')
  assert.equal(written.runtime.cursor, 'last')
  assert.equal(writes, 1)
})

test('Runtime store: overlapping writes serialize, the last wins, and mode stays 0600', async t => {
  const writing = Promise.withResolvers()
  const gate = Promise.withResolvers()
  let active = 0
  let maximum = 0
  let writes = 0
  const b = await bench(t, { writeFile: async (...args) => {
    maximum = Math.max(maximum, ++active)
    if (++writes === 1) {
      writing.resolve()
      await gate.promise
    }
    try { return await fs.writeFile(...args) } finally { active-- }
  } })
  t.after(() => gate.resolve())
  const data = await b.store.of('c1')
  data.runtime.cursor = 'first'
  const first = b.store.saveNow('c1')
  await writing.promise
  data.runtime.cursor = 'last'
  const second = b.store.saveNow('c1')
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(maximum, 1)
  assert.equal(writes, 2)
  assert.equal((await b.saved('c1')).runtime.cursor, 'last')
  assert.equal((await fs.stat(b.path('c1'))).mode & 0o777, 0o600)
  await fs.writeFile(join(b.rt.home, 'im', `c1.${process.pid}.tmp`), 'old', { mode: 0o644 })
  await b.store.saveNow('c1')
  assert.equal((await fs.stat(b.path('c1'))).mode & 0o777, 0o600, 'chmod also secures a pre-existing temporary file')
})

test('Runtime store: a read-only host creates no directory or file, even on shutdown', async t => {
  const b = await bench(t)
  b.rt.readOnly = () => 'locked'
  const env = await b.store.runtime('c1')
  env.set({ cursor: 'local' })
  await b.store.saveNow('c1')
  await b.store.flush(async () => {})
  await assert.rejects(fs.stat(join(b.rt.home, 'im')), { code: 'ENOENT' })
})

test('Runtime store: shutdown waits for loads, applies claims, cancels timers and writes pending saves', async t => {
  const reading = Promise.withResolvers()
  const gate = Promise.withResolvers()
  let writes = 0
  const b = await bench(t, {
    readFile: async (...args) => { reading.resolve(); await gate.promise; return fs.readFile(...args) },
    writeFile: async (...args) => { writes++; return fs.writeFile(...args) },
  })
  t.after(() => gate.resolve())
  const loading = b.store.of('c1')
  await reading.promise
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let claims = false
  const flushing = b.store.flush(async () => {
    claims = true
    b.store.peek('c1').cards.answer = [{ answer: 'Weekly' }]
    b.store.save('c1')
  })
  await settle()
  assert.equal(claims, false, 'claims must wait until the first load completes')
  gate.resolve()
  await Promise.all([loading, flushing])
  assert.equal(claims, true)
  assert.deepEqual((await b.saved('c1')).cards, { answer: [{ answer: 'Weekly' }] })
  assert.equal(writes, 1)
  t.mock.timers.tick(400)
  await settle()
  assert.equal(writes, 1, 'shutdown must cancel pending debounce timers')
})

test('Runtime store: the adapter reads and patches its runtime section without replacing other sections', async t => {
  const b = await bench(t)
  await b.seed('c1', { ...empty(), runtime: { cursor: 'saved', token: 'kept' }, panels: [{ messageId: 7 }] })
  const env = await b.store.runtime('c1')
  assert.deepEqual(env.get(), { cursor: 'saved', token: 'kept' })
  env.set({ cursor: 'next' })
  await b.store.flush(async () => {})
  assert.deepEqual(await b.saved('c1'), { ...empty(), runtime: { cursor: 'next', token: 'kept' }, panels: [{ messageId: 7 }] })
})

test('Runtime store: corrupt object sections and non-array panels become empty', async t => {
  const b = await bench(t)
  await b.seed('arrays', { runtime: [], cards: [], requests: [], turns: [], panels: {} })
  assert.deepEqual(await b.store.of('arrays'), empty(), 'arrays are not plain object sections')
  await b.seed('strings', { runtime: 'bad', cards: null, requests: 'bad', turns: 7, panels: null })
  assert.deepEqual(await b.store.of('strings'), empty(), 'non-objects are not object sections')
})

test('Runtime store: removal drains writes, cancels saves and ignores the old adapter after removal', async t => {
  const writing = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const b = await bench(t, { writeFile: async (...args) => {
    writing.resolve()
    await gate.promise
    return fs.writeFile(...args)
  } })
  t.after(() => gate.resolve())
  const env = await b.store.runtime('c1')
  env.set({ cursor: 'first' })
  const saving = b.store.saveNow('c1')
  await writing.promise
  const removing = b.store.remove('c1')
  env.set({ cursor: 'late' })
  gate.resolve()
  await Promise.all([saving, removing])
  assert.equal(b.store.peek('c1'), undefined, 'removal must drop its holder')
  assert.deepEqual([...b.store.loaded()], [])
  env.set({ cursor: 'gone' })
  await b.store.saveNow('c1')
  await b.store.flush(async () => {})
  await assert.rejects(fs.stat(b.path('c1')), { code: 'ENOENT' }, 'an in-flight write must not recreate the removed file')
})

test('Runtime store: removal waits for a first load and drops its late holder before shutdown', async t => {
  const reading = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const b = await bench(t, { readFile: async (...args) => {
    reading.resolve()
    await gate.promise
    return fs.readFile(...args)
  } })
  t.after(() => gate.resolve())
  await b.seed('c1', { ...empty(), runtime: { cursor: 'old' } })
  const loading = b.store.of('c1')
  await reading.promise
  const removing = b.store.remove('c1')
  gate.resolve()
  await Promise.all([loading, removing])
  assert.equal(b.store.peek('c1'), undefined, 'a late first load must not restore the removed holder')
  assert.deepEqual([...b.store.loaded()], [])
  await b.store.flush(async () => {})
  await assert.rejects(fs.stat(b.path('c1')), { code: 'ENOENT' })
})
