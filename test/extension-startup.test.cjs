const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

test('an incompatible bundled refresh reports failure while keeping saved providers and settings available', async () => {
  const database = { schemaVersion: 1, defaults: { name: '', contextWindow: 128000, maxOutputTokens: 16000,
    toolCalling: true, vision: false, thinking: false, supportsReasoningEffort: [] }, models: {} };
  const saved = { version: 1, providers: [{ id: 'fixture', name: 'Fixture', enabled: true, apiType: 'responses', url: 'https://example.test',
    models: [{ id: 'custom', name: '', discoveredName: '', overrides: { maxOutputTokens: 64000 } }] }],
    catalog: { source: 'models.dev', updatedAt: '2026-01-01T00:00:00Z', database } };
  const before = structuredClone(saved), incoming = structuredClone(saved.catalog);
  incoming.updatedAt = '2026-02-01T00:00:00Z'; incoming.database.defaults.contextWindow = 32000;
  const errors = [], commands = []; let writes = 0, opened = false;
  const storage = { get: () => saved, update: async () => { writes++; assert.fail('Rejected refresh cannot persist state'); } };
  const vscode = {
    env: { language: 'en' }, ExtensionMode: { Test: 3 },
    Uri: { joinPath: (...parts) => parts.join('/') },
    EventEmitter: class { event() {} fire() {} dispose() {} },
    workspace: { fs: { readFile: async () => Buffer.from(JSON.stringify(incoming)) } },
    window: { showErrorMessage: async message => errors.push(message) },
    commands: { registerCommand: name => { commands.push(name); return {}; } }
  };
  const modulePath = path.join(__dirname, '../dist/extension.js'), localRequire = createRequire(modulePath), exports = {};
  vm.compileFunction(fs.readFileSync(modulePath, 'utf8'), ['exports', 'require'], { filename: modulePath })(exports, name => {
    if (name === 'vscode') return vscode;
    if (name === './stateStorage') return { createStateStorage: async () => storage };
    if (name === './panel') return { SettingsPanel: class { async open() { opened = true; } } };
    if (name === './officialManager') return { OfficialConfigurationManager: class {} };
    return localRequire(name);
  });
  const api = await exports.activate({ extensionUri: 'fixture', extensionMode: 3, secrets: {}, subscriptions: [] });
  assert.equal(errors.length, 1); assert.match(errors[0], /Fixture/);
  assert.equal(writes, 0); assert.deepEqual(saved, before);
  assert.equal(api.store.database().defaults.contextWindow, 128000);
  assert.equal(api.store.snapshot().providers[0].models[0].overrides.maxOutputTokens, 64000);
  assert.ok(commands.includes('byokStudio.manage')); await api.openSettings(); assert.equal(opened, true);
});
