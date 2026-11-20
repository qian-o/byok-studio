'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ConfigService } = require('../dist/configService');
const { buildModelCatalog, emptyCatalogSnapshot } = require('../dist/catalogBuilder');
const { groupIdentity, parseImportData } = require('../dist/models');

function nativeGroup(id, providerId, name) {
  return {
    name: `${providerId} · ${name}`,
    vendor: 'customendpoint',
    byokStudioId: id,
    byokStudioProviderId: providerId,
    byokStudioProviderName: providerId,
    byokStudioGroupName: name,
    apiKey: `\${input:chat.lm.secret.${id}}`,
    models: []
  };
}

function fixture(groups, readCatalog = async () => emptyCatalogSnapshot().database) {
  let text = JSON.stringify(groups, null, 2) + '\n';
  let hints = {};
  let rejectWrite = false;
  let rejectNextWrite = false;
  let rejectNextHints = false;
  let rejectNextRefresh = false;
  let refreshes = 0;
  const secrets = new Map();
  const writes = [];
  const deletedKeys = [];
  const provisions = [];
  for (const group of groups) {
    const id = groupIdentity(group);
    if (!id) continue;
    secrets.set(id, `test-key-${id}`);
    hints[id] = {
      routingMode: 'unified',
      unified: { apiType: 'chatCompletions', url: 'https://example.test/v1' },
      endpoints: { responses: '', chatCompletions: '', messages: '' }
    };
  }
  const service = new ConfigService({
    readCatalog,
    async readOfficialText() { return text; },
    async writeOfficialText(expected, next) {
      assert.equal(expected, text);
      if (rejectWrite || rejectNextWrite) {
        rejectNextWrite = false;
        throw new Error('Concurrent modification');
      }
      writes.push(next);
      text = next;
    },
    async provisionSecretReference(id, key, expected) {
      assert.equal(expected, text);
      const stageId = `stage-${provisions.length + 1}`;
      const reference = `\${input:chat.lm.secret.${stageId}}`;
      provisions.push({ id, key });
      text = JSON.stringify([...JSON.parse(text), {
        name: stageId, vendor: 'customendpoint', byokStudioId: stageId, models: [], apiKey: reference
      }], null, 2) + '\n';
      return { currentText: text, reference };
    },
    async refreshChatModels() {
      refreshes++;
      if (rejectNextRefresh) {
        rejectNextRefresh = false;
        throw new Error('Cannot refresh models');
      }
    },
    async getSecret(id) { return secrets.get(id); },
    async setSecret(id, key) {
      if (key === undefined) {
        deletedKeys.push(id);
        secrets.delete(id);
      } else secrets.set(id, key);
    },
    getRoutingHints() { return structuredClone(hints); },
    async saveRoutingHints(next) {
      if (rejectNextHints) {
        rejectNextHints = false;
        throw new Error('Cannot save routing hints');
      }
      hints = structuredClone(next);
    }
  });
  return {
    service, secrets, writes, deletedKeys, provisions,
    groups: () => JSON.parse(text),
    hints: () => hints,
    refreshes: () => refreshes,
    rejectWrites() { rejectWrite = true; },
    rejectNextWrite() { rejectNextWrite = true; },
    rejectNextHints() { rejectNextHints = true; },
    rejectNextRefresh() { rejectNextRefresh = true; }
  };
}

test('model refresh uses the latest text chat catalog and keeps provider order', async t => {
  const cached = emptyCatalogSnapshot().database;
  cached.models['old-model'] = { ...cached.defaults, name: 'Old model' };
  const catalogEntry = {
    name: 'GPT-6.2 Sol',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 128000, output: 16000 }
  };
  const fresh = buildModelCatalog({
    models: {
      'openai/gpt-6.2-sol': catalogEntry,
      'example/image-output': { ...catalogEntry, modalities: { input: ['text'], output: ['image'] } },
      'example/image-input': { ...catalogEntry, modalities: { input: ['image'], output: ['text'] } }
    },
    providers: {
      openrouter: { models: { 'gateway/sol': { ...catalogEntry, canonical_model_id: 'openai/gpt-6.2-sol' } } }
    }
  }, '2026-11-20T00:00:00Z').database;
  const f = fixture([nativeGroup('a1', 'gateway', 'GPT')], async force => force ? fresh : cached);
  const group = (await f.service.getUiState()).providers[0].groups[0];
  const ids = [
    'gateway/sol', 'codex-auto-review', 'old-model', 'image-output', 'image-input',
    'gpt-6.2-sol:experimental', 'gpt-6.2-sol', 'gateway/sol',
    ...Array.from({ length: 5001 }, (_, index) => `uncataloged-${index}`)
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: ids.map(id => ({ id })) }));

  const result = await f.service.discoverModels(group, undefined, new AbortController().signal);

  assert.deepEqual(result.models.map(model => model.id), ['gateway/sol', 'gpt-6.2-sol']);
  assert.deepEqual(result.database, fresh);
  assert.equal(f.writes.length, 0);
});

test('model refresh without a usable catalog or any matches leaves saved models intact', async t => {
  const native = { ...nativeGroup('a1', 'gateway', 'GPT'), models: [{ id: 'codex-auto-review', name: 'Codex Auto Review' }] };
  const empty = emptyCatalogSnapshot().database;
  const available = { ...empty, models: { 'text-chat': { ...empty.defaults, name: 'Text chat' } } };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'codex-auto-review' }] }));

  for (const [database, error] of [
    [empty, /models.dev catalog is temporarily unavailable/],
    [available, /No text chat models matched the models.dev catalog/]
  ]) {
    const f = fixture([native], async () => database);
    const { providers } = await f.service.getUiState();
    await assert.rejects(f.service.discoverModels(providers[0].groups[0], undefined, new AbortController().signal), error);
    assert.deepEqual(f.groups(), [native]);
    assert.equal(f.writes.length, 0);
  }
});

test('deleting a provider removes all its groups in one write and preserves other providers', async () => {
  const other = { ...nativeGroup('b1', 'gateway-a-backup', 'GPT'), customSetting: { retained: true } };
  const unrelated = { vendor: 'other-vendor', name: 'Unrelated', models: [] };
  const f = fixture([
    nativeGroup('a1', 'gateway-a', 'GPT'), other,
    nativeGroup('a2', 'gateway-a', 'Gemini'), unrelated
  ]);
  const otherHints = structuredClone(f.hints().b1);

  const state = await f.service.deleteProvider('gateway-a');

  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.groups(), [other, unrelated]);
  assert.deepEqual(state.providers.map(provider => provider.id), ['gateway-a-backup']);
  assert.deepEqual(f.deletedKeys, ['a1', 'a2']);
  assert.deepEqual([...f.secrets], [['b1', 'test-key-b1']]);
  assert.deepEqual(f.hints(), { b1: otherHints });
  assert.equal(f.refreshes(), 1);
});

test('legacy standalone providers can be deleted without migrating other groups', async () => {
  const legacy = { name: 'Legacy', vendor: 'customendpoint', models: [] };
  const retained = nativeGroup('retained', 'gateway', 'GPT');
  const f = fixture([legacy, retained]);
  const before = await f.service.getUiState();
  const id = before.providers.find(provider => provider.name === 'Legacy').id;
  assert.equal(f.writes.length, 0);

  await f.service.deleteProvider(id);

  assert.deepEqual(f.groups(), [retained]);
  assert.deepEqual(f.deletedKeys, [id]);
  assert.equal(f.secrets.has(id), false);
  assert.equal(Object.hasOwn(f.hints(), id), false);
});

test('a missing provider fails without changing configuration or credentials', async () => {
  const retained = nativeGroup('a1', 'gateway', 'GPT');
  const f = fixture([retained]);

  await assert.rejects(f.service.deleteProvider('missing'), /no longer exists/);

  assert.deepEqual(f.groups(), [retained]);
  assert.equal(f.writes.length, 0);
  assert.equal(f.deletedKeys.length, 0);
  assert.equal(f.secrets.has('a1'), true);
  assert.equal(Object.hasOwn(f.hints(), 'a1'), true);
  assert.equal(f.refreshes(), 0);
});

test('a rejected configuration write leaves every group and credential intact', async () => {
  const groups = [nativeGroup('a1', 'gateway', 'GPT'), nativeGroup('a2', 'gateway', 'Gemini')];
  const f = fixture(groups);
  const hints = structuredClone(f.hints());
  f.rejectWrites();

  await assert.rejects(f.service.deleteProvider('gateway'), /Concurrent modification/);

  assert.deepEqual(f.groups(), groups);
  assert.equal(f.writes.length, 0);
  assert.equal(f.deletedKeys.length, 0);
  assert.deepEqual([...f.secrets.keys()], ['a1', 'a2']);
  assert.deepEqual(f.hints(), hints);
  assert.equal(f.refreshes(), 0);
});

test('saving a credential removes its temporary group and repeated saves do not write again', async () => {
  const f = fixture([nativeGroup('a1', 'gateway', 'GPT')]);
  const provider = (await f.service.getUiState()).providers[0];
  const group = provider.groups[0];

  await Promise.all([
    f.service.saveGroup(provider, group, 'replacement-key'),
    f.service.saveGroup(provider, group, 'replacement-key')
  ]);

  assert.deepEqual(f.groups().map(item => item.byokStudioId), ['a1']);
  assert.equal(f.groups()[0].apiKey, '${input:chat.lm.secret.stage-1}');
  assert.equal(f.secrets.get('a1'), 'replacement-key');
  assert.equal(f.provisions.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.refreshes(), 1);
});

test('ordinary saves preserve a group name edited in native VS Code', async () => {
  const native = { ...nativeGroup('a1', 'gateway', 'GPT'), name: 'Native custom name' };
  const f = fixture([native]);
  const provider = (await f.service.getUiState()).providers[0];
  const group = provider.groups[0];

  await f.service.saveGroup(provider, { ...group, unified: { ...group.unified, url: 'https://changed.test/v1' } });

  assert.equal(f.groups()[0].name, 'Native custom name');
  assert.equal(f.provisions.length, 0);
});

test('saving a populated group again preserves the exact persisted text without writes', async () => {
  const f = fixture([{
    ...nativeGroup('a1', 'gateway', 'GPT'),
    models: [{
      id: 'custom-chat-model', name: 'Custom model', url: 'https://example.test/v1/chat/completions',
      apiType: 'chat-completions', contextWindow: 64000, maxOutputTokens: 8000,
      toolCalling: true, vision: false, customOption: 'retained'
    }],
    settings: { 'custom-chat-model': { customSetting: true } }
  }]);
  let provider = (await f.service.getUiState()).providers[0];
  provider = (await f.service.saveGroup(provider, provider.groups[0])).providers[0];
  const writes = f.writes.length;
  const refreshes = f.refreshes();
  const persisted = f.groups();

  await f.service.saveGroup(provider, provider.groups[0]);

  assert.equal(f.writes.length, writes);
  assert.equal(f.refreshes(), refreshes);
  assert.deepEqual(f.groups(), persisted);
});

test('provider renaming preserves sibling models, settings, and credentials exactly', async () => {
  const sibling = {
    ...nativeGroup('a2', 'gateway', 'Gemini'),
    models: [{ id: 'custom-model', url: 'https://other.test/native', customOption: { keep: true } }],
    settings: { 'custom-model': { customSetting: true } }
  };
  const f = fixture([nativeGroup('a1', 'gateway', 'GPT'), sibling]);
  const provider = (await f.service.getUiState()).providers[0];

  await f.service.saveGroup({ ...provider, name: 'Renamed' }, provider.groups[0]);

  const savedSibling = f.groups().find(item => item.byokStudioId === 'a2');
  assert.deepEqual(savedSibling, { ...sibling, name: 'Renamed · Gemini', byokStudioProviderName: 'Renamed' });
  assert.equal(f.writes.length, 1);
});

test('native-name conflicts are rejected before provisioning credentials', async () => {
  const other = { ...nativeGroup('b1', 'other', 'GPT'), name: 'gateway · collision' };
  const f = fixture([nativeGroup('a1', 'gateway', 'GPT'), other]);
  const before = f.groups();
  const provider = (await f.service.getUiState()).providers[0];

  await assert.rejects(f.service.saveGroup(provider, { ...provider.groups[0], name: 'collision' }, 'replacement-key'), /already has a group/);

  assert.deepEqual(f.groups(), before);
  assert.equal(f.provisions.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.secrets.get('a1'), 'test-key-a1');
});

test('failed publication restores the original configuration and removes staging groups', async () => {
  const f = fixture([nativeGroup('a1', 'gateway', 'GPT')]);
  const before = f.groups();
  const hints = structuredClone(f.hints());
  const provider = (await f.service.getUiState()).providers[0];
  f.rejectNextWrite();

  await assert.rejects(f.service.saveGroup(provider, provider.groups[0], 'replacement-key'), /Concurrent modification/);

  assert.deepEqual(f.groups(), before);
  assert.deepEqual(f.hints(), hints);
  assert.equal(f.secrets.get('a1'), 'test-key-a1');
  assert.equal(f.refreshes(), 0);
});

test('failed local persistence restores both native and local credentials', async () => {
  const f = fixture([nativeGroup('a1', 'gateway', 'GPT')]);
  const before = f.groups();
  const hints = structuredClone(f.hints());
  const provider = (await f.service.getUiState()).providers[0];
  f.rejectNextHints();

  await assert.rejects(f.service.saveGroup(provider, provider.groups[0], 'replacement-key'), /Cannot save routing hints/);

  assert.deepEqual(f.groups(), before);
  assert.deepEqual(f.hints(), hints);
  assert.equal(f.secrets.get('a1'), 'test-key-a1');
  assert.equal(f.refreshes(), 0);
});

test('a blank key preserves a credential rotated in native VS Code', async () => {
  const f = fixture([nativeGroup('a1', 'gateway', 'GPT')]);
  f.hints().a1.secretReference = '${input:chat.lm.secret.old-reference}';
  const provider = (await f.service.getUiState()).providers[0];

  await f.service.saveGroup(provider, provider.groups[0]);

  assert.equal(f.groups()[0].apiKey, '${input:chat.lm.secret.a1}');
  assert.equal(f.provisions.length, 0);
  assert.equal(f.secrets.has('a1'), false);
});

test('retrying after a model-refresh failure does not repeat credential provisioning or writes', async () => {
  const f = fixture([nativeGroup('a1', 'gateway', 'GPT')]);
  const provider = (await f.service.getUiState()).providers[0];
  f.rejectNextRefresh();

  await assert.rejects(f.service.saveGroup(provider, provider.groups[0], 'replacement-key'), /Cannot refresh models/);
  await f.service.saveGroup(provider, provider.groups[0], 'replacement-key');

  assert.equal(f.provisions.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.refreshes(), 2);
  assert.equal(f.secrets.get('a1'), 'replacement-key');
});

function importedGroup(id, name, apiKey) {
  return {
    id, name, apiKey, models: [], modelProtocols: {}, routingMode: 'unified',
    unified: { apiType: 'chatCompletions', url: 'https://example.test/v1' },
    endpoints: { responses: '', chatCompletions: '', messages: '' }
  };
}

test('importing multiple keys publishes only the intended groups and is repeatable', async () => {
  const f = fixture([]);
  const incoming = [{ id: 'gateway', name: 'Gateway', groups: [
    importedGroup('gpt', 'GPT', 'gpt-test-key'),
    importedGroup('gemini', 'Gemini', 'gemini-test-key')
  ] }];

  const imported = await f.service.importProviders(incoming);
  await f.service.importProviders(incoming);
  const exported = await f.service.exportProviders(['gateway']);

  assert.deepEqual(imported.importedIds, ['gateway']);
  assert.deepEqual(f.groups().map(group => group.name), ['Gateway · GPT', 'Gateway · Gemini']);
  assert.deepEqual(f.groups().map(group => group.apiKey), [
    '${input:chat.lm.secret.stage-1}', '${input:chat.lm.secret.stage-2}'
  ]);
  assert.equal(f.provisions.length, 2);
  assert.equal(f.writes.length, 1);
  assert.equal(f.refreshes(), 1);
  assert.equal(exported.version, 2);
  assert.deepEqual(exported.providers[0].groups.map(group => group.apiKey), ['gpt-test-key', 'gemini-test-key']);
});

test('failed import restores every native group, local key, and routing hint', async () => {
  const f = fixture([nativeGroup('gpt', 'gateway', 'GPT'), nativeGroup('gemini', 'gateway', 'Gemini')]);
  const before = f.groups();
  const keys = [...f.secrets];
  const hints = structuredClone(f.hints());
  f.rejectNextHints();

  await assert.rejects(f.service.importProviders([{ id: 'gateway', name: 'gateway', groups: [
    importedGroup('gpt', 'GPT', 'new-gpt-test-key'),
    importedGroup('gemini', 'Gemini', 'new-gemini-test-key')
  ] }]), /Cannot save routing hints/);

  assert.deepEqual(f.groups(), before);
  assert.deepEqual([...f.secrets], keys);
  assert.deepEqual(f.hints(), hints);
  assert.equal(f.refreshes(), 0);
});

test('imports retain native names and reject a group ID owned by a different provider', async () => {
  const native = { ...nativeGroup('gpt', 'gateway', 'GPT'), name: 'Custom native name' };
  const f = fixture([native]);

  await f.service.importProviders([{ id: 'gateway', name: 'gateway', groups: [importedGroup('gpt', 'GPT')] }]);
  const writes = f.writes.length;
  const before = f.groups();
  await assert.rejects(f.service.importProviders([{ id: 'other', name: 'Other', groups: [
    importedGroup('gpt', 'GPT', 'new-key')
  ] }]), /cannot be moved/);

  assert.equal(before[0].name, 'Custom native name');
  assert.deepEqual(f.groups(), before);
  assert.equal(f.writes.length, writes);
  assert.equal(f.provisions.length, 0);
});

test('imported supplier renames preserve sibling model fields and settings', async () => {
  const sibling = {
    ...nativeGroup('gemini', 'gateway', 'Gemini'),
    models: [{ id: 'custom-model', url: 'https://other.test/native', customOption: { keep: true } }],
    settings: { 'custom-model': { customSetting: true } }
  };
  const f = fixture([nativeGroup('gpt', 'gateway', 'GPT'), sibling]);

  await f.service.importProviders([{ id: 'gateway', name: 'Renamed', groups: [importedGroup('gpt', 'GPT')] }]);

  assert.deepEqual(f.groups()[1], { ...sibling, name: 'Renamed · Gemini', byokStudioProviderName: 'Renamed' });
  assert.equal(f.writes.length, 1);
});

test('version 1 imports become default groups while native arrays aggregate provider metadata', async () => {
  const database = emptyCatalogSnapshot().database;
  const legacy = parseImportData({ version: 1, providers: [importedGroup('legacy', 'Legacy', 'legacy-test-key')] }, database);
  const f = fixture([]);

  await f.service.importProviders(legacy);
  const exported = await f.service.exportProviders(['legacy']);

  assert.equal(exported.version, 2);
  assert.equal(exported.providers[0].name, 'Legacy');
  assert.equal(exported.providers[0].groups[0].name, '');
  assert.equal(exported.providers[0].groups[0].apiKey, 'legacy-test-key');
  const native = parseImportData([nativeGroup('gpt', 'gateway', 'GPT'), nativeGroup('gemini', 'gateway', 'Gemini')], database);
  assert.equal(native.length, 1);
  assert.deepEqual(native[0].groups.map(group => group.name), ['GPT', 'Gemini']);
});

test('version 2 imports reject duplicate provider records instead of silently merging them', () => {
  assert.throws(() => parseImportData({ version: 2, providers: [
    { id: 'gateway', name: 'Gateway', groups: [importedGroup('gpt', 'GPT')] },
    { id: 'gateway', name: 'Gateway', groups: [importedGroup('gemini', 'Gemini')] }
  ] }, emptyCatalogSnapshot().database), /duplicate provider/);
});
