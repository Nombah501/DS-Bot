# Telegram Bridge fork

This is [Nombah501/DS-Bot](https://github.com/Nombah501/DS-Bot/tree/telegram-bridge), an Apache-2.0 fork of [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot). It keeps DS Bot's long-lived Bots and DSH plugin architecture and extends Telegram as a remote control, not a conversation mirror. The plugin release is **0.3.5-tb.1**; desktop and mobile installers are not fork release artifacts.

## What's new

Telegram features use Bot API **10.1–10.4** and Telegram-only capabilities; the other seven messaging platforms keep their existing paths.

- **Rich Step messages and Cards:** native tables, headings, lists, quotes, fenced code and embedded controls; long content splits on complete blocks. Question/approval Cards settle across Telegram and the computer, retaining only the chosen disabled controls. Unknown rich-message methods on older self-hosted servers use the text transport; unrelated errors are not silently downgraded.
- **Multi-select:** toggle choices, then Done; empty submissions remain open. Numeric and computer answers still settle all copies.
- **Draft and Stop:** temporary rich previews in private chats and Stop for the whole running turn, scoped to the exact chat/Topic and draft. Groups receive final messages, not Drafts.
- **Private card:** group approvals are initially visible only to the paired Initiator. Answers are recipient-checked; after five minutes an unresolved approval becomes an ordinary Card in the same place. Failed private sends never immediately expose content publicly.
- **Topics and `/bind`:** private Topics for accessible Bots and DS Bot group chats, lifecycle rename/close/recreation without deleting history, and administrator-controlled forum bindings. General can use the Default Bot; an unknown named Topic is not silently redirected there.
- **Access list:** choose the Bots and groups each paired person may reach. Revocation also affects queued output, Cards, Drafts and panel controls.
- **Reply where asked:** Telegram-started turns return to their exact connection, chat and Topic. Autonomous/non-Telegram turns use accessible private destinations, with all/Cards-only/none settings.
- **Status panel:** pinned, updating private widget with Stop; group/forum `/status` uses a rich snapshot with an authorized Stop control while work is active.
- **Language and feedback:** Russian Bridge/settings text, per-person `/lang ru`, `/lang en`, `/lang auto`, and localized callback toasts instead of noisy chat notices. Button acknowledgements remain responsive during asynchronous work.
- **Fixes:** chat-scoped message identities, recipient/Topic/access checks on stale controls, restart-safe routing and settlement, draft/final ordering, typing delivery, a deterministic room-race regression fixture and browser-script execution isolation.

## Install into a DSH profile

Download the plugin tarball from [release v0.3.5-tb.1](https://github.com/Nombah501/DS-Bot/releases/tag/v0.3.5-tb.1), not a source-code archive. DSH Web requires Node.js 22.19 or newer and pnpm; this upstream base targets DSH `0.2.2-rc.1`.

Run these yourself in a download directory (stop the running DSH instance before replacing its plugin):

```sh
gh release download v0.3.5-tb.1 --repo Nombah501/DS-Bot --pattern 'ds-bot-0.3.5-tb.1.tgz'
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add "file:$PWD/ds-bot-0.3.5-tb.1.tgz"
npx @deepseek-ai/dsh@0.2.2-rc.1 web
```

Enable/configure the plugin in that profile and pair Telegram in its Bridge settings. Keep the tarball at its `file:` location for later reinstalls. Do not use the upstream npm package when you want this fork. The release packaging check extracts this tarball and checks its installable contents without reading or modifying any user's DSH profile; actual profile installation and live Telegram checks are coordinator/user steps.

## Upstream tracking and publishing

Base: [upstream v0.3.5](https://github.com/Fei2411/DS-Bot/releases/tag/v0.3.5), commit `405ee8bbf5c6cbe805340c1dc69186863bfb5939`, recorded in [`.upstream-release`](.upstream-release). The fork's default branch is `telegram-bridge`; `main` remains an upstream copy for future contributions, never a target for our subtree publisher.

Development lives in the `ds-bot/` subtree of [DSH-Plugins](https://github.com/Nombah501/DSH-Plugins). Sync upstream into that subtree with full history, preserve Telegram-only capability gates and regenerate generated bundles rather than editing them. Follow the integration repository's `docs/runbooks/sync-upstream.md`. Install plugin/harness dependencies and the new `link/` dependencies before building. Fork versions are `<upstream version>-tb.<N>`: increment N for each publication, reset it for a new upstream base.

From a clean, committed DSH-Plugins checkout:

```sh
scripts/check.sh
node --test scripts/publish-fork.test.mjs
scripts/publish-fork.sh
```

The publisher splits the current committed branch at `ds-bot/`, fetches only the fork's `telegram-bridge`, checks ancestry, then performs an ordinary fast-forward-only push. Divergence stops with an error; merge the fork history, never force-push. It refuses dirty/untracked work and never updates upstream or fork `main`. Pack `ds-bot/ds-bot` with `npm pack` from that gated commit and attach the tarball to the matching fork release. Disable the fork's inherited `release.yml` workflow before publishing: it is upstream's npm/desktop/mobile publication pipeline, not this fork's tarball process. Leave its test workflow enabled.

The [upstream watcher](https://github.com/Nombah501/DS-Bot/actions/workflows/upstream-watch.yml) checks stable releases daily at 06:23 UTC and on manual dispatch. A [“Sync with upstream vX.Y.Z” issue](https://github.com/Nombah501/DS-Bot/issues?q=is%3Aissue+%22Sync+with+upstream%22), with release notes and a tag comparison, is the signal to follow the sync runbook. Existing open or closed issues suppress duplicates. It needs only the built-in `GITHUB_TOKEN`, never merges or publishes, and never changes `.upstream-release`.

After packing, run `node scripts/check-fork-package.mjs /absolute/path/to/ds-bot-0.3.5-tb.1.tgz` in DSH-Plugins. It extracts into a temporary directory, compares the exact `npm pack --dry-run` inventory and every file's bytes, and checks package exports/bundles without accessing a DSH profile.

Upstream contributions: [our room-race regression PR #1396](https://github.com/Fei2411/DS-Bot/pull/1396), [typing PR #1192](https://github.com/Fei2411/DS-Bot/pull/1192), and [our Telegram/Russian proposals in Discussions](https://github.com/Fei2411/DS-Bot/discussions?discussions_q=author%3ANombah501). Discussion acceptance is not implied; fork-only features remain maintained here until upstream adopts them.

## Changes from upstream

The following is the changed/added-file notice for this fork relative to the base above (Apache-2.0 §4(b)); `M` means modified and `A` means added by the fork. Existing upstream license/attribution notices are retained. Paths are relative to the **split DS-Bot repository**, not the outer DSH-Plugins checkout.

To regenerate the exact list after committing changes, run from DSH-Plugins and replace the fenced inventory below with stdout (the split includes this notice itself):

```sh
split=$(git subtree split --quiet --prefix=ds-bot HEAD)
git diff --name-status --no-renames 405ee8bbf5c6cbe805340c1dc69186863bfb5939 "$split"
```

In the published DS-Bot checkout the equivalent command is `git diff --name-status --no-renames 405ee8bbf5c6cbe805340c1dc69186863bfb5939 HEAD`. Do not compare upstream's root against the unsplit outer repository: upstream `ds-bot/` is outer `ds-bot/ds-bot/`. On an upstream sync, update both the base SHA and this inventory.

<!-- upstream-changes:start -->
```text
M	.github/workflows/test.yml
A	.github/workflows/upstream-watch.yml
A	.upstream-release
A	FORK.md
M	README.md
M	ds-bot/client.js
M	ds-bot/package-lock.json
M	ds-bot/package.json
M	ds-bot/src/client/i18n.js
A	ds-bot/src/client/im-access.js
M	ds-bot/src/client/im-page.js
M	ds-bot/src/client/locales/de.js
M	ds-bot/src/client/locales/es.js
M	ds-bot/src/client/locales/fr.js
M	ds-bot/src/client/locales/ja.js
M	ds-bot/src/client/locales/ko.js
M	ds-bot/src/client/team-actions.js
M	ds-bot/src/host/browser/script-runner.js
M	ds-bot/src/host/channel.js
M	ds-bot/src/host/im/format.js
A	ds-bot/src/host/im/forum-bind.js
M	ds-bot/src/host/im/index.js
M	ds-bot/src/host/im/platforms/telegram.js
A	ds-bot/src/host/im/rich-format.js
A	ds-bot/src/host/im/status-panel.js
A	ds-bot/src/host/im/topics.js
M	ds-bot/src/shared/im-platforms.js
M	ds-bot/test/browser-script-runner.test.js
M	ds-bot/test/diagnostics.test.js
A	ds-bot/test/im-origin-settings.test.js
M	ds-bot/test/im-telegram.test.js
M	ds-bot/test/im.test.js
M	ds-bot/test/install.test.js
M	ds-bot/test/room-races.test.js
A	ds-bot/test/telegram-bridge.js
A	ds-bot/test/telegram-bridge.test.js
A	ds-bot/test/telegram-cards.test.js
A	ds-bot/test/telegram-draft.test.js
A	ds-bot/test/telegram-forum.test.js
A	ds-bot/test/telegram-group-status.test.js
A	ds-bot/test/telegram-locale.test.js
A	ds-bot/test/telegram-multi-select.test.js
A	ds-bot/test/telegram-origin.test.js
A	ds-bot/test/telegram-person-language.test.js
A	ds-bot/test/telegram-press-toasts.test.js
A	ds-bot/test/telegram-private-card.test.js
A	ds-bot/test/telegram-rich.test.js
A	ds-bot/test/telegram-status.test.js
A	ds-bot/test/telegram-topic-lifecycle.test.js
A	ds-bot/test/telegram-topics.test.js
A	ds-bot/test/upstream-watch.test.js
A	scripts/upstream-watch.cjs
```
<!-- upstream-changes:end -->
