require('../resources/shared/i18n').setLocale('zh-CN');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDatabase, validateProvider, validateParameters, validateProtocols, effectiveParameters, modelName, validateUrl } = require('../dist/core/configuration');
const { StudioStore, parseExportBundle } = require('../dist/core/store');
const defaults = { name: '', contextWindow: 128000, maxOutputTokens: 16000, toolCalling: false, vision: false, thinking: false, supportsReasoningEffort: [] };
const database = () => ({ schemaVersion: 1, defaults: { ...defaults }, models: { 'request-id': { ...defaults, name: 'Friendly Name', contextWindow: 1000000, maxOutputTokens: 128000, toolCalling: true } } });
const model = (id = 'request-id') => ({ id, name: '', discoveredName: '', overrides: {} });
const provider = (id = 'provider-one') => ({ id, name: 'Gateway', apiType: 'responses', url: 'https://gateway.example/v1', enabled: true, models: [model()] });
function storage() {
  const data = new Map(), keys = new Map(); let fail = false, changes = 0;
  const global = { get: key => data.get(key), update: async (key, value) => { if (fail) throw Error('write failed'); data.set(key, structuredClone(value)); } };
  const secrets = { get: async key => keys.get(key), store: async (key, value) => { keys.set(key, value); }, delete: async key => { keys.delete(key); } };
  return { data, keys, global, secrets, get changes() { return changes; }, set fail(value) { fail = value; }, store: new StudioStore(global, secrets, database(), () => changes++) };
}
test('IDs, display names and parameters are independent and unmatched IDs use defaults', () => {
  const db = validateDatabase(database()), item = model(); item.name = 'Custom Name'; item.overrides = { maxOutputTokens: 64000 };
  assert.equal(modelName(db, item), 'Custom Name'); assert.equal(item.id, 'request-id');
  assert.equal(effectiveParameters(db, item).maxOutputTokens, 64000);
  assert.equal(effectiveParameters(db, model('request-id-suffix')).contextWindow, 128000);
  const unknown = model('unknown'); unknown.discoveredName = 'Provider Friendly Name';
  assert.equal(modelName(db, unknown), 'unknown'); assert.equal(modelName(db, model()), 'Friendly Name');
});
test('configuration rejects invalid budgets, URLs, reserved IDs and duplicate IDs', () => {
  for (const url of ['https://example.com/v1?key=secret', 'file:///invalid', 'https://user:pass@example.com', 'https://example.com/#hash']) assert.throws(() => validateUrl(url));
  const db = database(); assert.throws(() => validateDatabase({ ...db, defaults: { ...defaults, maxOutputTokens: 128000 } }));
  const p = provider(); p.models.push(model()); assert.throws(() => validateProvider(p, db));
  for (const id of ['__proto__', 'constructor', 'prototype', 'two words']) assert.throws(() => validateProvider({ ...p, models: [model(id)] }, db));
  p.models = [model('unknown')]; assert.equal(validateProvider(p, db).models[0].id, 'unknown');
});
test('only supported native protocol fields validate, including aliases, budgets and nullable sampling', () => {
  const protocols = { messages: { effortFormat: 'messages', adaptiveThinking: true, thinkingBudget: { min: 1024, max: 8000 } },
    responses: { effortValues: { none: null, high: 'max' } }, chatCompletions: { effortFormat: 'unsupported', modelOptions: { temperature: null, top_p: 0.95 } } };
  assert.deepEqual(validateProtocols(protocols), protocols);
  for (const invalid of [{ unexpected: {} }, { responses: { effortPath: ['reasoning', 'effort'] } },
    { responses: { parameters: { headers: {} } } }, { responses: { modelOptions: { top_p: 1.01 } } },
    { messages: { thinkingBudget: { min: 100, max: 10 } } }, { messages: { thinkingBudget: { min: 0, max: 10 } } },
    { responses: { effortValues: JSON.parse('{"__proto__":"high"}') } }]) assert.throws(() => validateProtocols(invalid));
});
test('retired fields are discarded without changing native token capacities', () => {
  const input = { ...defaults, source: 'old', verifiedAt: null, contextPricing: { thresholds: [32000] },
    chatCompletionOptions: { maxTokensField: 'max_tokens', includeUsage: false } };
  assert.deepEqual(validateParameters(input), defaults);
  const p = provider(); Object.assign(p, { zeroDataRetentionEnabled: true, statefulResponses: false, zdr: true });
  Object.assign(p.models[0], { zeroDataRetentionEnabled: true, statefulResponses: false, zdr: true, contextSize: 32000 });
  const result = validateProvider(p, database());
  for (const field of ['zeroDataRetentionEnabled', 'statefulResponses', 'zdr']) {
    assert.equal(Object.hasOwn(result, field), false); assert.equal(Object.hasOwn(result.models[0], field), false);
  }
  assert.equal(Object.hasOwn(result.models[0], 'contextSize'), false);
});
test('keys stay in secret storage and an empty input preserves the existing key', async () => {
  const s = storage(); await s.store.saveProvider(provider(), 'secret-canary');
  assert.equal(await s.store.key('provider-one'), 'secret-canary');
  assert.equal(JSON.stringify([...s.data]).includes('secret-canary'), false);
  const ui = await s.store.uiState(); assert.equal(JSON.stringify(ui).includes('secret-canary'), false); assert.equal(ui.providers[0].hasKey, true);
  await s.store.saveProvider({ ...provider(), name: 'Renamed' }, ''); assert.equal(await s.store.key('provider-one'), 'secret-canary');
  await s.store.saveProvider(provider(), undefined, true); assert.equal(await s.store.key('provider-one'), undefined);
});
test('failed persistence rolls back provider creation, key replacement, clearing and deletion', async () => {
  const s = storage(); await s.store.saveProvider(provider(), 'original'); const before = s.store.snapshot(); s.fail = true;
  for (const work of [() => s.store.saveProvider(provider(), 'replacement'), () => s.store.saveProvider(provider(), undefined, true), () => s.store.deleteProvider('provider-one')]) {
    await assert.rejects(work(), /write failed/); assert.equal(await s.store.key('provider-one'), 'original'); assert.deepEqual(s.store.snapshot(), before);
  }
  await assert.rejects(s.store.saveProvider(provider('new'), 'new-secret'), /write failed/);
  assert.equal(await s.store.key('new'), undefined); assert.equal(s.changes, 1);
});
test('invalid provider compilations and conflicting key operations never change persisted state or secrets', async () => {
  const s = storage(); await s.store.saveProvider(provider(), 'original'); const before = s.store.snapshot();
  const p = provider(); p.models[0].reasoningEffort = 'high';
  await assert.rejects(s.store.saveProvider(p, 'replacement'));
  await assert.rejects(s.store.saveProvider(provider(), 'replacement', true));
  assert.equal(await s.store.key('provider-one'), 'original'); assert.deepEqual(s.store.snapshot(), before); assert.equal(s.changes, 1);
});
test('concurrent saves preserve independent providers and disabled settings across restart', async () => {
  const s = storage(); await Promise.all([s.store.saveProvider(provider('one'), 'key-one'), s.store.saveProvider({ ...provider('two'), enabled: false }, 'key-two')]);
  const restarted = new StudioStore(s.global, s.secrets, database(), () => {});
  assert.equal(restarted.snapshot().providers.length, 2); assert.equal(restarted.snapshot().providers[1].enabled, false);
  await restarted.deleteProvider('one'); assert.equal(await restarted.key('one'), undefined); assert.equal(restarted.snapshot().providers.length, 1);
});
test('exportProviders and importProviders roundtrip selected providers, keys, name matching and rollback on write failure', async () => {
  const source = storage();
  await source.store.saveProvider({ ...provider('alpha'), name: 'Alpha Gateway' }, 'alpha-secret');
  await source.store.saveProvider({ ...provider('beta'), name: 'Beta Gateway' }, 'beta-secret');
  const withKeys = await source.store.exportProviders(['alpha', 'beta']);
  assert.equal(withKeys.version, 1);
  assert.equal(withKeys.providers.length, 2);
  assert.equal(withKeys.providers[0].apiKey, 'alpha-secret');
  const selected = await source.store.exportProviders(['alpha']);
  assert.equal(selected.providers.length, 1);
  assert.equal(selected.providers[0].apiKey, 'alpha-secret');
  await assert.rejects(source.store.exportProviders([]), /选择/);
  await assert.rejects(source.store.exportProviders(['missing']), /不存在/);

  const target = storage();
  await target.store.saveProvider({ ...provider('local-alpha'), name: 'Alpha Gateway' }, 'local-secret');
  const importedIds = await target.store.importProviders(JSON.stringify(withKeys));
  assert.deepEqual(importedIds, ['local-alpha', 'beta']);
  assert.equal(target.store.snapshot().providers.length, 2);
  assert.equal(target.store.snapshot().providers[0].id, 'local-alpha');
  assert.equal(await target.store.key('local-alpha'), 'alpha-secret');
  assert.equal(await target.store.key('beta'), 'beta-secret');

  const { apiKey, ...withoutKey } = selected.providers[0];
  assert.deepEqual(await target.store.importProviders({ version: 1, providers: [withoutKey] }), ['local-alpha']);
  assert.equal(await target.store.key('local-alpha'), 'alpha-secret');

  // Failed persistence rolls back secret changes
  target.fail = true;
  await assert.rejects(target.store.importProviders({ version: 1, providers: [{ ...provider('gamma'), name: 'Gamma', apiKey: 'gamma-secret' }] }), /write failed/);
  assert.equal(await target.store.key('gamma'), undefined);
  assert.equal(target.store.snapshot().providers.length, 2);
  target.fail = false;

  // Name conflict with a different existing ID is rejected cleanly
  await assert.rejects(target.store.importProviders({ version: 1, providers: [{ ...provider('local-alpha'), name: 'Beta Gateway' }] }), /冲突/);
  assert.throws(() => parseExportBundle({ version: 2, providers: [] }, database()));
  assert.throws(() => parseExportBundle({ version: 1, providers: [] }, database()));
});

test('import parsing accepts BOM and normalized model IDs but rejects malformed data without exposing it', () => {
  const entry = provider(); entry.models[0].id = ' request-id ';
  const parsed = parseExportBundle('\uFEFF' + JSON.stringify({ version: 1, providers: [entry] }), database());
  assert.equal(parsed[0].models[0].id, 'request-id');
  for (const raw of ['', '{"apiKey":"secret-canary"', 'null', '[]', JSON.stringify([entry, entry])]) {
    assert.throws(() => parseExportBundle(raw, database()), error => !error.message.includes('secret-canary'));
  }
});

test('a failed key write rolls back the entire import before state changes and allows a retry', async () => {
  const s = storage();
  await s.store.saveProvider({ ...provider('alpha'), name: 'Alpha' }, 'old-alpha');
  await s.store.saveProvider({ ...provider('beta'), name: 'Beta' }, 'old-beta');
  const before = s.store.snapshot(), changes = s.changes, writeKey = s.secrets.store;
  let failOnce = true;
  s.secrets.store = async (key, value) => {
    await writeKey(key, value);
    if (failOnce && value === 'new-beta') { failOnce = false; throw Error('key write failed'); }
  };
  const entries = ['alpha', 'beta', 'gamma'].map(id => ({ ...provider(id), name: id === 'alpha' ? 'Alpha' : id === 'beta' ? 'Beta' : 'Gamma', apiKey: `new-${id}` }));
  await assert.rejects(s.store.importProviders(entries), /key write failed/);
  assert.deepEqual(s.store.snapshot(), before); assert.equal(s.changes, changes);
  assert.equal(await s.store.key('alpha'), 'old-alpha'); assert.equal(await s.store.key('beta'), 'old-beta');
  assert.equal(await s.store.key('gamma'), undefined);
  assert.deepEqual(await s.store.importProviders(entries), ['alpha', 'beta', 'gamma']);
  const restarted = new StudioStore(s.global, s.secrets, database(), () => {});
  assert.deepEqual(restarted.snapshot(), s.store.snapshot());
  assert.equal(await restarted.key('beta'), 'new-beta');
  assert.equal(JSON.stringify(restarted.snapshot()).includes('new-beta'), false);
});

test('rollback tries every affected key and reports incomplete recovery explicitly', async () => {
  const s = storage();
  await s.store.saveProvider({ ...provider('alpha'), name: 'Alpha' }, 'old-alpha');
  await s.store.saveProvider({ ...provider('beta'), name: 'Beta' }, 'old-beta');
  const writeKey = s.secrets.store, before = s.store.snapshot();
  s.secrets.store = async (key, value) => {
    if (key.endsWith('.beta')) throw Error('key unavailable');
    return writeKey(key, value);
  };
  await assert.rejects(s.store.importProviders([
    { ...provider('alpha'), name: 'Alpha', apiKey: 'new-alpha' },
    { ...provider('beta'), name: 'Beta', apiKey: 'new-beta' }
  ]), /部分 API Key 未能恢复/);
  assert.equal(await s.store.key('alpha'), 'old-alpha');
  assert.deepEqual(s.store.snapshot(), before);
});

test('imports cannot map two entries onto one local provider', async () => {
  const s = storage();
  await s.store.saveProvider({ ...provider('local-alpha'), name: 'Alpha' }, 'keep-key');
  const before = s.store.snapshot();
  s.secrets.store = async () => assert.fail('Invalid import wrote a key');
  await assert.rejects(s.store.importProviders([
    { ...provider('remote-alpha'), name: 'Alpha', apiKey: 'replacement' },
    { ...provider('local-alpha'), name: 'Renamed', apiKey: 'second-replacement' }
  ]), /冲突/);
  assert.deepEqual(s.store.snapshot(), before);
  assert.equal(await s.store.key('local-alpha'), 'keep-key');
});
