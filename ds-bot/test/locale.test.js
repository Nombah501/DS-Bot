import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOCALES, NOTICES, localeOf, translate } from '../src/host/im/locale.js'

test('Locale: a /lang choice wins, then the Telegram language, then the DS Bot interface language', () => {
  assert.equal(localeOf({ preference: 'en', languageCode: 'ru', uiLanguage: 'German' }), 'en')
  assert.equal(localeOf({ preference: 'ru', languageCode: 'en', uiLanguage: 'German' }), 'ru')
  assert.equal(localeOf({ preference: 'auto', languageCode: 'RU-ru', uiLanguage: 'German' }), 'ru')
  for (const code of ['de', 'ja', 'ko', 'es', 'fr', 'en']) assert.equal(localeOf({ preference: 'auto', languageCode: code, uiLanguage: 'Russian' }), code)
  assert.equal(localeOf({ languageCode: 'pt-br', uiLanguage: 'Traditional Chinese (Taiwan)' }), 'zh-TW')
  assert.equal(localeOf({ languageCode: 'pt-br', uiLanguage: 'Chinese (Simplified)' }), 'zh')
  assert.equal(localeOf({ uiLanguage: 'Korean' }), 'ko')
  assert.equal(localeOf({}), 'en')
})

test('Locale: Traditional Chinese Telegram tags pick zh-TW, every other Chinese tag zh', () => {
  for (const code of ['zh-hant', 'zh-TW', 'zh-hk']) assert.equal(localeOf({ languageCode: code }), 'zh-TW', code)
  for (const code of ['zh', 'zh-hans', 'zh-cn']) assert.equal(localeOf({ languageCode: code }), 'zh', code)
})

test('Locale: every locale translates every notice', () => {
  const values = { target: 'T', name: 'N', bot: 'B', language: 'L' }
  for (const locale of LOCALES.filter(locale => locale !== 'en')) {
    const english = NOTICES.filter(key => translate(locale, key, values) === translate('en', key, values))
    assert.deepEqual(english, [], `${locale} shows these notices in English`)
  }
})

test('Locale: notices fill their values and fall back to English, then to the key', () => {
  assert.equal(translate('ru', 'connected', { target: 'Chief' }), 'Подключено — теперь можно общаться с Chief.')
  assert.equal(translate('xx', 'stopped'), translate('en', 'stopped'), 'unknown locale')
  assert.equal(translate('ru', 'noSuchNotice'), 'noSuchNotice')
})
