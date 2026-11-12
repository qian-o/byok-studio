const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { StudioStore } = require('../dist/core/store');
const { listGroups } = require('../dist/core/officialJson');
const { setLocale } = require('../resources/shared/i18n.js');

const BINDINGS_KEY = 'byokStudio.officialBindings.v1';
const ADD_GROUP = 'lm.addLanguageModelsProviderGroup';
const OLD_REFERENCE = '${input:chat.lm.secret.old-fixture}';
const MANUAL_REFERENCE = '${input:chat.lm.secret.manual-fixture}';
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const database = () => ({ schemaVersion: 1, models: {}, defaults: {
  name: '', contextWindow: 128000, maxOutputTokens: 16000, toolCalling: true,
  vision: false, thinking: false, supportsReasoningEffort: [], source: '', verifiedAt: null
} });
const provider = (id = 'owned') => ({
  id, name: `Gateway ${id}`, enabled: true, apiType: 'responses', url: 'https://example.test/v1',
  models: [{ id: 'sample', name: '', discoveredName: '', overrides: {} }]
});
const group = (id = 'owned', apiKey) => ({
  vendor: 'customendpoint', name: `Gateway ${id}`, byokStudioId: id, models: [],
  ...(apiKey === undefined ? {} : { apiKey })
});
const legacyGroup = id => ({ vendor: 'byok-studio', name: `Legacy ${id}`, providerId: id, byokStudioGroupName: `Legacy ${id}` });

class MockUri {
  constructor(uriPath, scheme = 'file') { this.path = uriPath; this.scheme = scheme; this.authority = ''; }
  with(changes) { return Object.assign(new MockUri(this.path, this.scheme), changes); }
  static joinPath(uri, ...parts) { return uri.with({ path: path.posix.join(uri.path, ...parts) }); }
}

async function fixture({ providers = [provider()], groups = [group('owned', OLD_REFERENCE)], bindings = {}, key } = {}) {
  const globals = new Map([[BINDINGS_KEY, structuredClone(bindings)]]);
  const keys = new Map();
  const backups = new Map();
  const world = {
    globals, keys, ready: true, dirty: false, failNativeWrite: false,
    text: JSON.stringify(groups), events: [], additions: 0
  };
  const globalState = {
    get: (name, fallback) => globals.has(name) ? structuredClone(globals.get(name)) : fallback,
    update: async (name, value) => {
      globals.set(name, structuredClone(value));
      world.events.push({ type: 'persist', name, value: structuredClone(value) });
    }
  };
  const secrets = {
    get: async name => keys.get(name),
    store: async (name, value) => { keys.set(name, value); },
    delete: async name => { keys.delete(name); }
  };
  const globalStorageUri = new MockUri('/profile/User/globalStorage/byok-studio');
  const nativeUri = new MockUri('/profile/User/chatLanguageModels.json', 'vscode-userdata');
  const document = {
    uri: nativeUri, version: 1,
    get isDirty() { return world.dirty; },
    getText: () => world.editorText ?? world.text,
    positionAt: offset => offset,
    save: async () => {
      if (world.refuseSave) return false;
      await vscode.workspace.fs.writeFile(nativeUri, Buffer.from(document.getText()));
      world.editorText = undefined;
      world.dirty = false;
      return true;
    }
  };
  const vscode = {
    Uri: MockUri, FileType: { File: 1 },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { set(uri, edits) { this.uri = uri; this.text = edits[0].newText; } },
    TextEdit: { replace: (range, newText) => ({ range, newText }), setEndOfLine: newEol => ({ newEol }) },
    EndOfLine: { LF: 1, CRLF: 2 },
    lm: { selectChatModels: async selector => {
      assert.equal(selector.vendor, 'customendpoint');
      world.events.push({ type: 'refresh', models: structuredClone(world.chatModels ?? []) });
      if (world.failRefresh) throw new Error('fixture model refresh failure');
      return world.chatModels ?? [];
    } },
    extensions: { getExtension: () => {
      world.events.push({ type: 'ready', bindings: structuredClone(globals.get(BINDINGS_KEY)) });
      return world.ready ? { activate: async () => {} } : undefined;
    } },
    commands: {
      getCommands: async () => [ADD_GROUP],
      executeCommand: async (command, incoming) => {
        assert.equal(command, ADD_GROUP);
        world.additions++;
        const apiKey = '${input:chat.lm.secret.new-fixture-' + world.additions + '}';
        world.text = JSON.stringify([...listGroups(world.text), { ...incoming, apiKey }]);
        document.version++;
      }
    },
    workspace: {
      textDocuments: [document], openTextDocument: async () => document,
      applyEdit: async edit => {
        assert.equal(edit.uri.path, nativeUri.path);
        if (world.refuseEdit) return false;
        world.events.push({ type: 'edit' });
        world.editorText = edit.text;
        world.dirty = true;
        document.version++;
        return true;
      },
      fs: {
        readFile: async uri => {
          assert.equal(uri.path, nativeUri.path);
          return Buffer.from(world.text);
        },
        writeFile: async (uri, bytes) => {
          if (uri.path !== nativeUri.path) { backups.set(uri.path, Buffer.from(bytes)); return; }
          world.events.push({ type: 'write', bindings: structuredClone(globals.get(BINDINGS_KEY)) });
          if (world.failNativeWrite) throw new Error('fixture native write failure');
          // Like VS Code, the configuration watcher consumes the text model at the time of the file event.
          world.chatModels = listGroups(document.getText()).filter(group => group.vendor === 'customendpoint').flatMap(group => group.models ?? []);
          world.text = Buffer.from(bytes).toString('utf8');
          document.version++;
        },
        createDirectory: async () => {},
        readDirectory: async folder => [...backups.keys()].filter(name => name.startsWith(folder.path + '/')).map(name => [path.posix.basename(name), 1]),
        delete: async uri => { backups.delete(uri.path); }
      }
    },
    window: { showTextDocument: async () => {} }
  };
  const modulePath = path.join(__dirname, '../dist/officialManager.js');
  const localRequire = createRequire(modulePath);
  const exports = {};
  vm.compileFunction(fs.readFileSync(modulePath, 'utf8'), ['exports', 'require'], { filename: modulePath })(
    exports, name => name === 'vscode' ? vscode : localRequire(name)
  );
  const context = { globalState, globalStorageUri };
  world.restart = () => {
    world.editorText = undefined;
    world.dirty = false;
    world.store = new StudioStore(globalState, secrets, database(), () => {});
    world.manager = new exports.OfficialConfigurationManager(context, world.store);
  };
  world.restart();
  for (const item of providers) await world.store.saveProvider(item, key);
  world.events.length = 0;
  world.bindings = () => globals.get(BINDINGS_KEY);
  world.nativeGroup = id => listGroups(world.text).find(item => item.byokStudioId === id);
  return world;
}

beforeEach(() => setLocale('en'));

test('legacy cleanup removes only current provider IDs or persisted bindings', async () => {
  const foreignLegacy = { ...legacyGroup('untracked'), apiKey: 'opaque-manual-value', custom: { keep: true } };
  const foreignNative = { ...group('untracked-native', MANUAL_REFERENCE), custom: { keep: true } };
  const incompleteLegacy = { vendor: 'byok-studio', providerId: 'owned', custom: 'no identity marker' };
  const world = await fixture({
    groups: [legacyGroup('owned'), legacyGroup('retired'), foreignLegacy, foreignNative, incompleteLegacy],
    bindings: { retired: {} }
  });
  await world.manager.synchronize();
  const groups = JSON.parse(world.text);
  assert.equal(groups.some(item => item.vendor === 'byok-studio' && ['owned', 'retired'].includes(item.providerId) && item.byokStudioGroupName), false);
  assert.deepEqual(groups.find(item => item.providerId === 'untracked'), foreignLegacy);
  assert.deepEqual(groups.find(item => item.byokStudioId === 'untracked-native'), foreignNative);
  assert.ok(world.text.includes(JSON.stringify(foreignLegacy)));
  assert.ok(world.text.includes(JSON.stringify(foreignNative)));
  assert.deepEqual(groups.find(item => item.custom === 'no identity marker'), incompleteLegacy);
  assert.ok(world.nativeGroup('owned'));
  assert.equal(world.bindings().retired, undefined);
});

test('clearing a key survives a dirty native file and an extension restart', async () => {
  const world = await fixture({ key: 'old-fixture-key', bindings: {
    owned: { keyFingerprint: fingerprint('old-fixture-key'), secretReference: OLD_REFERENCE }
  } });
  await world.store.saveProvider(provider(), undefined, true);
  world.dirty = true;
  await assert.rejects(world.manager.synchronize('owned'), /unsaved changes/);
  assert.equal(await world.store.key('owned'), undefined);
  assert.equal(world.bindings().owned.clearKeyPending, true);
  assert.equal(world.events.find(event => event.type === 'ready').bindings.owned.clearKeyPending, true);
  assert.equal(world.nativeGroup('owned').apiKey, OLD_REFERENCE);

  world.restart();
  world.dirty = false;
  await world.manager.synchronize();
  assert.equal(world.nativeGroup('owned').apiKey, undefined);
  assert.equal(world.bindings().owned.clearKeyPending, undefined);
  assert.equal(world.bindings().owned.keyFingerprint, undefined);
  assert.equal(world.bindings().owned.secretReference, undefined);
  assert.equal(world.events.find(event => event.type === 'write').bindings.owned.clearKeyPending, true);
  assert.equal(world.additions, 0);

  world.restart();
  await world.manager.synchronize();
  assert.equal(world.nativeGroup('owned').apiKey, undefined);
});

test('clear intent is recorded before checking whether Copilot is available', async () => {
  const world = await fixture({ groups: [group('owned', MANUAL_REFERENCE)] });
  await world.store.saveProvider(provider(), undefined, true);
  world.ready = false;
  await assert.rejects(world.manager.synchronize('owned'), /Install or enable/);
  assert.equal(world.bindings().owned.clearKeyPending, true);
  assert.equal(world.nativeGroup('owned').apiKey, MANUAL_REFERENCE);

  world.restart();
  world.ready = true;
  await world.manager.synchronize();
  assert.equal(world.nativeGroup('owned').apiKey, undefined);
  assert.equal(world.bindings().owned.clearKeyPending, undefined);
});

test('failed native writes keep clear intent until a restart can finish the write', async () => {
  const world = await fixture({ bindings: {
    owned: { keyFingerprint: fingerprint('removed-fixture-key'), secretReference: OLD_REFERENCE }
  } });
  world.failNativeWrite = true;
  await assert.rejects(world.manager.synchronize('owned'), /fixture native write failure/);
  assert.equal(world.bindings().owned.clearKeyPending, true);
  assert.equal(world.nativeGroup('owned').apiKey, OLD_REFERENCE);

  world.restart();
  world.failNativeWrite = false;
  await world.manager.synchronize();
  assert.equal(world.nativeGroup('owned').apiKey, undefined);
  assert.equal(world.bindings().owned.clearKeyPending, undefined);
});

test('ordinary synchronization preserves a native key never managed by Studio', async () => {
  const world = await fixture({ groups: [group('owned', MANUAL_REFERENCE)] });
  await world.manager.synchronize();
  assert.equal(world.nativeGroup('owned').apiKey, MANUAL_REFERENCE);
  assert.equal(world.bindings().owned.keyFingerprint, undefined);
  assert.equal(world.bindings().owned.clearKeyPending, undefined);

  world.restart();
  await world.manager.synchronize();
  assert.equal(world.nativeGroup('owned').apiKey, MANUAL_REFERENCE);
  assert.equal(world.additions, 0);
});

test('a replacement saved after a pending clear is published instead of being erased', async () => {
  const world = await fixture({ bindings: {
    owned: { keyFingerprint: fingerprint('removed-fixture-key'), secretReference: OLD_REFERENCE }
  } });
  world.dirty = true;
  await assert.rejects(world.manager.synchronize('owned'), /unsaved changes/);
  assert.equal(world.bindings().owned.clearKeyPending, true);
  await world.store.saveProvider(provider(), 'replacement-fixture-key');

  world.restart();
  world.dirty = false;
  await world.manager.synchronize();
  assert.equal(world.nativeGroup('owned').apiKey, '${input:chat.lm.secret.new-fixture-1}');
  assert.equal(world.bindings().owned.keyFingerprint, fingerprint('replacement-fixture-key'));
  assert.equal(world.bindings().owned.clearKeyPending, undefined);
  assert.equal(world.additions, 1);
  assert.equal(world.text.includes('replacement-fixture-key'), false);
});

test('disabling a provider with a pending clear removes its group before discarding intent', async () => {
  const world = await fixture();
  world.dirty = true;
  await assert.rejects(world.manager.synchronize('owned'), /unsaved changes/);
  await world.store.saveProvider({ ...provider(), enabled: false });

  world.restart();
  world.dirty = false;
  await world.manager.synchronize();
  assert.equal(world.nativeGroup('owned'), undefined);
  assert.equal(world.bindings().owned, undefined);
  assert.equal(world.events.find(event => event.type === 'write').bindings.owned.clearKeyPending, true);
});

test('creation, update and protocol switches omit both Responses fields unless already present', async () => {
  const world = await fixture({ groups: [] });
  for (const apiType of ['responses', 'chatCompletions', 'messages', 'responses']) {
    await world.store.saveProvider({ ...provider(), name: `Updated ${apiType}`, apiType,
      zeroDataRetentionEnabled: true, statefulResponses: false });
    await world.manager.synchronize();
    const native = world.nativeGroup('owned').models[0];
    for (const field of ['zeroDataRetentionEnabled', 'statefulResponses']) assert.equal(Object.hasOwn(native, field), false);
    const text = world.text, writes = world.events.filter(item => item.type === 'write').length;
    await world.manager.synchronize();
    assert.equal(world.text, text); assert.equal(world.events.filter(item => item.type === 'write').length, writes);
  }
});

test('saving updates the text model before publishing and refreshing native chat models', async () => {
  const world = await fixture({ groups: [] });
  await world.manager.synchronize();
  assert.deepEqual(world.chatModels.map(({ id, name }) => ({ id, name })), [{ id: 'sample', name: 'sample' }]);
  assert.ok(world.events.findIndex(event => event.type === 'edit') < world.events.findIndex(event => event.type === 'write'));
  assert.equal(world.events.at(-1).type, 'refresh');

  await world.store.saveProvider({ ...provider(), models: [{ id: 'second', name: 'Renamed', overrides: {} }] });
  await world.manager.synchronize();
  assert.deepEqual(world.chatModels.map(({ id, name }) => ({ id, name })), [{ id: 'second', name: 'Renamed' }]);
  await world.store.deleteProvider('owned');
  await world.manager.synchronize();
  assert.deepEqual(world.chatModels, []);
});

test('imported keys are detected by fingerprint without forcing repeated provisioning', async () => {
  const world = await fixture({ providers: [provider('one'), provider('two')], groups: [], key: 'old-key' });
  await world.manager.synchronize();
  const before = world.additions;
  const incoming = [provider('one'), provider('two')].map(p => ({ ...p, apiKey: `updated-${p.id}` }));
  assert.deepEqual(await world.store.importProviders(incoming), ['one', 'two']);
  await world.manager.synchronize();
  assert.equal(world.additions, before + 2);
  for (const p of incoming) assert.equal(world.bindings()[p.id].keyFingerprint, fingerprint(p.apiKey));
  await world.store.importProviders(incoming);
  await world.manager.synchronize();
  assert.equal(world.additions, before + 2);
});

test('failed edits, saves and refreshes never report a successful synchronization', async () => {
  for (const flag of ['refuseEdit', 'refuseSave', 'failRefresh']) {
    const world = await fixture();
    const before = world.text;
    world[flag] = true;
    await assert.rejects(world.manager.synchronize(), /save the official|refresh failure/);
    if (flag !== 'failRefresh') {
      assert.equal(world.text, before);
      assert.equal(world.events.some(event => event.type === 'refresh'), false);
    }
  }
});

test('manual Responses fields survive updates, protocol switches, restart and idempotent synchronization', async () => {
  for (const manual of [{ zeroDataRetentionEnabled: true }, { statefulResponses: false },
    { zeroDataRetentionEnabled: false, statefulResponses: true }, { zeroDataRetentionEnabled: true, statefulResponses: false }]) {
    const owned = { ...group(), models: [{ id: 'sample', ...manual, futureOption: 'keep' }] };
    const world = await fixture({ groups: [owned] });
    for (const apiType of ['responses', 'messages', 'chatCompletions', 'responses']) {
      await world.store.saveProvider({ ...provider(), apiType });
      world.restart(); await world.manager.synchronize();
      const native = world.nativeGroup('owned').models[0];
      for (const field of ['zeroDataRetentionEnabled', 'statefulResponses']) {
        assert.equal(Object.hasOwn(native, field), Object.hasOwn(manual, field));
        assert.equal(native[field], manual[field]);
      }
      assert.equal(native.futureOption, 'keep');
      const text = world.text; await world.manager.synchronize(); assert.equal(world.text, text);
    }
  }
});

test('native write failure preserves manual Responses settings until a retry succeeds', async () => {
  const world = await fixture({ groups: [{ ...group(), models: [{ id: 'sample', zeroDataRetentionEnabled: false, statefulResponses: true }] }] });
  const before = world.text; world.failNativeWrite = true;
  await assert.rejects(world.manager.synchronize(), /fixture native write failure/);
  assert.equal(world.text, before);
  world.restart(); world.failNativeWrite = false; await world.manager.synchronize();
  const native = world.nativeGroup('owned').models[0];
  assert.equal(native.zeroDataRetentionEnabled, false); assert.equal(native.statefulResponses, true);
});
