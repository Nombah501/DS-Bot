# Telegram Bridge fork

This is [Nombah501/DS-Bot](https://github.com/Nombah501/DS-Bot/tree/telegram-bridge), an Apache-2.0 fork of [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot). It keeps DS Bot's long-lived Bots and DSH plugin architecture and extends Telegram as a remote control, not a conversation mirror. The current plugin release is named in [Install into a DSH profile](#install-into-a-dsh-profile); desktop and mobile installers are not fork release artifacts.

## What's new

Telegram features use Bot API **10.1–10.4** and Telegram-only capabilities; the other seven messaging platforms keep their existing paths.

- **Rich Step messages and Cards:** native tables, headings, lists, quotes, fenced code and embedded controls; long content splits on complete blocks. Question/approval Cards settle across Telegram and the computer, retaining only the chosen disabled controls. Unknown rich-message methods on older self-hosted servers use the text transport; unrelated errors are not silently downgraded.
- **Multi-select:** toggle choices, then Done; empty submissions remain open. Numeric and computer answers still settle all copies.
- **Draft and Stop:** temporary rich previews in private chats and Stop for the whole running turn, scoped to the exact chat/Topic and draft. Groups receive final messages, not Drafts.
- **Private card:** group approvals are initially visible only to the paired Initiator. Answers are recipient-checked; after five minutes an unresolved approval becomes an ordinary Card in the same place. Failed private sends never immediately expose content publicly.
- **Topics and `/bind`:** private Topics for accessible Bots and DS Bot group chats, renamed to show lost access or a deleted target (Telegram cannot close private Topics) and recreated without deleting history, and administrator-controlled forum bindings. General can use the Default Bot; an unknown named Topic is not silently redirected there.
- **Access list:** choose the Bots and groups each paired person may reach. Revocation also affects queued output, Cards, Drafts and panel controls.
- **Reply where asked:** Telegram-started turns return to their exact connection, chat and Topic. Autonomous/non-Telegram turns use accessible private destinations, with all/Cards-only/none settings.
- **Status:** `/status` answers with a rich snapshot and an authorized Stop control while work is active, in private chats and groups alike. The pinned private Status panel widget is kept in the code but not created while Telegram has widgets closed.
- **Language and feedback:** Russian Bridge/settings text, per-person `/lang ru`, `/lang en`, `/lang auto`, and localized callback toasts instead of noisy chat notices. Button acknowledgements remain responsive during asynchronous work.
- **Fixes:** chat-scoped message identities, recipient/Topic/access checks on stale controls, restart-safe routing and settlement, draft/final ordering, typing delivery, a deterministic room-race regression fixture and browser-script execution isolation.

### In 0.3.6-tb.6

- **Revoked private Topics are renamed, not closed:** Telegram closes and reopens Topics only in forum supergroups, so revoking a person's Access failed on the close and left the Topic open. The Topic now gets the notice and a localized name such as «Atlas — no access» (or «— deleted» for a deleted Bot or group); restoring Access gives it back its name. This replaces 0.3.6-tb.4's `reopenTopic`. Saving an Access list no longer reports a Topic error to the page once the list is saved, and a revoked Topic the person already deleted no longer stops the Topic sweep.

### In 0.3.6-tb.5

- **Access lists save from the connection page:** the page's Access list editor reached the server as an unknown endpoint and could not save; it now saves, and the Bridge applies the new list to the person's Topics.

### In 0.3.6-tb.4

- **One rule for Card answers:** a button and a number get the same reply in the same situation (no access, already answered, only the Initiator can answer). Another person's Private card no longer catches a number; it answers the older public Card or reaches the Bot. An approval closed while its Card was being sent no longer keeps live buttons. A Card found already answered is relabelled in each copy's own language.
- **Chats saved reliably:** a chat's own fields are saved once per message from the record found at write time, so a state re-read in between no longer loses them; a paired group keeps its own title instead of the person's name.
- **Topics:** no duplicate Topic after a state re-read, a Topic created while Access was being revoked is recorded and closed, and restoring Access reopens the closed Topic instead of creating a new one (new `reopenTopic`). When a deleted private Topic is replaced during a turn, the rest of the turn's output reaches the replacement.
- **Messages:** `/status` answers on every platform (text without Stop where Cards are not rich); Access and binding are checked again right before a message reaches the Bot; `/lang` from a person just unpaired is ignored.
- **Other platforms:** Discord group chats are titled with the channel name (one cached lookup per channel, bounded at 5 s); DingTalk drops the leading bot mention, so `@Bot /stop` and `@Bot 2` work; Slack presses report the right chat kind.
- **Internals:** Card kinds, Chat record, Topic lifecycle and Inbound each live in one module; two upstream tests that asserted before their event now wait for it.

### In 0.3.6-tb.3

- **Private `/status` while Telegram widgets are closed:** a private `/status` now answers like a group one — a snapshot Card with Stop while the Bot works, plain text when idle — instead of refreshing a pinned widget Telegram currently shows as unavailable. Existing pinned panels are left as they are.

### In 0.3.6-tb.2

- **Queued delivery:** one per-runner Delivery module carries complete Placement places for Bot output and keeps Bridge notices separate. A failure while recording a successful send no longer retries the send; closing a runner prevents its queue from starting further sends or retries. Queues remain in memory and are discarded on reconnect, disable or shutdown.

### In 0.3.6-tb.1

- **Upstream v0.3.6:** mobile app crash fixes and polish, Android APKs signed with v1, v2 and v3 schemes. No change to the plugin or the Bridge.

### In 0.3.5-tb.2

- **Queued output follows its own turn:** a Step message or Card waiting for a Telegram retry goes only where its turn started, even after the turn ended or a new turn began elsewhere. It is dropped if that place was unbound or its Access list revoked meanwhile. The public copy of a Private card is checked the same way.
- **Card answers keep the chosen button:** answering a Card while other state was being saved no longer loses the selected labels.
- **Every Bridge notice in every supported language:** zh-TW, ja, ko, es, fr and de get the full set of notices; `/lang auto` follows the person's Telegram language.
- **Fixes:** concurrent writes of the IM runtime file no longer collide; a message that joins an empty DS Bot group chat round while it closes is kept for the next round.
- **Internals:** Placement, Draft stream, Card journal, status view, Telegram adapter rules, platform capabilities and the platform error contract each live in one module. Behaviour is unchanged apart from the items above.

## Install into a DSH profile

Download the plugin tarball from [release v0.3.6-tb.6](https://github.com/Nombah501/DS-Bot/releases/tag/v0.3.6-tb.6), not a source-code archive. DSH Web requires Node.js 22.19 or newer and pnpm; this upstream base targets DSH `0.2.2-rc.1`.

Run these yourself in a download directory (stop the running DSH instance before replacing its plugin):

```sh
gh release download v0.3.6-tb.6 --repo Nombah501/DS-Bot --pattern 'ds-bot-0.3.6-tb.6.tgz'
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add "file:$PWD/ds-bot-0.3.6-tb.6.tgz"
npx @deepseek-ai/dsh@0.2.2-rc.1 web
```

Enable/configure the plugin in that profile and pair Telegram in its Bridge settings. Keep the tarball at its `file:` location for later reinstalls. Do not use the upstream npm package when you want this fork. The release packaging check extracts this tarball and checks its installable contents without reading or modifying any user's DSH profile; actual profile installation and live Telegram checks are coordinator/user steps.

## Upstream tracking and publishing

Base: [upstream v0.3.6](https://github.com/Fei2411/DS-Bot/releases/tag/v0.3.6), commit `a66cc737cfb6c3d8a2597e748cded6cab1206dd3`, recorded in [`.upstream-release`](.upstream-release). The fork's default branch is `telegram-bridge`; `main` remains an upstream copy for future contributions, never a target for our subtree publisher.

Development lives in the `ds-bot/` subtree of [DSH-Plugins](https://github.com/Nombah501/DSH-Plugins). Sync upstream into that subtree with full history, preserve Telegram-only capability gates and regenerate generated bundles rather than editing them. Follow the integration repository's `docs/runbooks/sync-upstream.md`. Install plugin/harness dependencies and the new `link/` dependencies before building. Fork versions are `<upstream version>-tb.<N>`: increment N for each publication, reset it for a new upstream base.

Keep `app/package.json` and both root version fields in `app/package-lock.json` in step with `ds-bot/package.json`, including the `-tb.N` suffix. Upstream's Desktop app profile test requires matching app/plugin versions even for plugin-only releases. The integration repository's `scripts/check.sh` checks that invariant without installing the app.

In DSH-Plugins, first write the human release note under `### In <upstream>-tb.<N>`, then bump, review and commit. Publish from a clean, committed `telegram-bridge-fix/ds-bot` checkout:

```sh
scripts/release.sh bump <N>
# Review and commit the version/install-section changes and human release note.
scripts/release.sh publish /absolute/path/to/notes.md
```

The release script runs the source gate, publisher tests and fork inventory check, pushes the integration branch, publishes the committed subtree, packs and verifies the plugin tarball in a temporary directory, then creates the matching GitHub Release at the published split with generated Validation, Source and SHA-256 lines appended to the supplied notes. Its subtree publisher fetches only the fork's `telegram-bridge`, checks ancestry, and performs an ordinary fast-forward-only push. Divergence stops with an error; merge the fork history, never force-push. Dirty/untracked work is refused; upstream and fork `main` are never updated. Disable the fork's inherited `release.yml` workflow before publishing: it is upstream's npm/desktop/mobile publication pipeline, not this fork's tarball process. Leave its test workflow enabled.

The [upstream watcher](https://github.com/Nombah501/DS-Bot/actions/workflows/upstream-watch.yml) checks stable releases daily at 06:23 UTC and on manual dispatch. A [“Sync with upstream vX.Y.Z” issue](https://github.com/Nombah501/DS-Bot/issues?q=is%3Aissue+%22Sync+with+upstream%22), with release notes and a tag comparison, is the signal to follow the sync runbook. Existing open or closed issues suppress duplicates. It needs only the built-in `GITHUB_TOKEN`, never merges or publishes, and never changes `.upstream-release`.

`scripts/release.sh publish` runs `node scripts/check-fork-package.mjs <tarball>` automatically: extraction into a temporary directory, exact `npm pack --dry-run` inventory and byte comparisons, and package exports/bundles checks. It prints the separate `scripts/install-profile.sh <release tag> [profile]` command; publishing never stops DSH, installs or accesses a DSH profile. Keep the install and live-check steps in the integration runbook.

Past upstream contributions: [room-race regression PR #1396](https://github.com/Fei2411/DS-Bot/pull/1396) and the Discussions [#1397](https://github.com/Fei2411/DS-Bot/discussions/1397), [#1398](https://github.com/Fei2411/DS-Bot/discussions/1398) and [#1399](https://github.com/Fei2411/DS-Bot/discussions/1399). Upstream accepts pull requests only from collaborators and has not answered these, so the fork no longer contributes upstream; its features and fixes are maintained here.

## Changes from upstream

The following is the changed/added-file notice for this fork relative to the base above (Apache-2.0 §4(b)); `M` means modified and `A` means added by the fork. Existing upstream license/attribution notices are retained. Paths are relative to the **split DS-Bot repository**, not the outer DSH-Plugins checkout.

To regenerate the exact list after committing changes, run from DSH-Plugins and replace the fenced inventory below with stdout (the split includes this notice itself):

```sh
split=$(git subtree split --quiet --prefix=ds-bot HEAD)
git diff --name-status --no-renames a66cc737cfb6c3d8a2597e748cded6cab1206dd3 "$split"
```

In the published DS-Bot checkout the equivalent command is `git diff --name-status --no-renames a66cc737cfb6c3d8a2597e748cded6cab1206dd3 HEAD`. Do not compare upstream's root against the unsplit outer repository: upstream `ds-bot/` is outer `ds-bot/ds-bot/`. On an upstream sync, update both the base SHA and this inventory.

<!-- upstream-changes:start -->
```text
M	.github/workflows/test.yml
A	.github/workflows/upstream-watch.yml
A	.upstream-release
A	FORK.md
M	README.md
M	app/package-lock.json
M	app/package.json
M	docs/plans/2026-11-04-im.md
M	ds-bot/client.js
M	ds-bot/package-lock.json
M	ds-bot/package.json
M	ds-bot/scripts/build-client.mjs
M	ds-bot/scripts/build-link.mjs
M	ds-bot/scripts/lint.mjs
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
M	ds-bot/src/host/groups.js
A	ds-bot/src/host/im/card-kinds.js
A	ds-bot/src/host/im/cards.js
A	ds-bot/src/host/im/chat-record.js
A	ds-bot/src/host/im/delivery.js
A	ds-bot/src/host/im/drafts.js
A	ds-bot/src/host/im/errors.js
M	ds-bot/src/host/im/format.js
A	ds-bot/src/host/im/forum-bind.js
A	ds-bot/src/host/im/inbound.js
M	ds-bot/src/host/im/index.js
A	ds-bot/src/host/im/locale.js
A	ds-bot/src/host/im/placement.js
M	ds-bot/src/host/im/platforms/dingtalk.js
M	ds-bot/src/host/im/platforms/discord.js
M	ds-bot/src/host/im/platforms/feishu.js
M	ds-bot/src/host/im/platforms/qq.js
M	ds-bot/src/host/im/platforms/slack.js
M	ds-bot/src/host/im/platforms/telegram.js
M	ds-bot/src/host/im/platforms/wecom.js
M	ds-bot/src/host/im/platforms/weixin.js
A	ds-bot/src/host/im/rich-format.js
A	ds-bot/src/host/im/status-panel.js
A	ds-bot/src/host/im/topics.js
M	ds-bot/src/shared/im-platforms.js
M	ds-bot/test/browser-script-runner.test.js
A	ds-bot/test/card-kinds.test.js
A	ds-bot/test/cards.test.js
A	ds-bot/test/chat-record.test.js
M	ds-bot/test/diagnostics.test.js
A	ds-bot/test/drafts.test.js
M	ds-bot/test/follow-through.test.js
A	ds-bot/test/forum-bind.test.js
A	ds-bot/test/im-delivery.test.js
M	ds-bot/test/im-dingtalk.test.js
M	ds-bot/test/im-discord.test.js
A	ds-bot/test/im-errors.test.js
M	ds-bot/test/im-feishu.test.js
A	ds-bot/test/im-origin-settings.test.js
A	ds-bot/test/im-platforms.test.js
M	ds-bot/test/im-qq.test.js
M	ds-bot/test/im-slack.test.js
M	ds-bot/test/im-telegram.test.js
M	ds-bot/test/im-wecom.test.js
M	ds-bot/test/im-weixin.test.js
M	ds-bot/test/im.test.js
A	ds-bot/test/inbound.test.js
M	ds-bot/test/install.test.js
A	ds-bot/test/locale.test.js
A	ds-bot/test/placement-fixture.js
A	ds-bot/test/placement.test.js
M	ds-bot/test/room-races.test.js
M	ds-bot/test/rounds.test.js
A	ds-bot/test/status-panel.test.js
M	ds-bot/test/switch-keeps-input.test.js
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
A	ds-bot/test/telegram-settle-race.test.js
A	ds-bot/test/telegram-status.test.js
A	ds-bot/test/telegram-topic-lifecycle.test.js
A	ds-bot/test/telegram-topics.test.js
A	ds-bot/test/topics.test.js
A	ds-bot/test/upstream-watch.test.js
A	scripts/upstream-watch.cjs
```
<!-- upstream-changes:end -->
