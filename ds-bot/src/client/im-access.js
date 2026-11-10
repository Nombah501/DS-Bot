import { createElement as h, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { Caret, useAnchoredMenu } from './model-menu.js'
import { CheckIcon } from './icons.js'
import { t } from './i18n.js'

export function ImAccess({ value = 'all', roster, disabled = false, onPick }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const all = value === 'all'
  const count = all ? 0 : value.botIds.length + value.roomIds.length
  const selected = (kind, id) => all || value[kind].includes(id)
  const toggle = (kind, id) => {
    const next = all ? { botIds: roster.bots.map(bot => bot.id), roomIds: roster.rooms.map(room => room.id) } : value
    onPick({ ...next, [kind]: next[kind].includes(id) ? next[kind].filter(entry => entry !== id) : [...next[kind], id] })
  }
  const tick = on => h('span', { className: 'bt-model-tick', 'aria-hidden': true }, on ? h(CheckIcon) : null)
  return h(Fragment, null,
    h('button', { type: 'button', ref: button, className: 'bt-model-trigger bt-im-target', disabled, 'aria-label': t('Access list'), 'aria-haspopup': 'menu', 'aria-expanded': isOpen, onClick: () => isOpen ? close() : open() },
      h('span', { className: 'bt-model-name' }, all ? t('All Bots and groups') : t('Selected: {count}', { count })), h(Caret)),
    shownPlace ? createPortal(h('div', { ref: menu, className: `bt-menu bt-model-menu bt-im-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`, style: shownPlace, role: 'menu', 'aria-label': t('Access list'), 'data-leaving': leaving || undefined },
      h('button', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': all, disabled, onClick: () => onPick(all ? { botIds: [], roomIds: [] } : 'all') }, h('span', { className: 'bt-menu-label' }, t('All Bots and groups')), tick(all)),
      h('div', { className: 'bt-model-group', role: 'presentation' }, t('Bots')),
      roster.bots.map(bot => h('button', { key: bot.id, type: 'button', role: 'menuitemcheckbox', 'aria-checked': selected('botIds', bot.id), disabled, onClick: () => toggle('botIds', bot.id) }, h('span', { className: 'bt-menu-label' }, bot.name), tick(selected('botIds', bot.id)))),
      h('div', { className: 'bt-model-group', role: 'presentation' }, t('Group chats')),
      roster.rooms.map(room => h('button', { key: room.id, type: 'button', role: 'menuitemcheckbox', 'aria-checked': selected('roomIds', room.id), disabled, onClick: () => toggle('roomIds', room.id) }, h('span', { className: 'bt-menu-label' }, room.name), tick(selected('roomIds', room.id))))), document.body) : null)
}
