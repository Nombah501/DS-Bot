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
  for (const code of ['zh-hant', 'zh-TW', 'zh-hk', 'zh_TW']) assert.equal(localeOf({ languageCode: code, uiLanguage: 'German' }), 'zh-TW', code)
  for (const code of ['zh', 'zh-hans', 'zh-cn', 'zh_CN', 'zho']) assert.equal(localeOf({ languageCode: code, uiLanguage: 'German' }), 'zh', code)
})

test('Locale: every locale translates every notice', () => {
  const values = { target: 'T', name: 'N', bot: 'B', language: 'L' }
  for (const locale of LOCALES.filter(locale => locale !== 'en')) {
    const english = NOTICES.filter(key => translate(locale, key, values) === translate('en', key, values))
    assert.deepEqual(english, [], `${locale} shows these notices in English`)
  }
})

test('Locale: revoked and deleted Topic names are localized in every supported language', () => {
  const names = {
    ru: ['N — нет доступа', 'N — удалён'],
    en: ['N — no access', 'N — deleted'],
    zh: ['N — 无访问权限', 'N — 已删除'],
    'zh-TW': ['N — 無存取權限', 'N — 已刪除'],
    ja: ['N — アクセス権なし', 'N — 削除済み'],
    ko: ['N — 액세스 권한 없음', 'N — 삭제됨'],
    es: ['N — sin acceso', 'N — eliminado'],
    fr: ['N — sans accès', 'N — supprimé'],
    de: ['N — kein Zugriff', 'N — gelöscht'],
  }
  assert.deepEqual(Object.keys(names).sort(), [...LOCALES].sort())
  for (const [locale, expected] of Object.entries(names)) {
    assert.deepEqual(['topicRevokedName', 'topicDeletedName'].map(key => translate(locale, key, { name: 'N' })), expected, locale)
  }
  for (const key of ['topicRevokedName', 'topicDeletedName']) assert.ok(NOTICES.includes(key), `${key} participates in notice coverage`)
})

test('Locale: notices fill their values and fall back to English, then to the key', () => {
  assert.equal(translate('ru', 'connected', { target: 'Chief' }), 'Подключено — теперь можно общаться с Chief.')
  assert.equal(translate('xx', 'stopped'), translate('en', 'stopped'), 'unknown locale')
  assert.equal(translate('ru', 'noSuchNotice'), 'noSuchNotice')
})
