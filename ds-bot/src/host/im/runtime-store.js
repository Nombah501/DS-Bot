// Runtime files for Bridge connections; sections share one holder and write queue.
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../files.js'

const SAVE_MS = 400
const objectSection = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const newHolder = data => ({
  data: {
    runtime: objectSection(data?.runtime),
    cards: objectSection(data?.cards),
    requests: objectSection(data?.requests),
    turns: objectSection(data?.turns),
    panels: Array.isArray(data?.panels) ? data.panels : [],
  },
  timer: undefined,
  writing: Promise.resolve(),
})

export function runtimeStore(rt, { fs = fsp } = {}) {
  const dir = join(rt.home, 'im')
  const holders = new Map()
  const loads = new Map()
  const removals = new Map()
  // Connection ids never return; late callers must not reopen their runtime files.
  const removed = new Set()
  const holderOf = id => {
    if (removed.has(id)) return Promise.resolve(newHolder())
    const held = holders.get(id)
    if (held !== undefined) return Promise.resolve(held)
    if (loads.has(id)) return loads.get(id)
    const loading = (async () => {
      let data
      try { data = JSON.parse(await fs.readFile(join(dir, `${id}.json`), 'utf8')) } catch { data = undefined }
      const loaded = newHolder(removed.has(id) ? undefined : data)
      if (!removed.has(id)) holders.set(id, loaded)
      return loaded
    })().finally(() => loads.delete(id))
    loads.set(id, loading)
    return loading
  }
  const saveNow = async id => {
    const held = holders.get(id)
    if (held === undefined || removed.has(id)) return
    const run = held.writing.then(async () => {
      if (rt.readOnly() !== undefined) return
      await fs.mkdir(dir, { recursive: true })
      const temp = join(dir, `${id}.${process.pid}.tmp`)
      try {
        await fs.writeFile(temp, JSON.stringify(held.data), { encoding: 'utf8', mode: 0o600 })
        await fs.chmod(temp, 0o600)
        await replaceFile(temp, join(dir, `${id}.json`))
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {})
        throw error
      }
    })
    held.writing = run.catch(() => {})
    return run
  }
  const save = id => {
    const held = holders.get(id)
    if (held === undefined || held.timer !== undefined || removed.has(id)) return
    held.timer = setTimeout(() => {
      held.timer = undefined
      void saveNow(id).catch(error => rt.warn('ds-bot: im runtime %s not saved: %s', id, error))
    }, SAVE_MS)
    held.timer.unref?.()
  }
  return {
    of: async id => (await holderOf(id)).data,
    peek: id => removed.has(id) ? undefined : holders.get(id)?.data,
    * loaded() { for (const [id, held] of holders) if (!removed.has(id)) yield [id, held.data] },
    save, saveNow,
    runtime: async id => {
      const held = await holderOf(id)
      return { get: () => held.data.runtime, set: patch => { Object.assign(held.data.runtime, patch); save(id) } }
    },
    remove: id => {
      removed.add(id)
      if (removals.has(id)) return removals.get(id)
      clearTimeout(holders.get(id)?.timer)
      const removing = (async () => {
        // Work already using the old holder must drain before its file is deleted.
        await loads.get(id)
        const held = holders.get(id)
        clearTimeout(held?.timer)
        await held?.writing
        holders.delete(id)
        await fs.rm(join(dir, `${id}.json`), { force: true }).catch(() => {})
      })().finally(() => removals.delete(id))
      removals.set(id, removing)
      return removing
    },
    flush: async beforeWrite => {
      await Promise.all(loads.values())
      await beforeWrite()
      for (const held of holders.values()) clearTimeout(held.timer)
      await Promise.allSettled([...holders.keys()].map(saveNow))
    },
  }
}
