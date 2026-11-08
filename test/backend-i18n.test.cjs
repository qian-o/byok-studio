const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { t, setLocale, getLocale } = require('../media/i18n.js');
const {
  object, text, validId, validateParameters, validateOverrides, validateProvider,
  validateReasoningControls, sanitizeError
} = require('../dist/core/configuration');
const { StudioStore } = require('../dist/core/store');
const { resolveEndpoint } = require('../dist/core/endpoints');
const { discoverModels } = require('../dist/core/discoveryTransport');
const { discoverProviderModels } = require('../dist/core/discovery');
const { parseNativeGroups, updateOwnedGroup } = require('../dist/core/officialJson');

const initialLocale = getLocale();
const defaults = {
  name: '', contextWindow: 128000, maxOutputTokens: 16000, toolCalling: false,
  vision: false, thinking: false, supportsReasoningEffort: [], source: '', verifiedAt: null
};
const database = () => ({ schemaVersion: 1, defaults: { ...defaults }, models: {} });
const provider = () => ({
  id: 'fixture', name: '示例服务商 {0}', apiType: 'responses', url: 'https://example.test/v1',
  enabled: true, models: [{ id: 'sample', name: '', discoveredName: '', overrides: {} }]
});
const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };

beforeEach(() => setLocale('en'));
afterEach(() => setLocale('en'));

test('backend messages default to English and localize validation labels before interpolation', () => {
  assert.equal(initialLocale, 'en');
  assert.throws(() => object(null), { message: 'Configuration must be an object.' });
  assert.throws(() => validId('two words'), { message: 'Model ID cannot contain whitespace or control characters.' });
  assert.throws(() => validateParameters({ ...defaults, contextWindow: 0 }), {
    message: 'Context window must be an integer between 1 and 100000000.'
  });
  assert.throws(() => validateProvider({ ...provider(), zeroDataRetentionEnabled: 'true' }, database()), {
    message: 'Zero data retention must be a boolean.'
  });
});

test('Chinese locale variants change validation and fallback messages at call time', () => {
  for (const language of ['zh-CN', 'zh-TW', 'zh_HK', 'zh']) {
    setLocale(language);
    assert.equal(getLocale(), 'zh-CN');
    assert.throws(() => object(null), { message: '配置必须是对象。' });
    assert.throws(() => validId('two words'), { message: '模型 ID不能包含空白或控制字符。' });
    assert.throws(() => validateParameters({ ...defaults, contextWindow: 0 }), {
      message: '上下文窗口必须是 1–100000000 的整数。'
    });
    assert.equal(sanitizeError(null), '操作失败。');
  }
  setLocale('de-DE');
  assert.equal(getLocale(), 'en');
  assert.equal(sanitizeError(null), 'The operation failed.');
});

test('parameter keys and generated field paths stay exact in both languages', () => {
  const { unsupportedFields } = require('../dist/core/officialConfig');
  const db = database();
  db.defaults.reasoningControls = { protocols: { responses: { parameters: { top_k: 16 } } } };
  for (const [locale, expected] of [
    ['en', 'contextWindow must be an integer between 1 and 100000000.'],
    ['zh-CN', 'contextWindow必须是 1–100000000 的整数。']
  ]) {
    setLocale(locale);
    assert.throws(() => validateOverrides({ contextWindow: 0 }), { message: expected });
    assert.deepEqual(unsupportedFields(validateProvider(provider(), db), db), [{
      modelId: 'sample', apiType: 'responses', field: 'reasoningControls.protocols.responses.parameters.top_k'
    }]);
  }
  setLocale('en');
  assert.throws(() => text(42, 'reasoningControls.protocols.responses.parameters.top_k'), {
    message: 'reasoningControls.protocols.responses.parameters.top_k is not valid text.'
  });
  assert.throws(() => validateReasoningControls({ protocols: { responses: { modePath: ['headers'] } } }), {
    message: 'The protocol parameter path is invalid or contains reserved fields.'
  });
});

test('static URL and JSONC errors are localized without exposing invalid input', () => {
  const malformed = '[{"apiKey":"fixture-private-key"';
  for (const [locale, urlMessage, jsonMessage] of [
    ['en', 'The provider URL is invalid.', 'Native model configuration must be a valid JSONC array of objects.'],
    ['zh-CN', '服务商 URL 无效。', '原生模型配置必须是有效的 JSONC 对象数组。']
  ]) {
    setLocale(locale);
    assert.throws(() => resolveEndpoint('not a URL', 'responses', 'models'), { message: urlMessage });
    assert.throws(() => parseNativeGroups(malformed), { message: jsonMessage });
  }
  setLocale('en');
  assert.throws(() => updateOwnedGroup('[]', '', {}), { message: 'A nonempty BYOK Studio provider ID is required.' });
  setLocale('zh-CN');
  assert.throws(() => updateOwnedGroup('[]', '', {}), { message: '必须提供非空的 BYOK Studio 供应商 ID。' });
});

test('sanitization preserves raw errors while redacting credentials in either locale', () => {
  const secret = 'fixture.$&{0}-secret';
  const raw = `服务商原始错误 操作失败。 {0}: ${secret}, again ${secret}; Bearer other-secret`;
  const expectedPrefix = '服务商原始错误 操作失败。 {0}: [REDACTED], again [REDACTED]; ';
  for (const locale of ['en', 'zh-CN']) {
    setLocale(locale);
    const sanitized = sanitizeError(new Error(raw), secret);
    assert.ok(sanitized.startsWith(expectedPrefix));
    assert.equal(sanitized.includes(secret), false);
    assert.equal(sanitized.includes('other-secret'), false);
    assert.equal(sanitizeError(new Error('操作失败。')), '操作失败。');
    assert.equal(sanitizeError(new Error('The provider refused this request.')), 'The provider refused this request.');
    assert.equal(sanitizeError(new Error('x'.repeat(2100))).length, 2000);
  }
  assert.equal(t('BYOK Studio 官方配置同步失败：{0}', '操作失败。 {1} $&'), 'BYOK Studio 官方配置同步失败：操作失败。 {1} $&');
  setLocale('en');
  assert.equal(t('BYOK Studio 官方配置同步失败：{0}', '操作失败。 {1} $&'), 'BYOK Studio could not synchronize the official configuration: 操作失败。 {1} $&');
});

test('saved-state validation and asynchronous library errors use the selected locale', async () => {
  const invalid = { version: 2, providers: [] };
  assert.throws(() => new StudioStore({ get: () => invalid }, secrets, database(), () => {}), {
    message: 'The saved BYOK configuration version is not supported; the original data has not been changed.'
  });
  setLocale('zh-CN');
  assert.throws(() => new StudioStore({ get: () => invalid }, secrets, database(), () => {}), {
    message: '保存的 BYOK 配置版本不受支持；原始数据未修改。'
  });
  const store = new StudioStore({ get: () => undefined, update: async () => {} }, secrets, database(), () => {});
  const item = provider();
  item.models[0].name = '操作失败。 {0} $&';
  item.models[0].overrides = { maxOutputTokens: 64000 };
  await store.saveProvider(item);
  const smaller = database();
  smaller.defaults.contextWindow = 32000;
  for (const [locale, message] of [
    ['en', 'Updating the parameter library would invalidate the manual overrides for “操作失败。 {0} $&”. Adjust its token parameters first.'],
    ['zh-CN', '参数库更新会使“操作失败。 {0} $&”的手动覆盖无效，请先调整其 Token 参数。']
  ]) {
    setLocale(locale);
    await assert.rejects(store.saveDatabase(smaller), { message });
    assert.equal(store.snapshot().database.defaults.contextWindow, 128000);
  }
});

test('discovery returns localized safe errors without exposing provider response bodies', async context => {
  let response;
  context.mock.method(globalThis, 'fetch', async () => response);
  for (const [locale, httpMessage, jsonMessage, cancelledMessage, addressMessage] of [
    ['en', 'The provider returned HTTP 401.', 'The provider returned malformed models JSON.', 'The provider request was cancelled.', 'Enter an API URL for at least one protocol.'],
    ['zh-CN', '服务商返回 HTTP 401。', '服务商返回的模型 JSON 格式错误。', '服务商请求已取消。', '请至少填写一个协议的 API 地址。']
  ]) {
    setLocale(locale);
    response = new Response('fixture-private-key', { status: 401 });
    await assert.rejects(discoverModels(provider(), 'fixture-private-key', new AbortController().signal), { message: httpMessage });
    response = new Response('{bad JSON fixture-private-key');
    await assert.rejects(discoverModels(provider(), 'fixture-private-key', new AbortController().signal), { message: jsonMessage });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(discoverModels(provider(), 'fixture-private-key', controller.signal), {
      name: 'AbortError', message: cancelledMessage
    });
    await assert.rejects(discoverProviderModels({ ...provider(), url: '' }, '', new AbortController().signal), { message: addressMessage });
  }
});

test('activation selects the VS Code language before reading or validating stored data', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../dist/extension.js'), 'utf8');
  for (const [language, locale, message] of [
    ['zh-TW', 'zh-CN', '参数库版本不受支持。'],
    ['en', 'en', 'Unsupported parameter library version.']
  ]) {
    setLocale(locale === 'en' ? 'zh-CN' : 'en');
    let localeAtRead;
    const exports = {};
    const vscode = {
      env: { language }, Uri: { joinPath: () => 'bundled-database' },
      workspace: { fs: { readFile: async () => {
        localeAtRead = getLocale();
        return Buffer.from('{"schemaVersion":2}');
      } } }
    };
    vm.runInNewContext(code, { exports, Buffer, require: name => {
      if (name === 'vscode') return vscode;
      if (name === './panel' || name === './officialManager') return {};
      return require(path.resolve(__dirname, '../dist', name));
    } });
    await assert.rejects(exports.activate({ extensionUri: 'fixture' }), { message });
    assert.equal(localeAtRead, locale);
    assert.equal(getLocale(), locale);
  }
});

test('the backend dictionary exports the same messages for Node and the webview', () => {
  const messages = require('../media/i18n-errors.js');
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/i18n-errors.js'), 'utf8'), browser);
  assert.deepEqual(Object.entries(browser.ByokErrorMessages), Object.entries(messages));
  for (const [message, translated] of Object.entries(messages)) {
    assert.equal(typeof translated, 'string');
    assert.ok(translated.length > 0, message);
    assert.doesNotMatch(translated, /\p{Script=Han}/u, message);
    assert.deepEqual(translated.match(/\{\d+\}/g) ?? [], message.match(/\{\d+\}/g) ?? [], message);
  }
});
