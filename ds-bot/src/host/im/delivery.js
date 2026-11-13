// Delivery owns queued Bridge sends for one runner, including their Placement
// snapshots. Drafts, Panels and Card edits keep their own scheduling.
import { imPlatform } from '../../shared/im-platforms.js'
import { addressKey } from './topics.js'
import { classify, recoverMissingTopic } from './errors.js'

const RETRY_MS = 5_000

export function delivery({ connection, placement, sending = () => undefined, recoverTopic, setStatus, warn }) {
  const queues = new Map()
  const inFlight = new Set()
  let handle
  let closed = false
  const expired = job => job.content.receiverUserId !== undefined && Date.now() >= job.content.privateUntil
  const finish = (queue, job, receipt) => {
    if (queue.jobs[0] === job) queue.jobs.shift()
    job.resolve(receipt)
  }
  // Close waits only for wire attempts and their receipts, never uncancellable
  // Draft waits or Topic recovery. Register before calling into the adapter.
  const send = async (conn, job) => {
    let done
    const pending = new Promise(resolve => { done = resolve })
    inFlight.add(pending)
    job.onWire = true
    try {
      const content = { ...job.content }
      if (content.rich !== true || imPlatform(conn.platform)?.richMessages !== true) delete content.rich
      const receipt = content.receiverUserId !== undefined && imPlatform(conn.platform)?.privateCards === true
        ? await handle.sendPrivateCard(job.chat, content.receiverUserId, content.card)
        : content.card !== undefined && imPlatform(conn.platform)?.richCards === true
          ? await handle.sendCard(job.chat, content.card)
          : await handle.send(job.chat, content)
      // A successful wire attempt is final, even if saving its receipt fails.
      try { await job.sent?.(receipt, { ...job.chat }) }
      catch (error) { warn('ds-bot: im delivery receipt failed: %s', error) }
      return receipt
    } finally {
      job.onWire = false
      inFlight.delete(pending)
      done()
    }
  }
  const drain = async (key, queue) => {
    if (closed || handle === undefined || queue.busy || queue.retry !== undefined) return
    queue.busy = true
    try {
      while (!closed && queue.jobs.length > 0) {
        const job = queue.jobs[0]
        if (expired(job)) {
          finish(queue, job)
          continue
        }
        try {
          const draft = sending(key)
          if (draft !== undefined) await draft
          if (closed) return
          const conn = connection()
          if (conn === undefined || expired(job)) {
            finish(queue, job)
            continue
          }
          placement.follow(conn, job.chat)
          if (!placement.deliverable(conn, job.chat, job.place)) {
            finish(queue, job)
            continue
          }
          const receipt = await send(conn, job)
          finish(queue, job, receipt)
        } catch (caught) {
          if (closed) {
            job.resolve()
            return
          }
          let error = caught
          if (imPlatform(connection()?.platform)?.topics === true && !job.topicRecovered && error?.topicMissing === true) {
            job.topicRecovered = true
            try {
              const recovered = await recoverMissingTopic(error, job.chat, recoverTopic)
              if (closed) return
              if (recovered) continue
            } catch (recoveryError) { error = recoveryError }
          }
          if (closed) return
          const { kind, retryAfterMs } = classify(error, { topicRecovery: false })
          if (kind === 'retry') {
            queue.retry = setTimeout(() => {
              queue.retry = undefined
              void drain(key, queue)
            }, retryAfterMs > 0 ? retryAfterMs : RETRY_MS)
            queue.retry.unref?.()
            return
          }
          finish(queue, job)
          if (kind === 'permanent') setStatus({ state: 'error', error: String(error?.message ?? error).slice(0, 300) })
        }
      }
    } finally {
      queue.busy = false
      if (queue.jobs.length === 0) queues.delete(key)
    }
  }
  const enqueue = (place, content, { sent } = {}) => {
    if (closed) return Promise.resolve()
    const key = addressKey(place.chat)
    let queue = queues.get(key)
    if (queue === undefined) queues.set(key, queue = { jobs: [], busy: false })
    return new Promise(resolve => {
      queue.jobs.push({ place, chat: { ...place.chat }, content: { ...content }, sent, resolve })
      void drain(key, queue)
    })
  }
  return {
    /** A complete Placement place; target-only places are bound snapshots. */
    output(place, content, options) {
      const target = place?.target
      if (typeof place?.chat?.key !== 'string' || target === null || typeof target !== 'object'
        || !((typeof target.botId === 'string' && target.botId !== '' && target.roomId === undefined)
          || (typeof target.roomId === 'string' && target.roomId !== '' && target.botId === undefined))) {
        throw new TypeError('Delivery output requires a Placement place with a target')
      }
      return enqueue(structuredClone(place), content, options)
    },
    /** Bridge notices and control Cards deliberately have no Bot binding. */
    notice: (chat, content, options) => enqueue({ chat }, content, options),
    attach(next) {
      if (closed) return
      handle = next
      for (const [key, queue] of queues) void drain(key, queue)
    },
    close() {
      closed = true
      for (const queue of queues.values()) {
        clearTimeout(queue.retry)
        for (const job of queue.jobs) if (!job.onWire) job.resolve()
        queue.jobs = []
      }
      queues.clear()
      return Promise.all(inFlight)
    },
  }
}
