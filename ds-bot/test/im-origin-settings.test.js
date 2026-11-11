import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: "export { ImPage } from './src/client/im-page.js'; export { installLocale } from './src/client/i18n.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let index = 0
const react = {
  createContext: value => ({ value }), useContext: ctx => ctx.value,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment', useEffect() {}, useLayoutEffect() {},
  useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }),
  useSyncExternalStore: (_, snapshot) => snapshot(), useId: () => 'id',
  useState: initial => {
    const at = index++
    if (!(at in slots)) slots[at] = initial
    return [slots[at], value => { slots[at] = value }]
  },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : {}, setTimeout, clearTimeout, URL, URLSearchParams })
const { ImPage, installLocale } = module.exports
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children ?? []).flatMap(nodes)]

for (const [locale, title, options] of [
  ['en', 'Turns started outside Telegram', ['All messages', 'Cards only', 'Nothing']],
  ['ru', 'Ходы, начатые не в Telegram', ['Все сообщения', 'Только Cards', 'Ничего']],
  ['zh', '在 Telegram 外开始的轮次', ['所有消息', '仅卡片', '不发送']],
]) test(`connection settings show and change autonomous delivery in ${locale}`, async () => {
  const dictionaries = {}
  const off = installLocale({ register: (_, tag, words) => { dictionaries[tag] = words }, bind: () => key => dictionaries[locale]?.[key] ?? key })
  try {
    slots.length = 0
    index = 0
    const calls = []
    const conn = { id: 'im_test', platform: 'telegram', botId: 'a', enabled: true, requests: [], paired: [], chats: {} }
    const props = { roster: { bots: [{ id: 'a', name: 'Chief' }], rooms: [], im: { connections: [conn], platforms: ['telegram'] } }, actions: { imUpdate: async (...args) => { calls.push(args) } } }
    const list = ImPage(props)
    nodes(list).find(node => node.props.onOpen && node.props.conn)?.props.onOpen()
    index = 0
    const detail = ImPage(props)
    index = 0
    slots.length = 0
    const tree = detail.type(detail.props)
    const setting = nodes(tree).find(node => node.props.label === title && node.children.some(child => child?.props?.value === 'all'))
    assert.ok(setting, 'setting is next to account access controls')
    const buttons = nodes(setting).filter(node => node.type === 'button')
    assert.deepEqual(buttons.map(node => node.children[0]), options)
    assert.deepEqual(buttons.map(node => node.props['aria-pressed']), [true, false, false])
    buttons[1].props.onClick()
    await Promise.resolve()
    assert.equal(calls[0][0], 'im_test')
    assert.equal(calls[0][1].nonTelegramTurns, 'cards')
  } finally { off() }
})
