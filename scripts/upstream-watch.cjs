module.exports = async function watchUpstream({ github, context, core, marker }) {
  if (context.repo.owner !== 'Nombah501' || context.repo.repo !== 'DS-Bot') {
    throw new Error('Upstream watcher may only write to Nombah501/DS-Bot')
  }
  const match = /^(v\d+\.\d+\.\d+)\s+[a-f0-9]{40}\s*$/u.exec(marker.trim())
  if (!match) throw new Error('Expected .upstream-release to contain a stable tag and full commit SHA')
  const integrated = match[1]
  // GitHub's latest-release endpoint excludes drafts and prereleases.
  const { data: release } = await github.rest.repos.getLatestRelease({ owner: 'Fei2411', repo: 'DS-Bot' })
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/u.test(release.tag_name)) {
    throw new Error('Expected a stable upstream release tag vX.Y.Z')
  }
  if (release.tag_name === integrated) {
    core.info(`Already integrated ${integrated}; no issue created`)
    return
  }
  const title = `Sync with upstream ${release.tag_name}`
  // Avoid search-index lag: list every page, including closed issues, before creating.
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, state: 'all', per_page: 100 })
  const existing = issues.find(issue => !issue.pull_request && issue.title === title)
  if (existing) {
    core.info(`Sync issue already exists: ${existing.html_url}; no issue created`)
    return
  }
  const compare = `https://github.com/Fei2411/DS-Bot/compare/${integrated}...${release.tag_name}`
  const { data: issue } = await github.rest.issues.create({
    ...context.repo,
    title,
    body: [
      `Upstream has released **${release.tag_name}**; the last integrated release is **${integrated}**.`,
      '',
      `- [Release notes](${release.html_url})`,
      `- [Compare tags](${compare})`,
      '',
      'Follow the DSH-Plugins runbook `docs/runbooks/sync-upstream.md` to merge, validate and publish. This watcher never merges code or publishes packages.',
    ].join('\n'),
  })
  core.info(`Created sync issue: ${issue.html_url}`)
}
