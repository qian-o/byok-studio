const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StudioStore, validateCatalogSnapshot } = require('../dist/core/store');
const { validateProvider, effectiveParameters } = require('../dist/core/configuration');
const { compileOfficialModel } = require('../dist/core/officialConfig');

const STATE_KEY = 'byokStudio.state.v1';
const FIRST = '2026-01-02T03:04:05.000Z';
const SECOND = '2026-02-03T04:05:06.000Z';
const THIRD = '2026-03-04T05:06:07.000Z';
const parameters = (changes = {}) => ({
  name: 'Fixture', contextWindow: 128000, maxOutputTokens: 16000,
  toolCalling: true, vision: false, thinking: true,
  supportsReasoningEffort: ['low', 'high'], source: 'Original source', verifiedAt: null,
  ...structuredClone(changes)
});
const database = () => ({ schemaVersion: 1, defaults: parameters({ name: '' }), models: { alpha: parameters({ name: 'Alpha' }) } });
const catalog = (db, updatedAt = FIRST) => ({ source: 'models.dev', updatedAt, database: structuredClone(db) });
const model = (id = 'alpha', overrides = {}) => ({ id, name: 'My display name', discoveredName: 'Discovered label', overrides });
function provider(db, models = [model()], changes = {}) {
  return validateProvider({
    id: 'supplier', name: 'My supplier', enabled: true, zeroDataRetentionEnabled: true,
    routingMode: 'split', unified: { apiType: 'messages', url: 'https://unified.example/v1' },
    endpoints: { responses: 'https://responses.example/v1', chatCompletions: 'https://chat.example/v1', messages: 'https://messages.example/v1' },
    modelProtocols: Object.fromEntries(models.map(item => [item.id, 'responses'])), models, ...changes
  }, db);
}
function saved(db, baseline = db, providers = []) {
  return { version: 1, database: structuredClone(db), providers, catalog: catalog(baseline), appliedCatalogUpdates: ['historical-update'] };
}
function memory(initial, seed = database()) {
  const values = new Map(initial === undefined ? [] : [[STATE_KEY, structuredClone(initial)]]);
  const keys = new Map([['byokStudio.provider.supplier', 'preserved-secret']]);
  const calls = { get: 0, store: 0, delete: 0 };
  let fail = false, writes = 0, changes = 0;
  const storage = {
    get: key => values.get(key),
    update: async (key, value) => {
      writes++;
      if (fail) throw new Error('write failed');
      values.set(key, structuredClone(value));
    }
  };
  const secrets = {
    get: async key => { calls.get++; return keys.get(key); },
    store: async (key, value) => { calls.store++; keys.set(key, value); },
    delete: async key => { calls.delete++; keys.delete(key); }
  };
  const store = new StudioStore(storage, secrets, seed, () => changes++);
  return { store, storage, secrets, values, keys, calls, get writes() { return writes; }, get changes() { return changes; }, set fail(value) { fail = value; } };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const noKeys = world => assert.deepEqual(world.calls, { get: 0, store: 0, delete: 0 });

test('fresh installs initialize the bundled defaults and cache without applying a legacy baseline', async () => {
  const seed = database();
  seed.defaults = parameters({ name: 'Fresh defaults', contextWindowMode: 'input', contextWindow: 64000, maxOutputTokens: 96000, defaultOutputTokens: 4000 });
  const old = database();
  old.defaults.source = 'Legacy defaults';
  for (const initialBaseline of [undefined, old]) {
    const world = memory(undefined, seed);
    assert.equal(world.store.hasSavedState, false);
    await world.store.updateCatalog(catalog(seed), initialBaseline);
    assert.deepEqual(world.store.snapshot().database, seed);
    assert.deepEqual(world.values.get(STATE_KEY).catalog, catalog(seed));
    assert.equal(world.store.snapshot().appliedCatalogUpdates, undefined);
    const ui = await world.store.uiState();
    assert.deepEqual(ui.catalog, { source: 'models.dev', updatedAt: FIRST });
    assert.equal(Object.hasOwn(ui.catalog, 'database'), false);
    assert.equal(ui.revision, 1);
    await world.store.updateCatalog(catalog(seed));
    assert.equal(world.writes, 1);
    assert.equal(world.changes, 1);
    noKeys(world);
  }
});

test('fresh stores refresh against an immutable constructor seed before cache initialization', async () => {
  const seed = database();
  seed.models.removed = parameters({ name: 'Removed before refresh' });
  const originalSeed = structuredClone(seed);
  const world = memory(undefined, seed);
  const edited = world.store.snapshot().database;
  edited.models.alpha.source = 'My fresh edit';
  edited.defaults.source = 'My fresh default';
  delete edited.models.removed;
  await world.store.saveDatabase(edited);
  const incoming = structuredClone(originalSeed);
  incoming.models.alpha.maxOutputTokens = 32000;
  incoming.models.alpha.source = 'New upstream source';
  incoming.defaults.vision = true;
  incoming.defaults.source = 'New upstream defaults';
  incoming.models.newcomer = parameters({ name: 'New arrival' });
  seed.models.alpha.maxOutputTokens = 32000;
  seed.defaults.vision = true;
  const misleadingLegacy = structuredClone(incoming);
  misleadingLegacy.models.alpha.source = 'My fresh edit';
  await world.store.updateCatalog(catalog(incoming, SECOND), misleadingLegacy);
  const result = world.store.snapshot();
  assert.equal(world.store.hasSavedState, false);
  assert.equal(result.database.models.alpha.maxOutputTokens, 32000);
  assert.equal(result.database.models.alpha.source, 'My fresh edit');
  assert.equal(result.database.defaults.vision, true);
  assert.equal(result.database.defaults.source, 'My fresh default');
  assert.deepEqual(result.database.models.newcomer, incoming.models.newcomer);
  assert.equal(Object.hasOwn(result.database.models, 'removed'), false);
  assert.deepEqual(result.catalog, catalog(incoming, SECOND));
  assert.deepEqual(world.values.get(STATE_KEY), result);
  noKeys(world);
});

test('legacy states require an initial baseline and update untouched fields and new IDs', async () => {
  const baseline = database();
  baseline.models.alpha.maxInputTokens = 100000;
  baseline.models.alpha.releaseDate = '2025-01-01';
  baseline.models.alpha.defaultOutputTokens = 4000;
  const world = memory({ version: 1, database: baseline, providers: [] });
  assert.equal(world.store.hasSavedState, true);
  const incoming = structuredClone(baseline);
  Object.assign(incoming.models.alpha, { name: 'Updated Alpha', contextWindow: 256000, maxOutputTokens: 32000, vision: true, source: 'Upstream source' });
  delete incoming.models.alpha.maxInputTokens;
  delete incoming.models.alpha.releaseDate;
  delete incoming.models.alpha.defaultOutputTokens;
  incoming.models.newcomer = parameters({ name: 'New entry' });
  incoming.models.toString = parameters({ name: 'Own property ID' });
  incoming.defaults.maxOutputTokens = 24000;
  await assert.rejects(world.store.updateCatalog(catalog(incoming, SECOND)));
  assert.equal(world.writes, 0);
  await world.store.updateCatalog(catalog(incoming, SECOND), baseline);
  assert.deepEqual(world.store.snapshot().database, incoming);
  assert.deepEqual(world.store.snapshot().catalog, catalog(incoming, SECOND));
  assert.equal(world.writes, 1);
  noKeys(world);
});

test('manual nested profiles, modes, pricing, source notes and field removals survive successive updates', async () => {
  const baseline = database();
  Object.assign(baseline.models.alpha, {
    contextWindowMode: 'shared', maxInputTokens: 100000,
    reasoningControls: { note: 'Original note', protocols: { responses: { effortValues: { low: 'low', high: 'high' }, modePath: ['thinking', 'type'], enabledValue: 'enabled', disabledValue: 'disabled' } } },
    contextPricing: { kind: 'flat', scope: 'direct-api', thresholds: [], source: 'Original pricing', checkedAt: '2025-01-01', note: 'Original note' },
    chatCompletionOptions: { maxTokensField: 'max_tokens', includeUsage: true }
  });
  const current = structuredClone(baseline);
  Object.assign(current.models.alpha, { name: 'My preset', source: 'My source note', contextWindowMode: 'input', supportsReasoningEffort: ['high', 'low'] });
  current.models.alpha.reasoningControls.note = 'My nested note';
  current.models.alpha.reasoningControls.protocols.responses.enabledValue = 'manual';
  current.models.alpha.contextPricing.note = 'My pricing note';
  current.models.alpha.chatCompletionOptions.includeUsage = false;
  delete current.models.alpha.maxInputTokens;
  const world = memory(saved(current, baseline));
  const incoming = structuredClone(baseline);
  Object.assign(incoming.models.alpha, { name: 'Upstream name', source: 'New source', contextWindowMode: 'shared', vision: true, maxInputTokens: 110000, supportsReasoningEffort: ['low', 'high', 'maximum'] });
  incoming.models.alpha.reasoningControls = { note: 'New note', protocols: { responses: { effortValues: { high: 'maximum' } } } };
  incoming.models.alpha.contextPricing.source = 'New pricing';
  incoming.models.alpha.chatCompletionOptions.maxOutputTokens = 10000;
  await world.store.updateCatalog(catalog(incoming, SECOND));
  const expected = { ...current.models.alpha, vision: true };
  assert.deepEqual(world.store.snapshot().database.models.alpha, expected);
  assert.deepEqual(world.store.snapshot().catalog.database, incoming);
  incoming.models.alpha.source = 'Third upstream source';
  incoming.models.alpha.contextWindow = 256000;
  await world.store.updateCatalog(catalog(incoming, THIRD));
  assert.deepEqual(world.store.snapshot().database.models.alpha, { ...expected, contextWindow: 256000 });
  assert.equal(world.store.snapshot().database.models.alpha.maxInputTokens, undefined);
  noKeys(world);
});

test('structural comparison ignores nested object key order while keeping array order meaningful', async () => {
  const baseline = database();
  baseline.models.alpha.reasoningControls = { note: '', protocols: { responses: { effortValues: { low: 'low', high: 'high' } }, messages: { effortValues: { low: 'low', high: 'high' } } } };
  const current = structuredClone(baseline);
  current.models.alpha.reasoningControls = { protocols: { messages: { effortValues: { high: 'high', low: 'low' } }, responses: { effortValues: { high: 'high', low: 'low' } } }, note: '' };
  current.models.alpha.supportsReasoningEffort.reverse();
  const world = memory(saved(current, baseline));
  const incoming = structuredClone(baseline);
  incoming.models.alpha.reasoningControls.note = 'Updated nested field';
  incoming.models.alpha.reasoningControls.protocols.responses.effortValues.high = 'maximum';
  incoming.models.alpha.supportsReasoningEffort = ['low', 'high', 'maximum'];
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.deepEqual(world.store.snapshot().database.models.alpha.reasoningControls, incoming.models.alpha.reasoningControls);
  assert.deepEqual(world.store.snapshot().database.models.alpha.supportsReasoningEffort, ['high', 'low']);
});

test('manual deletions, custom entries and upstream disappearances never delete working presets', async () => {
  const baseline = database();
  baseline.models.removed = parameters({ name: 'Manually removed' });
  baseline.models.retired = parameters({ name: 'Upstream will omit this' });
  const current = structuredClone(baseline);
  delete current.models.removed;
  current.models.custom = parameters({ name: 'Manual custom model', source: 'Manual source' });
  const world = memory(saved(current, baseline));
  const incoming = structuredClone(baseline);
  delete incoming.models.retired;
  incoming.models.removed.vision = true;
  incoming.models.custom = parameters({ name: 'Upstream ID collision' });
  incoming.models.newcomer = parameters({ name: 'New upstream model' });
  await world.store.updateCatalog(catalog(incoming, SECOND));
  const result = world.store.snapshot();
  assert.equal(Object.hasOwn(result.database.models, 'removed'), false);
  assert.deepEqual(result.database.models.retired, current.models.retired);
  assert.deepEqual(result.database.models.custom, current.models.custom);
  assert.deepEqual(result.database.models.newcomer, incoming.models.newcomer);
  assert.equal(Object.hasOwn(result.catalog.database.models, 'retired'), false);
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.equal(world.writes, 1);
});

test('defaults use the same field merge and preserve manual fields and optional removals', async () => {
  const baseline = database();
  baseline.defaults.maxInputTokens = 100000;
  const current = structuredClone(baseline);
  current.defaults.source = 'My default source';
  current.defaults.contextWindow = 200000;
  delete current.defaults.maxInputTokens;
  const world = memory(saved(current, baseline));
  const incoming = structuredClone(baseline);
  incoming.defaults.source = 'New upstream source';
  incoming.defaults.contextWindow = 256000;
  incoming.defaults.maxOutputTokens = 32000;
  incoming.defaults.vision = true;
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.deepEqual(world.store.snapshot().database.defaults, { ...current.defaults, maxOutputTokens: 32000, vision: true });
});

test('incompatible coupled fields retain the entire record and preserve edits after the cache advances', async () => {
  const baseline = database();
  baseline.models.unrelated = parameters();
  const current = structuredClone(baseline);
  current.models.alpha.contextWindow = 64000;
  current.models.alpha.source = 'Manual source';
  const world = memory(saved(current, baseline));
  const incoming = structuredClone(baseline);
  incoming.models.alpha.maxOutputTokens = 96000;
  incoming.models.alpha.vision = true;
  incoming.models.alpha.source = 'Second source';
  incoming.models.unrelated.vision = true;
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.deepEqual(world.store.snapshot().database.models.alpha, current.models.alpha);
  assert.equal(world.store.snapshot().database.models.unrelated.vision, true);
  assert.deepEqual(world.store.snapshot().catalog.database, incoming);
  incoming.models.alpha.contextWindow = 512000;
  incoming.models.alpha.maxOutputTokens = 32000;
  incoming.models.alpha.source = 'Third source';
  await world.store.updateCatalog(catalog(incoming, THIRD));
  assert.deepEqual(world.store.snapshot().database.models.alpha, current.models.alpha);
});

test('context mode removal falls back when the retained manual output needs independent input semantics', async () => {
  const baseline = database();
  baseline.models.alpha = parameters({ contextWindowMode: 'input', contextWindow: 32000, maxOutputTokens: 16000 });
  const current = structuredClone(baseline);
  current.models.alpha.maxOutputTokens = 64000;
  const incoming = structuredClone(baseline);
  delete incoming.models.alpha.contextWindowMode;
  incoming.models.alpha.source = 'Updated source';
  const world = memory(saved(current, baseline));
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.deepEqual(world.store.snapshot().database.models.alpha, current.models.alpha);
});

test('provider overrides constrain updated records, defaults and new presets without touching keys or routing', async () => {
  const baseline = database();
  baseline.models.unrelated = parameters();
  const configured = provider(baseline, [model('alpha', { maxOutputTokens: 64000, toolCalling: false, vision: true }), model('unknown', { maxOutputTokens: 64000 }), model('newcomer', { maxOutputTokens: 64000 })]);
  const world = memory(saved(baseline, baseline, [configured]));
  const before = world.store.snapshot();
  const incoming = structuredClone(baseline);
  incoming.models.alpha.contextWindow = 32000;
  incoming.models.alpha.source = 'Updated source';
  incoming.defaults.contextWindow = 32000;
  incoming.models.newcomer = parameters({ contextWindow: 32000 });
  incoming.models.unrelated.vision = true;
  await world.store.updateCatalog(catalog(incoming, SECOND));
  const after = world.store.snapshot();
  assert.deepEqual(after.providers, before.providers);
  assert.deepEqual(after.database.models.alpha, baseline.models.alpha);
  assert.deepEqual(after.database.defaults, baseline.defaults);
  assert.equal(Object.hasOwn(after.database.models, 'newcomer'), false);
  assert.equal(after.database.models.unrelated.vision, true);
  assert.deepEqual(after.appliedCatalogUpdates, before.appliedCatalogUpdates);
  assert.deepEqual([...world.keys], [['byokStudio.provider.supplier', 'preserved-secret']]);
  for (const item of after.providers[0].models) assert.doesNotThrow(() => effectiveParameters(after.database, item));
  noKeys(world);
});

test('valid selected reasoning levels and thinking remain usable without resetting provider overrides', async () => {
  for (const replacement of [{ thinking: false }, { supportsReasoningEffort: ['low'] }]) {
    const baseline = database();
    const configured = provider(baseline, [{ ...model(), reasoningEffort: 'high' }]);
    const world = memory(saved(baseline, baseline, [configured]));
    const incoming = structuredClone(baseline);
    Object.assign(incoming.models.alpha, replacement, { source: 'New source' });
    await world.store.updateCatalog(catalog(incoming, SECOND));
    assert.deepEqual(world.store.snapshot().database.models.alpha, baseline.models.alpha);
    assert.deepEqual(world.store.snapshot().providers, [configured]);
    noKeys(world);
  }
  const baseline = database();
  const configured = provider(baseline, [{ ...model('alpha', { thinking: true, supportsReasoningEffort: ['high'] }), reasoningEffort: 'high' }]);
  const world = memory(saved(baseline, baseline, [configured]));
  const incoming = structuredClone(baseline);
  Object.assign(incoming.models.alpha, { thinking: false, supportsReasoningEffort: [], vision: true });
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.deepEqual(world.store.snapshot().database.models.alpha, incoming.models.alpha);
  assert.deepEqual(world.store.snapshot().providers, [configured]);
});

test('catalog changes cannot make a previously representable routed reasoning selection unrepresentable', async () => {
  const incompatibleProfiles = [
    { effortPath: null },
    { effortValues: { high: null } },
    { modePath: ['thinking', 'type'], enabledValue: 'enabled', disabledEfforts: ['high'] },
    { budgetPath: ['thinking', 'budget_tokens'], budget: { min: 16, max: 4096, default: 512 }, budgetByEffort: { high: 2048 } }
  ];
  for (const profile of incompatibleProfiles) {
    const baseline = database();
    const configured = provider(baseline, [{ ...model(), reasoningEffort: 'high' }]);
    const world = memory(saved(baseline, baseline, [configured]));
    const incoming = structuredClone(baseline);
    incoming.models.alpha.reasoningControls = { note: 'Updated protocol', protocols: { responses: profile } };
    assert.throws(() => compileOfficialModel(configured, incoming, configured.models[0]));
    await world.store.updateCatalog(catalog(incoming, SECOND));
    assert.deepEqual(world.store.snapshot().database.models.alpha, baseline.models.alpha);
    assert.doesNotThrow(() => compileOfficialModel(configured, world.store.snapshot().database, configured.models[0]));
    noKeys(world);
  }
});

test('missing selections, other routed protocols and already unsupported selections do not block unrelated updates', async () => {
  for (const scenario of ['no-selection', 'other-protocol', 'already-unsupported']) {
    const baseline = database();
    if (scenario === 'already-unsupported') baseline.models.alpha.reasoningControls = { note: '', protocols: { responses: { effortPath: null } } };
    const item = { ...model(), ...(scenario === 'no-selection' ? {} : { reasoningEffort: 'high' }) };
    const configured = provider(baseline, [item], scenario === 'other-protocol' ? { modelProtocols: { alpha: 'chatCompletions' } } : {});
    const world = memory(saved(baseline, baseline, [configured]));
    const incoming = structuredClone(baseline);
    incoming.models.alpha.reasoningControls = { note: 'Updated note', protocols: { responses: { effortPath: null } } };
    incoming.models.alpha.source = 'Updated source';
    await world.store.updateCatalog(catalog(incoming, SECOND));
    assert.deepEqual(world.store.snapshot().database.models.alpha, incoming.models.alpha, scenario);
    assert.deepEqual(world.store.snapshot().providers, [configured], scenario);
  }
});

test('new Messages budget conflicts retain working records, defaults and fallback presets without an effort selection', async () => {
  const controls = min => ({ note: '', protocols: { messages: { budgetPath: ['thinking', 'budget_tokens'], budget: { min, max: 4096, default: 1024 } } } });
  for (const target of ['existing', 'defaults', 'new']) {
    const baseline = database();
    Object.assign(baseline.defaults, { defaultOutputTokens: 1024, reasoningControls: controls(128) });
    Object.assign(baseline.models.alpha, { defaultOutputTokens: 1024, reasoningControls: controls(128) });
    const id = target === 'existing' ? 'alpha' : 'newcomer';
    const configured = provider(baseline, [model(id, { defaultOutputTokens: 512 })], { modelProtocols: { [id]: 'messages' } });
    const world = memory(saved(baseline, baseline, [configured]));
    const incoming = structuredClone(baseline);
    const changed = target === 'defaults' ? incoming.defaults : target === 'new' ? (incoming.models.newcomer = structuredClone(baseline.defaults)) : incoming.models.alpha;
    changed.reasoningControls = controls(512);
    changed.source = 'Updated budget';
    assert.doesNotThrow(() => compileOfficialModel(configured, baseline, configured.models[0]));
    assert.throws(() => compileOfficialModel(configured, incoming, configured.models[0]));
    await world.store.updateCatalog(catalog(incoming, SECOND));
    const result = world.store.snapshot();
    assert.deepEqual(result.database, baseline, target);
    assert.deepEqual(result.providers, [configured], target);
    assert.deepEqual(result.catalog, catalog(incoming, SECOND), target);
    assert.doesNotThrow(() => compileOfficialModel(configured, result.database, configured.models[0]));
    noKeys(world);
  }
});

test('reducing an output reservation cannot break a working Messages thinking budget', async () => {
  const baseline = database();
  baseline.models.alpha.defaultOutputTokens = 1024;
  baseline.models.alpha.reasoningControls = { note: '', protocols: { messages: { budgetPath: ['thinking', 'budget_tokens'], budget: { min: 128, max: 4096, default: 512 } } } };
  const configured = provider(baseline, [model('alpha', { maxOutputTokens: 512 })], { modelProtocols: { alpha: 'messages' } });
  const world = memory(saved(baseline, baseline, [configured]));
  const incoming = structuredClone(baseline);
  incoming.models.alpha.defaultOutputTokens = 128;
  assert.doesNotThrow(() => compileOfficialModel(configured, baseline, configured.models[0]));
  assert.throws(() => compileOfficialModel(configured, incoming, configured.models[0]));
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.deepEqual(world.store.snapshot().database.models.alpha, baseline.models.alpha);
  assert.deepEqual(world.store.snapshot().providers, [configured]);
  noKeys(world);
});

test('pre-existing budget compilation failures allow unrelated catalog fields to update', async () => {
  const baseline = database();
  baseline.models.alpha.reasoningControls = { note: '', protocols: { messages: { budgetPath: ['thinking', 'budget_tokens'], budget: { min: 1024, max: 4096, default: 1024 } } } };
  const configured = provider(baseline, [model('alpha', { defaultOutputTokens: 512 })], { modelProtocols: { alpha: 'messages' } });
  assert.throws(() => compileOfficialModel(configured, baseline, configured.models[0]));
  const world = memory(saved(baseline, baseline, [configured]));
  const incoming = structuredClone(baseline);
  incoming.models.alpha.source = 'Corrected source';
  incoming.models.alpha.vision = true;
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.deepEqual(world.store.snapshot().database.models.alpha, incoming.models.alpha);
  assert.deepEqual(world.store.snapshot().providers, [configured]);
  noKeys(world);
});

test('invalid snapshots and impossible merged database sizes leave state and cache unchanged', async () => {
  const baseline = database();
  const world = memory(saved(baseline));
  const before = world.store.snapshot();
  const persisted = structuredClone(world.values.get(STATE_KEY));
  const badDatabase = database();
  badDatabase.models.alpha.contextWindow = 1;
  for (const invalid of [{ ...catalog(baseline), source: 'other' }, { ...catalog(baseline), updatedAt: 'not a date' }, catalog(badDatabase)]) {
    await assert.rejects(world.store.updateCatalog(invalid));
    assert.deepEqual(world.store.snapshot(), before);
    assert.deepEqual(world.values.get(STATE_KEY), persisted);
  }
  const emptyBaseline = database();
  emptyBaseline.models = {};
  const current = structuredClone(emptyBaseline);
  current.models.custom = parameters();
  const full = structuredClone(emptyBaseline);
  full.models = Object.fromEntries(Array.from({ length: 20000 }, (_, index) => [`item-${index}`, parameters()]));
  const capped = memory(saved(current, emptyBaseline));
  const cappedBefore = capped.store.snapshot();
  await assert.rejects(capped.store.updateCatalog(catalog(full, SECOND)));
  assert.deepEqual(capped.store.snapshot(), cappedBefore);
  assert.equal(capped.writes, 0);
  assert.equal(world.writes, 0);
  noKeys(world);
  noKeys(capped);
});

test('snapshot validation and cache restoration reject invalid timestamps and sources consistently', async () => {
  const baseline = database();
  const invalidTimes = [undefined, null, 123, '', '2026-01-02', '2026-01-02T03:04:05', '2026-01-02T03:04:05+00:00', '2026-02-30T00:00:00.000Z', '2025-02-29T00:00:00Z', '2026-01-02T24:00:00Z', '2026-01-02T03:04:60Z', ' 2026-01-02T03:04:05Z', '2026-13-01T00:00:00Z'];
  const invalidSnapshots = [...invalidTimes.map(updatedAt => ({ ...catalog(baseline), updatedAt })), ...['Models.dev', '', null].map(source => ({ ...catalog(baseline), source }))];
  const world = memory(saved(baseline));
  for (const invalid of invalidSnapshots) {
    assert.throws(() => validateCatalogSnapshot(invalid));
    assert.throws(() => memory({ ...saved(baseline), catalog: invalid }));
    await assert.rejects(world.store.updateCatalog(invalid));
  }
  for (const updatedAt of ['2024-02-29T00:00:00Z', '2026-01-02T03:04:05.1Z', '2026-01-02T03:04:05.12Z', FIRST]) {
    assert.equal(validateCatalogSnapshot(catalog(baseline, updatedAt)).updatedAt, updatedAt);
  }
  assert.equal(world.writes, 0);
  noKeys(world);
});

test('failed persistence keeps the old database and cache and allows a complete retry', async () => {
  const baseline = database();
  const configured = provider(baseline);
  const world = memory(saved(baseline, baseline, [configured]));
  const before = world.store.snapshot();
  const persisted = structuredClone(world.values.get(STATE_KEY));
  const incoming = structuredClone(baseline);
  incoming.models.alpha.vision = true;
  const update = catalog(incoming, SECOND);
  world.fail = true;
  await assert.rejects(world.store.updateCatalog(update), /write failed/);
  assert.deepEqual(world.store.snapshot(), before);
  assert.deepEqual(world.values.get(STATE_KEY), persisted);
  assert.equal(world.changes, 0);
  world.fail = false;
  await world.store.updateCatalog(update);
  assert.equal(world.store.snapshot().database.models.alpha.vision, true);
  assert.deepEqual(world.values.get(STATE_KEY).catalog, update);
  assert.deepEqual(world.store.snapshot().providers, before.providers);
  assert.equal(world.writes, 2);
  assert.equal(world.changes, 1);
  await world.store.updateCatalog(update);
  assert.equal(world.writes, 2);
  noKeys(world);
});

test('pending provider migrations and catalog updates commit once and retry atomically', async () => {
  const baseline = database();
  const legacyProvider = { id: 'supplier', name: 'Legacy', apiType: 'responses', url: 'https://gateway.example/v1', enabled: true, models: [{ ...model(), zdr: true }] };
  const initial = { version: 1, database: baseline, providers: [legacyProvider] };
  const world = memory(initial);
  const before = world.store.snapshot();
  await assert.rejects(world.store.updateCatalog({ ...catalog(baseline), source: 'invalid' }, baseline));
  assert.equal(world.writes, 0);
  const incoming = structuredClone(baseline);
  incoming.models.alpha.vision = true;
  world.fail = true;
  await assert.rejects(world.store.updateCatalog(catalog(incoming, SECOND), baseline), /write failed/);
  assert.equal(world.writes, 1);
  assert.deepEqual(world.values.get(STATE_KEY), initial);
  assert.deepEqual(world.store.snapshot(), before);
  world.fail = false;
  await world.store.updateCatalog(catalog(incoming, SECOND), baseline);
  const persisted = world.values.get(STATE_KEY);
  assert.equal(world.writes, 2);
  assert.equal(persisted.database.models.alpha.vision, true);
  assert.equal(persisted.providers[0].zeroDataRetentionEnabled, true);
  assert.deepEqual(persisted.catalog, catalog(incoming, SECOND));
  await world.store.updateCatalog(catalog(incoming, SECOND));
  assert.equal(world.writes, 2);
  noKeys(world);
});

test('restarts retain the cache and manual edits instead of forcing the older bundled seed', async () => {
  const baseline = database();
  const current = structuredClone(baseline);
  current.models.alpha.source = 'My source';
  const world = memory(saved(current, baseline));
  const incoming = structuredClone(baseline);
  incoming.models.alpha.vision = true;
  await world.store.updateCatalog(catalog(incoming, SECOND));
  const restarted = new StudioStore(world.storage, world.secrets, baseline, () => {});
  assert.equal(restarted.hasSavedState, true);
  assert.deepEqual(restarted.snapshot(), world.store.snapshot());
  const ui = await restarted.uiState();
  assert.deepEqual(ui.catalog, { source: 'models.dev', updatedAt: SECOND });
  assert.equal(Object.hasOwn(ui.catalog, 'database'), false);
  assert.equal(ui.database.models.alpha.source, 'My source');
  incoming.models.alpha.maxOutputTokens = 32000;
  const misleadingBaseline = structuredClone(incoming);
  misleadingBaseline.models.alpha.source = 'My source';
  await restarted.updateCatalog(catalog(incoming, THIRD), misleadingBaseline);
  assert.equal(restarted.snapshot().database.models.alpha.source, 'My source');
  assert.equal(restarted.snapshot().database.models.alpha.maxOutputTokens, 32000);
  assert.equal(world.writes, 2);
  noKeys(world);
});

test('readonly inputs remain unchanged and repeated equal snapshots do not mutate revision or storage', async () => {
  const baseline = database();
  baseline.models.alpha.reasoningControls = { note: '', protocols: { responses: { effortValues: { low: 'low', high: 'high' } } } };
  const initial = { version: 1, database: structuredClone(baseline), providers: [] };
  const world = memory(initial);
  const incoming = structuredClone(baseline);
  incoming.models.alpha.vision = true;
  const frozenBaseline = freeze(structuredClone(baseline));
  const input = freeze(catalog(incoming, SECOND));
  const expectedInput = structuredClone(input);
  await world.store.updateCatalog(input, frozenBaseline);
  assert.deepEqual(input, expectedInput);
  assert.deepEqual(frozenBaseline, baseline);
  const same = catalog(incoming, SECOND);
  same.database.models.alpha.reasoningControls.protocols.responses.effortValues = { high: 'high', low: 'low' };
  await world.store.updateCatalog(same);
  assert.equal(world.writes, 1);
  assert.equal((await world.store.uiState()).revision, 1);
  await world.store.updateCatalog(catalog(incoming, THIRD));
  assert.equal(world.writes, 2);
  assert.equal((await world.store.uiState()).revision, 2);
  const exposed = world.store.snapshot();
  exposed.catalog.database.models.alpha.source = 'Outside mutation';
  assert.equal(world.store.snapshot().catalog.database.models.alpha.source, baseline.models.alpha.source);
  noKeys(world);
});

test('queued catalog updates use the last committed baseline and expose no state before persistence', async () => {
  const baseline = database();
  const current = structuredClone(baseline);
  current.models.alpha.source = 'Manual source';
  const world = memory(saved(current, baseline));
  const first = structuredClone(baseline);
  first.models.alpha.maxOutputTokens = 32000;
  first.models.alpha.source = 'Second source';
  const second = structuredClone(first);
  second.models.alpha.vision = true;
  second.models.alpha.source = 'Third source';
  const before = world.store.snapshot();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const write = world.storage.update;
  let calls = 0;
  world.storage.update = async (key, value) => {
    if (++calls === 1) { enter(); await waiting; }
    await write(key, value);
  };
  const updateOne = world.store.updateCatalog(catalog(first, SECOND));
  await entered;
  const updateTwo = world.store.updateCatalog(catalog(second, THIRD));
  assert.deepEqual(world.store.snapshot(), before);
  release();
  await Promise.all([updateOne, updateTwo]);
  const result = world.store.snapshot();
  assert.equal(result.database.models.alpha.source, 'Manual source');
  assert.equal(result.database.models.alpha.maxOutputTokens, 32000);
  assert.equal(result.database.models.alpha.vision, true);
  assert.deepEqual(result.catalog, catalog(second, THIRD));
  assert.deepEqual(world.values.get(STATE_KEY), result);
  assert.equal(world.writes, 2);
  assert.equal(world.changes, 2);
  noKeys(world);
});
