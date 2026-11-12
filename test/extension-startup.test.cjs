const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

test('activation and opening settings never write data or apply official configuration', async () => {
  const database = { schemaVersion: 1, defaults: { name: '', contextWindow: 128000, maxOutputTokens: 16000,
    toolCalling: true, vision: false, thinking: false, supportsReasoningEffort: [] }, models: {} };
  const legacy = { version: 1, providers: [{ id: 'fixture', name: 'Fixture', enabled: true, apiType: 'responses', url: 'https://example.test',
    models: [{ id: 'custom', name: '', discoveredName: '', overrides: { maxOutputTokens: 64000 } }] }],
    catalog: { source: 'models.dev', updatedAt: '2026-01-01T00:00:00Z', database } };
  const bundled = structuredClone(legacy.catalog);
  bundled.updatedAt = '2026-02-01T00:00:00Z'; bundled.database.defaults.contextWindow = 32000;
  for (const extensionMode of [1, 2, 3]) for (const saved of [undefined, legacy]) {
    const before = structuredClone(saved), commands = new Map();
    let store, opened = 0;
    const storage = { get: () => saved, update: async () => assert.fail('Activation or opening settings wrote data') };
    const vscode = {
      env: { language: 'en' }, ExtensionMode: { Test: 3 },
      Uri: { joinPath: (...parts) => parts.join('/') },
      EventEmitter: class { event() {} fire() { assert.fail('Activation changed state'); } dispose() {} },
      workspace: { fs: { readFile: async () => Buffer.from(JSON.stringify(bundled)) } },
      window: { showErrorMessage: async () => assert.fail('No automatic update should be attempted') },
      commands: { registerCommand: (name, callback) => { commands.set(name, callback); return {}; } }
    };
    const modulePath = path.join(__dirname, '../dist/extension.js'), localRequire = createRequire(modulePath), exports = {};
    vm.compileFunction(fs.readFileSync(modulePath, 'utf8'), ['exports', 'require'], { filename: modulePath })(exports, name => {
      if (name === 'vscode') return vscode;
      if (name === './stateStorage') return { createStateStorage: async () => storage };
      if (name === './panel') return { SettingsPanel: class {
        constructor(_context, value) { store = value; }
        async open() { opened++; await store.uiState(); }
      } };
      if (name === './officialManager') return { OfficialConfigurationManager: class {
        applyProviders() { assert.fail('Implicit official configuration write'); }
      } };
      return localRequire(name);
    });
    const api = await exports.activate({ extensionUri: 'fixture', extensionMode, secrets: { get: async () => undefined }, subscriptions: [] });
    await api.openSettings(); await commands.get('byokStudio.manage')();
    assert.equal(opened, 2); assert.deepEqual(saved, before);
    assert.equal(store.database().defaults.contextWindow, saved ? 128000 : 32000);
    assert.equal(store.snapshot().catalog?.updatedAt, saved?.catalog.updatedAt);
  }
  const manifest = require('../package.json');
  assert.deepEqual(manifest.activationEvents ?? [], []);
});
