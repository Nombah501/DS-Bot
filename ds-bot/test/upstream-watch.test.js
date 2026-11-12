import assert from 'node:assert/strict'
import { test } from 'node:test'
import watchUpstream from '../../scripts/upstream-watch.cjs'

function fixture() {
  const issues = []
  const calls = []
  const github = {
    rest: {
      repos: {
        getLatestRelease: async args => {
          assert.deepEqual(args, { owner: 'Fei2411', repo: 'DS-Bot' })
          return { data: { tag_name: 'v0.3.5', html_url: 'https://github.com/Fei2411/DS-Bot/releases/tag/v0.3.5', draft: false, prerelease: false } }
        },
      },
      issues: {
        listForRepo: Symbol('listForRepo'),
        create: async args => {
          calls.push(args)
          const issue = { ...args, number: issues.length + 1, html_url: 'https://github.com/Nombah501/DS-Bot/issues/1', state: 'open' }
          issues.push(issue)
          return { data: issue }
        },
      },
    },
    paginate: async (method, args) => {
      assert.equal(method, github.rest.issues.listForRepo)
      assert.deepEqual(args, { owner: 'Nombah501', repo: 'DS-Bot', state: 'all', per_page: 100 })
      return issues
    },
  }
  const context = { repo: { owner: 'Nombah501', repo: 'DS-Bot' } }
  const core = { info() {} }
  const run = marker => watchUpstream({ github, context, core, marker })
  return { issues, calls, github, context, run }
}

const sha = '405ee8bbf5c6cbe805340c1dc69186863bfb5939'

test('current upstream release creates no sync issue', async () => {
  const { run, calls } = fixture()
  await run(`v0.3.5 ${sha}\n`)
  assert.equal(calls.length, 0)
})

test('a stale marker creates one fork issue with release notes and tag comparison', async () => {
  const { run, calls, issues } = fixture()
  await run(`v0.3.4 ${sha}\n`)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].owner, 'Nombah501')
  assert.equal(calls[0].repo, 'DS-Bot')
  assert.equal(calls[0].title, 'Sync with upstream v0.3.5')
  assert.match(calls[0].body, /https:\/\/github.com\/Fei2411\/DS-Bot\/releases\/tag\/v0\.3\.5/u)
  assert.match(calls[0].body, /https:\/\/github.com\/Fei2411\/DS-Bot\/compare\/v0\.3\.4\.\.\.v0\.3\.5/u)
  await run(`v0.3.4 ${sha}\n`)
  assert.equal(calls.length, 1, 'an open issue prevents duplicates')
  issues[0].state = 'closed'
  await run(`v0.3.4 ${sha}\n`)
  assert.equal(calls.length, 1, 'a closed issue also prevents duplicates')
})

test('a pull request with the same title does not hide a missing sync issue', async () => {
  const { run, calls, issues } = fixture()
  issues.push({ title: 'Sync with upstream v0.3.5', pull_request: {} })
  await run(`v0.3.4 ${sha}`)
  assert.equal(calls.length, 1)
})

test('malformed markers and nonstable upstream responses fail without creating issues', async () => {
  const { run, calls, github } = fixture()
  await assert.rejects(run('v0.3.4 missing-sha'), /stable tag and full commit SHA/u)
  for (const release of [
    { tag_name: 'v0.3.6-rc.1', prerelease: true },
    { tag_name: 'v0.3.6', draft: true },
    { tag_name: 'unexpected' },
  ]) {
    github.rest.repos.getLatestRelease = async () => ({ data: release })
    await assert.rejects(run(`v0.3.4 ${sha}`), /stable upstream release/u)
  }
  assert.equal(calls.length, 0)
})

test('the watcher refuses to write outside the fork and surfaces API failures', async () => {
  const { run, context, calls, github } = fixture()
  context.repo.owner = 'Fei2411'
  await assert.rejects(run(`v0.3.4 ${sha}`), /only write to Nombah501/u)
  context.repo.owner = 'Nombah501'
  github.rest.repos.getLatestRelease = async () => { throw new Error('API unavailable') }
  await assert.rejects(run(`v0.3.4 ${sha}`), /API unavailable/u)
  assert.equal(calls.length, 0)
})
