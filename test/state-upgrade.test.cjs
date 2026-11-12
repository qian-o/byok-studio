const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StudioStore } = require('../dist/core/store');
const { compileOfficialGroup } = require('../dist/core/officialConfig');
const { upgradeDatabase } = require('../dist/core/legacyState');
const KEY = 'byokStudio.state.v1';
const params = { name: '', contextWindow: 128000, maxOutputTokens: 16000, toolCalling: true, vision: false,
  thinking: true, supportsReasoningEffort: ['none', 'low', 'high'] };
const db = () => ({ schemaVersion: 1, defaults: { ...params }, models: { custom: { ...params, name: 'Old name' } } });
const provider = () => ({ id: 'provider', name: 'Provider', enabled: true, apiType: 'responses', url: 'https://example.test',
  models: [{ id: 'custom', name: '', discoveredName: 'Discovery', overrides: { maxOutputTokens: 64000 }, reasoningEffort: 'high' }] });
function world(saved, seed = db()) {
  const values = new Map([[KEY, structuredClone(saved)]]); let fail = false, writes = 0;
  const storage = { get: key => values.get(key), update: async (key, value) => { if (fail) throw Error('write failed'); writes++; values.set(key, structuredClone(value)); } };
  const secrets = { get: async () => 'preserved-key', store: async () => assert.fail('secret changed'), delete: async () => assert.fail('secret deleted') };
  const create = () => new StudioStore(storage, secrets, seed, () => {});
  return { values, create, set fail(value) { fail = value; }, get writes() { return writes; } };
}

test('legacy customized presets and unknown-model defaults become provider overrides and survive restart', async () => {
  const old = db(); old.models.custom.contextWindow = 500000; old.defaults.contextWindow = 400000;
  const p = provider(); p.models.push({ ...p.models[0], id: 'unknown', overrides: { maxOutputTokens: 200000 } });
  const saved = { version: 1, providers: [p], database: old, appliedCatalogUpdates: ['old-history'] };
  const target = db(); delete target.models.custom;
  const w = world(saved, target), store = w.create();
  assert.equal(store.snapshot().providers[0].models[0].overrides.contextWindow, 500000);
  assert.equal(store.snapshot().providers[0].models[0].name, 'Old name');
  assert.equal(store.snapshot().providers[0].models[1].overrides.contextWindow, 400000);
  assert.deepEqual(w.values.get(KEY), saved, 'Construction does not write');
  await store.uiState(); assert.equal(w.writes, 0); assert.deepEqual(w.values.get(KEY), saved);
  await store.saveProvider(store.snapshot().providers[0]); assert.equal(w.writes, 1);
  assert.equal(w.values.get(KEY).database, undefined); assert.equal(w.values.get(KEY).appliedCatalogUpdates, undefined);
  const restarted = w.create(); assert.deepEqual(restarted.snapshot(), store.snapshot());
  assert.equal(await restarted.key('provider'), 'preserved-key');
});

test('saved full protocol maps stay pinned through migration, default changes and later model additions', async () => {
  for (const routingMode of ['unified', 'split']) {
    const p = { ...provider(), routingMode, unified: { apiType: 'responses', url: 'https://unified.example.test/v1' },
      endpoints: { responses: 'https://responses.example.test/v1', chatCompletions: 'https://chat.example.test/v1', messages: 'https://messages.example.test/v1' },
      modelProtocols: { custom: 'responses', 'claude-kept': 'messages', 'gemini-kept': 'chatCompletions' } };
    delete p.apiType; delete p.url;
    p.models.push(...['claude-kept', 'gemini-kept'].map(id => ({ ...p.models[0], id })));
    const saved = { version: 1, providers: [p], database: db() }, w = world(saved), store = w.create();
    const before = compileOfficialGroup(p, db());
    assert.deepEqual(compileOfficialGroup(store.snapshot().providers[0], store.database()), before);
    await store.uiState(); const restarted = w.create(), migrated = restarted.snapshot().providers[0];
    assert.deepEqual(migrated.modelProtocols, p.modelProtocols);
    assert.deepEqual(compileOfficialGroup(migrated, restarted.database()), before);
    migrated.routingMode = 'split'; migrated.unified.apiType = 'messages';
    migrated.models.push({ id: 'gpt-new', name: '', discoveredName: '', overrides: {} });
    await restarted.saveProvider(migrated);
    const final = w.create(), result = final.snapshot().providers[0];
    assert.deepEqual(result.modelProtocols, { ...p.modelProtocols, 'gpt-new': 'responses' });
    assert.deepEqual(compileOfficialGroup(result, final.database()).models.map(m => m.apiType), ['responses', 'messages', 'chat-completions', 'responses']);
    assert.equal(result.models[0].reasoningEffort, 'high');assert.equal(result.models[0].overrides.maxOutputTokens, 64000);
  }
});

test('cached legacy profiles retain effort formats, disabled choices, adaptive thinking, budgets and sampling', async () => {
  const old = db(); old.models.custom.reasoningControls = { note: 'retired', protocols: {
    responses: { effortPath: ['reasoning', 'effort'], effortValues: { high: 'max' } },
    chatCompletions: { effortPath: ['extra_body', 'thinking_level'], parameters: { top_p: 0.95 } },
    messages: { modePath: ['thinking', 'type'], enabledValue: 'adaptive', disabledEfforts: ['none'],
      budgetPath: ['thinking', 'budget_tokens'], budget: { min: 1024, max: 8000, default: 2048 } }
  } };
  const saved = { version: 1, providers: [provider()], database: old,
    catalog: { source: 'models.dev', updatedAt: '2026-01-01T00:00:00Z', database: old } };
  const w = world(saved), store = w.create(); await store.uiState();
  const protocols = store.database().models.custom.protocols;
  assert.deepEqual(protocols.responses, { effortFormat: 'responses', effortValues: { high: 'max' } });
  assert.deepEqual(protocols.chatCompletions, { effortFormat: 'unsupported', modelOptions: { top_p: 0.95 } });
  assert.deepEqual(protocols.messages, { effortValues: { none: null }, adaptiveThinking: true, thinkingBudget: { min: 1024, max: 8000 } });
  assert.equal(compileOfficialGroup(store.snapshot().providers[0], store.database()).models[0].defaultReasoningEffort, 'max');
  assert.deepEqual(w.values.get(KEY), saved); assert.equal(w.writes, 0);
  await store.saveProvider(store.snapshot().providers[0]);
  assert.equal(JSON.stringify(w.values.get(KEY)).includes('reasoningControls'), false);
  assert.deepEqual(w.create().database(), store.database());
});

test('native budget profiles and explicitly budget-mapped effort choices remain distinct', () => {
  const old = db(); old.defaults.reasoningControls = { protocols: { messages: { effortPath: null,
    budgetPath: ['thinking', 'budget_tokens'], budget: { min: 1024, max: 8000, default: 2048 } },
    responses: { budgetByEffort: { high: 4096 } } } };
  const upgraded = upgradeDatabase(old);
  assert.deepEqual(upgraded.defaults.protocols.messages, { effortFormat: 'unsupported', thinkingBudget: { min: 1024, max: 8000 } });
  assert.deepEqual(upgraded.defaults.protocols.responses.effortValues, { high: null });
});

test('legacy chat output caps become a model override instead of silently increasing output', async () => {
  const old = db(); old.models.custom.chatCompletionOptions = { maxTokensField: 'max_tokens', maxOutputTokens: 4096, includeUsage: false };
  const p = provider(); p.apiType = 'chatCompletions';
  const w = world({ version: 1, providers: [p], database: old }), store = w.create();
  assert.equal(store.snapshot().providers[0].models[0].overrides.maxOutputTokens, 4096);
  await store.uiState(); assert.deepEqual(w.create().snapshot(), store.snapshot());
});

test('unrepresentable custom protocol edits fail explicitly and leave raw saved data unchanged', () => {
  const old = db(); old.models.custom.protocols = { responses: { effortValues: { high: 'max' } } };
  const saved = { version: 1, providers: [provider()], database: old };
  const w = world(saved);
  assert.throws(w.create, /custom/); assert.deepEqual(w.values.get(KEY), saved); assert.equal(w.writes, 0);
});

test('invalid saved data and selections are never normalized away or persisted', () => {
  for (const change of [saved => saved.version = 2, saved => saved.database.defaults.contextWindow = 0,
    saved => saved.providers[0].models[0].reasoningEffort = 'missing', saved => saved.providers.push(provider()),
    saved => saved.database.models.custom.reasoningControls = { protocols: { responses: { effortPath: 1 } } }]) {
    const saved = { version: 1, providers: [provider()], database: db() }; change(saved);
    const w = world(saved); assert.throws(w.create); assert.deepEqual(w.values.get(KEY), saved); assert.equal(w.writes, 0);
  }
});

test('reads remain available when writes fail and only an explicit save persists legacy data', async () => {
  const saved = { version: 1, providers: [provider()], database: db() };
  const w = world(saved), store = w.create(); w.fail = true;
  await store.uiState(); await store.uiState(); assert.equal(w.writes, 0);
  await assert.rejects(store.saveProvider(store.snapshot().providers[0]), /write failed/);
  assert.deepEqual(w.values.get(KEY), saved);
  w.fail = false;
  await assert.rejects(store.saveProvider({ ...provider(), name: '' }));
  assert.deepEqual(w.values.get(KEY), saved); assert.equal(w.writes, 0);
  await store.uiState(); assert.equal(w.writes, 0);
  await store.saveProvider(store.snapshot().providers[0]); assert.equal(w.writes, 1); assert.deepEqual(w.create().snapshot(), store.snapshot());
});
