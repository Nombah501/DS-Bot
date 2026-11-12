import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localeOf, translate } from '../src/host/im/locale.js'

test('Locale: a /lang choice wins, then a Russian Telegram language, then the DS Bot interface language', () => {
  assert.equal(localeOf({ preference: 'en', languageCode: 'ru', uiLanguage: 'German' }), 'en')
  assert.equal(localeOf({ preference: 'ru', languageCode: 'en', uiLanguage: 'German' }), 'ru')
  assert.equal(localeOf({ preference: 'auto', languageCode: 'RU-ru', uiLanguage: 'German' }), 'ru')
  assert.equal(localeOf({ languageCode: 'de', uiLanguage: 'Traditional Chinese (Taiwan)' }), 'zh-TW')
  assert.equal(localeOf({ languageCode: 'de', uiLanguage: 'Chinese (Simplified)' }), 'zh')
  assert.equal(localeOf({ uiLanguage: 'Korean' }), 'ko')
  assert.equal(localeOf({}), 'en')
})

test('Locale: notices fill their values and fall back to English, then to the key', () => {
  assert.equal(translate('ru', 'connected', { target: 'Chief' }), 'Подключено — теперь можно общаться с Chief.')
  assert.equal(translate('de', 'stop'), translate('en', 'stop'), 'a notice German lacks')
  assert.notEqual(translate('de', 'stopped'), translate('en', 'stopped'))
  assert.equal(translate('xx', 'stopped'), translate('en', 'stopped'), 'unknown locale')
  assert.equal(translate('ru', 'noSuchNotice'), 'noSuchNotice')
})
