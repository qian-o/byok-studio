const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StudioStore, validateCatalogSnapshot } = require('../dist/core/store');
const { validateProvider, effectiveParameters } = require('../dist/core/configuration');
const { compileOfficialGroup } = require('../dist/core/officialConfig');

const KEY = 'byokStudio.state.v1';
const FIRST = '2026-01-02T03:04:05.000Z', SECOND = '2026-02-03T04:05:06.000Z';
const parameters = changes => ({ name: '', contextWindow: 128000, maxOutputTokens: 16000,
  toolCalling: true, vision: false, thinking: true, supportsReasoningEffort: ['low', 'high'], ...changes });
const database = () => ({ schemaVersion: 1, defaults: parameters(), models: { alpha: parameters({ name: 'Alpha' }) } });
const catalog = (db, updatedAt = FIRST) => ({ source: 'models.dev', updatedAt, database: structuredClone(db) });
const model = (id = 'alpha', overrides = {}) => ({ id, name: '', discoveredName: 'Discovered', overrides });
const provider = (models = [model()], changes = {}) => ({ id: 'supplier', name: 'Supplier', enabled: true,
  routingMode: 'unified', unified: { apiType: 'responses', url: 'https://example.test/v1' }, models, ...changes });
function memory(initial, seed = database()) {
  const values = new Map(initial === undefined ? [] : [[KEY, structuredClone(initial)]]), keys = new Map();
  let writes = 0, changes = 0, fail = false, secretWrites = 0;
  const storage = { get: key => values.get(key), update: async (key, value) => {
    writes++; if (fail) throw new Error('write failed'); values.set(key, structuredClone(value));
  } };
  const secrets = { get: async key => keys.get(key), store: async (key, value) => { secretWrites++; keys.set(key, value); },
    delete: async key => { secretWrites++; keys.delete(key); } };
  const store = new StudioStore(storage, secrets, seed, () => changes++);
  return { store, storage, secrets, values, keys, get writes() { return writes; }, get changes() { return changes; },
    get secretWrites() { return secretWrites; }, set fail(value) { fail = value; } };
}

test('fresh installs use an immutable seed and persist one catalog without duplicate databases', async () => {
  const seed = database(), original = structuredClone(seed), world = memory(undefined, seed);
  seed.defaults.contextWindow = 256000;
  world.store.database().models.alpha.name = 'mutated copy';
  assert.deepEqual(world.store.database(), original);
  await world.store.updateCatalog(catalog(original));
  await world.store.updateCatalog(catalog(original));
  assert.equal(world.writes, 1); assert.equal(world.changes, 1);
  assert.deepEqual(Object.keys(world.store.snapshot()).sort(), ['catalog', 'providers', 'version']);
  const ui = await world.store.uiState();
  assert.deepEqual(ui.catalog, { source: 'models.dev', updatedAt: FIRST });
  assert.deepEqual(ui.database, original); assert.equal(ui.revision, 1);
  assert.equal(world.secretWrites, 0);
});

test('catalog replacement preserves provider overrides, routing, names and secrets across restart', async () => {
  const world = memory();
  await world.store.saveProvider(provider([{ ...model('alpha', { maxOutputTokens: 64000, toolCalling: false, vision: true }), reasoningEffort: 'high' }, model('gpt-automatic')],
    { routingMode: 'split', modelProtocols: { alpha: 'responses' }, endpoints: { responses: 'https://example.test/v1', chatCompletions: '', messages: '' } }), 'secret');
  const before = world.store.snapshot().providers;
  const incoming = database(); incoming.models.alpha.contextWindow = 256000; incoming.models.new = parameters();
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.deepEqual(world.store.database(), incoming);
  assert.deepEqual(world.store.snapshot().providers, before);
  assert.equal(effectiveParameters(world.store.database(), before[0].models[0]).maxOutputTokens, 64000);
  assert.equal(world.secretWrites, 1);
  const restored = new StudioStore(world.storage, world.secrets, database(), () => {});
  assert.deepEqual(restored.snapshot(), world.store.snapshot());
  assert.equal(await restored.key('supplier'), 'secret');
  assert.deepEqual(restored.snapshot().providers[0].modelProtocols, { alpha: 'responses', 'gpt-automatic': 'responses' });
  assert.equal(restored.snapshot().providers[0].models[0].reasoningEffort, 'high');
  assert.equal(JSON.stringify(world.store.snapshot()).includes('secret'), false);
});

test('incompatible models, new IDs, defaults and removed IDs reject the whole update', async () => {
  for (const id of ['alpha', 'unknown', 'newcomer', 'removed']) {
    const initial = database(); initial.models.removed = parameters();
    const world = memory(undefined, initial);
    await world.store.saveProvider(provider([model(id, { maxOutputTokens: 64000 })]));
    const before = world.store.snapshot(), writes = world.writes, incoming = database();
    incoming.models.alpha.contextWindow = 32000; incoming.defaults.contextWindow = 32000;
    incoming.models.newcomer = parameters({ contextWindow: 32000 }); incoming.models.unrelated = parameters({ vision: true });
    await assert.rejects(world.store.updateCatalog(catalog(incoming)), /Supplier/);
    assert.deepEqual(world.store.snapshot(), before); assert.deepEqual(world.store.database(), initial);
    assert.equal(world.writes, writes);
  }
});

test('removed presets use incoming defaults only when all existing overrides still compile', async () => {
  const world = memory(); await world.store.saveProvider(provider());
  const incoming = database(); delete incoming.models.alpha; incoming.defaults.contextWindow = 256000;
  await world.store.updateCatalog(catalog(incoming));
  assert.equal(world.store.database().models.alpha, undefined);
  assert.equal(compileOfficialGroup(world.store.snapshot().providers[0], world.store.database()).models[0].maxInputTokens, 240000);
});

test('catalog changes cannot erase or make selected reasoning levels unrepresentable', async () => {
  for (const patch of [{ thinking: false }, { supportsReasoningEffort: ['low'] },
    { protocols: { responses: { effortFormat: 'unsupported' } } }, { protocols: { responses: { effortValues: { high: null } } } }]) {
    const world = memory(); await world.store.saveProvider(provider([{ ...model(), reasoningEffort: 'high' }]));
    const incoming = database(); Object.assign(incoming.models.alpha, patch);
    const before = world.store.snapshot(), writes = world.writes;
    await assert.rejects(world.store.updateCatalog(catalog(incoming)), /Supplier/);
    assert.deepEqual(world.store.snapshot(), before); assert.equal(world.writes, writes);
  }
});

test('catalog updates validate family assignments and manual split protocols', async () => {
  for (const pinned of [false, true]) {
    const world = memory();
    await world.store.saveProvider(provider([{ ...model(), reasoningEffort: 'high' }], {
      routingMode: 'split', unified: { apiType: 'messages', url: '' }, modelProtocols: pinned ? { alpha: 'responses' } : {},
      endpoints: { responses: 'https://responses.example.test/v1', messages: '', chatCompletions: 'https://chat.example.test/v1' }
    }));
    const before = world.store.snapshot(), writes = world.writes, incoming = database();
    incoming.models.alpha.protocols = { chatCompletions: { effortValues: { high: null } } };
    if (pinned) {
      await world.store.updateCatalog(catalog(incoming));
      assert.deepEqual(world.store.snapshot().providers, before.providers);
      assert.equal(compileOfficialGroup(before.providers[0], world.store.database()).models[0].defaultReasoningEffort, 'high');
    } else {
      await assert.rejects(world.store.updateCatalog(catalog(incoming)), /Supplier/);
      assert.deepEqual(world.store.snapshot(), before); assert.equal(world.writes, writes);
    }
  }
});

test('changing a model protocol cannot silently discard its reasoning selection', async () => {
  const seed = database();seed.defaults.protocols = { messages: { effortValues: { high: null } } };
  const world = memory(undefined, seed);
  await world.store.saveProvider(provider([{ ...model(), reasoningEffort: 'high' }, { ...model('gpt-automatic', { maxOutputTokens: 8192 }), reasoningEffort: 'high' }], {
    routingMode: 'split', modelProtocols: { alpha: 'responses' },
    endpoints: { responses: 'https://responses.example.test/v1', messages: 'https://messages.example.test/v1', chatCompletions: '' }
  }));
  const before = world.store.snapshot(), writes = world.writes, changed = structuredClone(before.providers[0]);
  changed.modelProtocols['gpt-automatic'] = 'messages';
  await assert.rejects(world.store.saveProvider(changed), /gpt-automatic/);
  assert.deepEqual(world.store.snapshot(), before);assert.equal(world.writes, writes);
  changed.modelProtocols['gpt-automatic'] = 'responses';await world.store.saveProvider(changed);
  const restored = new StudioStore(world.storage, world.secrets, seed, () => {});
  assert.deepEqual(restored.snapshot().providers[0], changed);
  assert.ok(compileOfficialGroup(changed, restored.database()).models.every(item => item.apiType === 'responses' && item.defaultReasoningEffort === 'high'));
});

test('thinking budgets are checked even without a selection and for disabled providers', async () => {
  for (const enabled of [true, false]) {
    const world = memory();
    await world.store.saveProvider(provider([model('alpha', { defaultOutputTokens: 512 })],
      { enabled, unified: { apiType: 'messages', url: enabled ? 'https://example.test' : '' } }));
    const incoming = database(); incoming.models.alpha.protocols = { messages: { thinkingBudget: { min: 1024, max: 8000 } } };
    await assert.rejects(world.store.updateCatalog(catalog(incoming)), /Supplier/);
    assert.equal(world.store.snapshot().catalog, undefined);
  }
});

test('provider overrides can keep reasoning and budgets valid when preset capabilities change', async () => {
  const world = memory();
  await world.store.saveProvider(provider([{ ...model('alpha', { thinking: true, supportsReasoningEffort: ['high'] }), reasoningEffort: 'high' }]));
  const incoming = database(); Object.assign(incoming.models.alpha, { thinking: false, supportsReasoningEffort: [] });
  await world.store.updateCatalog(catalog(incoming));
  assert.equal(compileOfficialGroup(world.store.snapshot().providers[0], world.store.database()).models[0].defaultReasoningEffort, 'high');
});

test('failed writes retain the prior catalog, providers and revision and allow a full retry', async () => {
  const world = memory(); await world.store.updateCatalog(catalog(database()));
  const before = world.store.snapshot(), incoming = database(); incoming.models.alpha.vision = true;
  world.fail = true; await assert.rejects(world.store.updateCatalog(catalog(incoming, SECOND)), /write failed/);
  assert.deepEqual(world.store.snapshot(), before); assert.deepEqual(world.values.get(KEY), before);
  world.fail = false; assert.equal((await world.store.uiState()).revision, 1);
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.equal((await world.store.uiState()).revision, 2); assert.equal(world.store.database().models.alpha.vision, true);
});

test('queued provider saves and catalog updates validate against the last committed state', async () => {
  const world = memory(), update = world.storage.update;
  let release, entered;
  const waiting = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
  world.storage.update = async (...args) => { entered(); await waiting; await update(...args); };
  const save = world.store.saveProvider(provider([model('alpha', { maxOutputTokens: 64000 })]));
  await started;
  assert.deepEqual(world.store.snapshot().providers, []);
  const incoming = database(); incoming.models.alpha.contextWindow = 32000;
  const refresh = world.store.updateCatalog(catalog(incoming));
  release(); await save; await assert.rejects(refresh, /Supplier/);
  assert.equal(world.writes, 1); assert.equal(world.store.database().models.alpha.contextWindow, 128000);
  const good = database(); good.models.alpha.contextWindow = 256000;
  await world.store.updateCatalog(catalog(good, SECOND));
  assert.equal(world.writes, 2); assert.equal(world.store.snapshot().providers[0].models[0].overrides.maxOutputTokens, 64000);
});

test('a delayed older update cannot replace a newer catalog committed by another request', async () => {
  const world = memory(), incoming = database(); incoming.models.alpha.contextWindow = 256000;
  const newer = world.store.updateCatalog(catalog(incoming, SECOND));
  const stale = world.store.updateCatalog(catalog(database(), FIRST));
  await newer; await assert.rejects(stale);
  assert.equal(world.writes, 1); assert.equal(world.store.snapshot().catalog.updatedAt, SECOND);
  assert.deepEqual(world.store.database(), incoming);
});

test('snapshot validation rejects malformed timestamps, sources, records and unsupported request injection', () => {
  for (const timestamp of ['2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00+01:00', null]) {
    assert.throws(() => validateCatalogSnapshot(catalog(database(), timestamp)));
  }
  assert.equal(validateCatalogSnapshot(catalog(database(), '2026-01-01T00:00:00Z')).updatedAt, '2026-01-01T00:00:00Z');
  assert.throws(() => validateCatalogSnapshot({ ...catalog(database()), source: 'other' }));
  const bad = database(); bad.models.alpha.protocols = { responses: { parameters: { headers: { authorization: 'secret' } } } };
  assert.throws(() => validateCatalogSnapshot(catalog(bad)));
});
