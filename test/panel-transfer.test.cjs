const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { StudioStore } = require('../dist/core/store');
require('../resources/shared/i18n').setLocale('en');

const database = { schemaVersion: 1, models: {}, defaults: { name: '', contextWindow: 128000, maxOutputTokens: 16000,
  toolCalling: true, vision: false, thinking: false, supportsReasoningEffort: [] } };
const provider = (id, name = id) => ({ id, name, enabled: true, apiType: 'responses', url: 'https://example.test/v1',
  models: [{ id: 'custom-model', name: '', discoveredName: '', overrides: {} }] });

function fixture() {
  const values = new Map(), keys = new Map();
  const world = { clipboard: '', file: '', writes: [], opened: undefined, destination: undefined, calls: [], nativeError: undefined };
  const store = new StudioStore({ get: key => values.get(key), update: async (key, value) => values.set(key, structuredClone(value)) }, {
    get: async key => keys.get(key), store: async (key, value) => keys.set(key, value), delete: async key => keys.delete(key)
  }, database, () => {});
  const vscode = {
    env: { clipboard: { readText: async () => world.clipboard, writeText: async text => { world.clipboard = text; } } },
    window: { showOpenDialog: async () => world.opened, showSaveDialog: async () => world.destination },
    workspace: { fs: {
      stat: async () => ({ size: Buffer.byteLength(world.file) }), readFile: async () => Buffer.from(world.file),
      writeFile: async (uri, bytes) => world.writes.push({ uri, content: Buffer.from(bytes).toString('utf8') })
    } }
  };
  const modulePath = path.join(__dirname, '../dist/panel.js'), localRequire = createRequire(modulePath), exports = {};
  vm.compileFunction(fs.readFileSync(modulePath, 'utf8'), ['exports', 'require'], { filename: modulePath })(
    exports, name => name === 'vscode' ? vscode : localRequire(name)
  );
  const replies = [];
  const panel = { webview: { postMessage: async reply => { world.calls.push('reply'); replies.push(reply); } } };
  const settings = new exports.SettingsPanel({}, store, () => ({ dispose() {} }), async id => {
    world.calls.push({ nativeWrite: id });
    if (world.nativeError) throw Error(world.nativeError);
  });
  settings.panel = panel;
  world.store = store;
  world.request = async (command, payload = {}) => {
    await settings.handle({ id: 'test-request', command, payload }, panel);
    return replies.at(-1);
  };
  return world;
}

test('clipboard and file export always carry saved keys and canceling a file dialog writes nothing', async () => {
  const w = fixture();
  await w.store.saveProvider(provider('one'), 'key-one');
  await w.store.saveProvider(provider('two'), 'key-two');
  assert.equal((await w.request('exportProviders', { ids: ['two'], target: 'clipboard' })).ok, true);
  const exported = JSON.parse(w.clipboard).providers;
  assert.equal(exported.length, 1); assert.equal(exported[0].id, 'two'); assert.equal(exported[0].apiKey, 'key-two');
  assert.deepEqual((await w.request('exportProviders', { ids: ['two'], target: 'file' })).data, { canceled: true });
  assert.equal(w.writes.length, 0);
  w.destination = 'selected.json';
  assert.equal((await w.request('exportProviders', { ids: ['two'], target: 'file' })).ok, true);
  assert.deepEqual(JSON.parse(w.writes[0].content).providers, exported);
  assert.equal(w.calls.some(call => typeof call === 'object'), false);
});

test('both import sources validate before saving and the acknowledgement contains resolved local IDs', async () => {
  const w = fixture();
  await w.store.saveProvider(provider('local-id', 'Existing'), 'old-key');
  const incoming = { version: 1, providers: [{ ...provider('remote-id', 'Existing'), apiKey: 'new-key' }, provider('new-id')] };
  w.clipboard = JSON.stringify(incoming);
  const preview = await w.request('readImportSource', { source: 'clipboard' });
  assert.equal(preview.ok, true); assert.equal(preview.data.providers.length, 2);
  assert.equal(await w.store.key('local-id'), 'old-key');
  assert.deepEqual((await w.request('readImportSource', { source: 'file' })).data, { canceled: true });
  w.opened = ['source.json']; w.file = '\uFEFF' + w.clipboard;
  assert.deepEqual((await w.request('readImportSource', { source: 'file' })).data, preview.data);
  const result = await w.request('importProviders', { providers: preview.data.providers });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.importedIds, ['local-id', 'new-id']);
  assert.deepEqual(result.data.state.providers.map(p => p.id), ['local-id', 'new-id']);
  assert.equal(JSON.stringify(result).includes('new-key'), false);
  assert.deepEqual(w.calls.slice(-2), [{ nativeWrite: undefined }, 'reply']);
  assert.equal(await w.store.key('local-id'), 'new-key');
});

test('native write errors report the saved local state and redact every imported key', async () => {
  const w = fixture();
  w.nativeError = 'failed with first-secret and second-secret';
  const result = await w.request('importProviders', { providers: [
    { ...provider('one'), apiKey: 'first-secret' }, { ...provider('two'), apiKey: 'second-secret' }
  ] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Settings were saved, but writing the Chat configuration failed/);
  assert.doesNotMatch(result.error, /first-secret|second-secret/);
  assert.deepEqual(w.store.snapshot().providers.map(p => p.id), ['one', 'two']);
  w.nativeError = undefined;
  assert.equal((await w.request('saveProvider', { provider: w.store.snapshot().providers[0] })).ok, true);
});
