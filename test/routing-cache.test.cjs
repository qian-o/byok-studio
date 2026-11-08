const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const routing = require('../resources/shared/routing.js');
const { validateProvider } = require('../dist/core/configuration');
const { setLocale } = require('../resources/shared/i18n.js');

const database = { schemaVersion: 1, models: {}, defaults: {
  name: '', contextWindow: 128000, maxOutputTokens: 16000, toolCalling: true,
  vision: false, thinking: false, supportsReasoningEffort: [], source: '', verifiedAt: null
} };
const models = ['gpt-5', 'claude-sonnet-4-5', 'gemini-2.5-pro'].map(id => ({ id, name: '', discoveredName: '', overrides: {} }));

beforeEach(() => setLocale('en'));

test('cached routes match ordinary routes across unified, split, and legacy routing', () => {
  const configurations = [
    { models, apiType: 'messages', url: 'https://legacy.example.test', zeroDataRetentionEnabled: true },
    { models, routingMode: 'unified', unified: { apiType: 'responses', url: 'https://unified.example.test' }, endpoints: { messages: 'https://messages.example.test' } },
    { models, routingMode: 'split', endpoints: { responses: 'https://responses.example.test', chatCompletions: 'https://chat.example.test', messages: 'https://messages.example.test' }, modelProtocols: { 'gpt-5': 'messages' }, vendorProtocols: { google: 'responses' }, zeroDataRetentionEnabled: true }
  ];
  for (const provider of configurations) {
    const cached = routing.normalizeRouting(provider);
    const before = structuredClone(cached);
    for (const model of [...models, { id: 'unlisted-fixture' }]) {
      assert.deepEqual(routing.routeForModel(provider, model.id, cached), routing.routeForModel(provider, model.id));
    }
    assert.deepEqual(cached, before);
  }
});

test('using cached routing does not read or scan the provider model list', () => {
  const provider = { models, routingMode: 'split', endpoints: { messages: 'https://messages.example.test' }, modelProtocols: Object.fromEntries(models.map(model => [model.id, 'messages'])) };
  const cached = routing.normalizeRouting(provider);
  const guarded = { ...provider, get models() { throw new Error('Model list must not be rescanned'); } };
  for (const model of models) {
    assert.deepEqual(routing.routeForModel(guarded, model.id, cached), {
      apiType: 'messages', url: 'https://messages.example.test', zeroDataRetentionEnabled: false
    });
  }
  guarded.zeroDataRetentionEnabled = true;
  assert.equal(routing.routeForModel(guarded, models[0].id, cached).zeroDataRetentionEnabled, true);
});

test('validating a provider does not rescan the whole model list for each route', context => {
  const original = routing.routeForModel;
  let routeCalls = 0;
  let modelListReads = 0;
  context.mock.method(routing, 'routeForModel', (provider, ...routeArgs) => {
    routeCalls++;
    const observed = new Proxy(provider, { get(target, property, receiver) {
      if (property === 'models') modelListReads++;
      return Reflect.get(target, property, receiver);
    } });
    return original(observed, ...routeArgs);
  });
  const entries = Array.from({ length: 200 }, (_, index) => ({ id: `fixture-${index}`, name: `Model ${index}`, discoveredName: '', overrides: { toolCalling: index % 2 === 0 } }));
  const protocols = Object.fromEntries(entries.map((model, index) => [model.id, routing.apiTypes[index % routing.apiTypes.length]]));
  for (const routingMode of ['unified', 'split']) {
    const provider = {
      id: 'fixture', name: 'Fixture gateway', enabled: true, zeroDataRetentionEnabled: true, routingMode,
      unified: { apiType: 'responses', url: 'https://unified.example.test/v1' },
      endpoints: { responses: 'https://responses.example.test/v1', chatCompletions: 'https://chat.example.test/v1', messages: 'https://messages.example.test/v1' },
      models: entries, modelProtocols: protocols
    };
    const before = structuredClone(provider);
    const validated = validateProvider(provider, database);
    assert.deepEqual(validated.models, entries);
    assert.deepEqual(validated.modelProtocols, protocols);
    assert.equal(validated.zeroDataRetentionEnabled, true);
    assert.deepEqual(provider, before);
  }
  assert.equal(routeCalls, entries.length * 2);
  assert.equal(modelListReads, 0);
});
