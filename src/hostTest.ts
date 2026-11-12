import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { ExtensionTestApi } from './extension';
import type { ProviderConfig } from './core/types';
import { normalizeRouting } from '../resources/shared/routing.js';
import { listGroups, parseNativeGroups, updateOwnedGroup } from './core/officialJson';
import { OfficialConfigurationManager } from './officialManager';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionTestApi>('qian-o.byok-studio');
  assert.ok(extension);
  const api = await extension.activate();
  assert.ok(Object.keys(api.store.database().models).length > 0, 'Activation reads the offline upstream presets');
  const official = vscode.extensions.getExtension('GitHub.copilot-chat');
  assert.ok(official, 'The test explicitly loads the installed official provider extension');
  await official.activate();
  // The isolated profile is signed out, so use metadata only to exercise VS Code's real configuration watcher.
  assert.equal(process.env.BYOK_TEST_MODE, '1');
  await vscode.workspace.getConfiguration('editor').update('formatOnSave', true, vscode.ConfigurationTarget.Global);
  const configurations: string[][] = [];
  const fixtureProvider = vscode.lm.registerLanguageModelChatProvider('customendpoint', {
    provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions & { configuration?: { models?: Array<{ id: string; name: string; contextWindow: number; maxOutputTokens: number }> } }) {
      configurations.push((options.configuration?.models ?? []).map(model => model.id));
      if (configurations.length > 8) configurations.shift();
      return (options.configuration?.models ?? []).map(model => ({ ...model, maxInputTokens: model.contextWindow - model.maxOutputTokens, family: model.id, version: '1', capabilities: { toolCalling: true } }));
    },
    async provideLanguageModelChatResponse() { throw new Error('Host tests must never send inference requests'); },
    async provideTokenCount() { return 0; }
  });
  const assertChatModels = async (expected: Array<{ id: string; name: string }>) => {
    const deadline = Date.now() + 5000;
    let actual: Array<{ id: string; name: string }> = [];
    do {
      actual = (await vscode.lm.selectChatModels({ vendor: 'customendpoint' }))
        .filter(model => model.id.includes('fixture-model'))
        .map(({ id, name }) => ({ id, name }));
      if (actual.length === expected.length && expected.every(model => actual.some(item => item.id.endsWith(model.id) && item.name === model.name))) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.fail(`Chat models did not refresh: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}; configurations=${JSON.stringify(configurations)}`);
  };
  const uri = api.manager.configurationUri;
  const manual = '{ "vendor": "customendpoint", "name": "Manual fixture", "models": [], "settings": {"manual":{"keep":[1,2,3]}}, /* inner comment */ "future":true }';
  const other = '{"vendor":"agent-host-copilotcli","name":"User session settings","settings":{"unrelated":{"thinkingLevel":"max"}}}';
  const legacy = '{"vendor":"byok-studio","name":"Prior managed group","providerId":"manager-fixture","byokStudioGroupName":"Prior managed group"}';
  const original = `// preserve header\r\n[\r\n  ${manual}, // keep neighbor\r\n  ${legacy},\r\n  ${other},\r\n] // preserve footer\r\n`;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(original));
  const text = async () => Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const assertUnrelated = (value: string) => {
    assert.ok(value.includes(manual), 'The unrelated model group remains byte-for-byte unchanged');
    assert.ok(value.includes(other), 'Chat session settings remain byte-for-byte unchanged');
    for (const comment of ['// preserve header','// keep neighbor','// preserve footer','/* inner comment */']) assert.ok(value.includes(comment), comment);
  };
  const database = api.store.database();
  const provider: ProviderConfig = { id: 'manager-fixture', name: 'Managed fixture', enabled: true,
    ...normalizeRouting({ apiType: 'responses', url: 'http://127.0.0.1:1/v1' }),
    models: [{ id: 'fixture-model', name: 'Fixture Model', discoveredName: '', overrides: {maxOutputTokens:4096, toolCalling:true, thinking:true, supportsReasoningEffort:['low','high']}, reasoningEffort:'high' }] };
  Object.assign(provider.models[0]!, { contextSize: 32768 });
  await api.store.saveProvider(provider, 'isolated-manager-key-one');
  assert.equal(Object.hasOwn(api.store.snapshot().providers[0]!.models[0]!, 'contextSize'), false);
  await api.manager.applyProviders([provider.id], provider.id);
  let raw = await text();
  assertUnrelated(raw);
  assert.ok(raw.startsWith('// preserve header\r\n['), 'Original CRLF style survives official key provisioning');
  assert.ok(!raw.includes('isolated-manager-key-one'));
  assert.equal(listGroups(raw).filter(group=>group.vendor==='byok-studio').length,0);
  let managed = listGroups(raw).find(group=>group.byokStudioId===provider.id)!;
  assert.ok(managed);
  assert.equal(managed.vendor,'customendpoint');
  const published = (managed.models as Array<{contextWindow:number;maxOutputTokens:number}>)[0]!;
  assert.equal(published.contextWindow, database.defaults.contextWindow);
  assert.equal(published.maxOutputTokens, 4096);
  assert.equal(Object.hasOwn(published, 'maxInputTokens'), false);
  for (const field of ['zeroDataRetentionEnabled', 'statefulResponses']) assert.equal(Object.hasOwn(published, field), false);
  const firstReference = managed.apiKey;
  assert.equal(typeof firstReference,'string');
  assert.equal((managed.settings as Record<string,{reasoningEffort:string}>)['fixture-model']!.reasoningEffort,'high');
  assert.equal((managed.models as Array<{defaultReasoningEffort:string}>)[0]!.defaultReasoningEffort,'high');
  assert.equal(listGroups(raw).filter(group=>group.byokStudioStageFor).length,0);
  await assertChatModels([{ id: 'fixture-model', name: 'Fixture Model' }]);

  provider.name = 'Renamed managed fixture';
  provider.models[0]!.name = 'Renamed Fixture Model';
  provider.models.push({ id: 'fixture-model-added', name: 'Added Fixture Model', discoveredName: '', overrides: {} });
  provider.models[0]!.reasoningEffort = undefined;
  await api.store.saveProvider(provider);
  await api.manager.applyProviders([provider.id]);
  raw=await text();assertUnrelated(raw);
  managed=listGroups(raw).find(group=>group.byokStudioId===provider.id)!;
  assert.equal(managed.name,provider.name);assert.equal(managed.apiKey,firstReference);
  assert.equal(managed.settings,undefined,'Clearing a managed default removes only that setting');
  assert.equal((managed.models as Array<{defaultReasoningEffort?:string}>)[0]!.defaultReasoningEffort,undefined);
  await assertChatModels([{ id: 'fixture-model', name: 'Renamed Fixture Model' }, { id: 'fixture-model-added', name: 'Added Fixture Model' }]);
  provider.models.pop();
  await api.store.saveProvider(provider);
  await api.manager.applyProviders([provider.id]);
  await assertChatModels([{ id: 'fixture-model', name: 'Renamed Fixture Model' }]);
  raw = await text();
  managed = listGroups(raw).find(group=>group.byokStudioId===provider.id)!;

  const enriched=updateOwnedGroup(raw,provider.id,{...managed,apiType:'responses',models:[{...(managed.models as object[])[0],adaptiveThinking:true,minThinkingBudget:1024,streaming:true,reasoningEffortFormat:'responses',zeroDataRetentionEnabled:true,statefulResponses:false,modelOptions:{temperature:0.6},futureModelOption:'keep'}],futureGroupOption:{keep:true}});
  const document=await vscode.workspace.openTextDocument(uri);
  const saveFixtureDocument = async () => {
    const configuration = vscode.workspace.getConfiguration('editor');
    await configuration.update('formatOnSave', false, vscode.ConfigurationTarget.Global);
    try { assert.ok(await document.save()); }
    finally { await configuration.update('formatOnSave', true, vscode.ConfigurationTarget.Global); }
  };
  const waitForReload = async (expected: string) => {
    const deadline = Date.now() + 5000;
    while (document.getText().replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) {
      assert.ok(Date.now() < deadline, 'The editor reloads the configuration written to disk');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await waitForReload(raw);
  const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),enriched);
  assert.ok(await vscode.workspace.applyEdit(edit));await saveFixtureDocument();
  await api.manager.applyProviders([provider.id]);raw=await text();assertUnrelated(raw);
  managed=listGroups(raw).find(group=>group.byokStudioId===provider.id)!;
  const model=(managed.models as Array<Record<string,unknown>>)[0]!;
  assert.equal(model.adaptiveThinking,undefined);assert.equal(model.minThinkingBudget,undefined);assert.equal(model.modelOptions,undefined);assert.equal(model.futureModelOption,'keep');
  assert.equal(managed.apiType,undefined,'The legacy group protocol is removed during synchronization');
  assert.equal(model.streaming,undefined);assert.equal(model.reasoningEffortFormat,undefined);
  assert.equal(Object.hasOwn(model, 'statefulResponses'), false);
  assert.equal(Object.hasOwn(model, 'zeroDataRetentionEnabled'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(managed.futureGroupOption)),{keep:true});

  await api.store.saveProvider(provider,'isolated-manager-key-two');
  await api.manager.applyProviders([provider.id], provider.id);
  raw=await text();assertUnrelated(raw);assert.ok(!raw.includes('isolated-manager-key-two'));
  managed=listGroups(raw).find(group=>group.byokStudioId===provider.id)!;
  assert.notEqual(managed.apiKey,firstReference,'Key changes use a fresh protected native reference');
  assert.equal(listGroups(raw).filter(group=>group.byokStudioStageFor).length,0);
  await api.manager.applyProviders([provider.id]);assert.equal(await text(),raw,'Unchanged save does not rewrite native configuration');

  const staleStorageManager = new OfficialConfigurationManager({
    globalStorageUri: vscode.Uri.joinPath(uri, '..', 'globalStorage', 'stale-bindings-fixture').with({ scheme: 'file' }),
    globalState: { get: (_key: string, fallback: unknown) => structuredClone(fallback), update: async () => {} }
  } as unknown as vscode.ExtensionContext, api.store);
  await staleStorageManager.applyProviders([provider.id]);
  raw = await text();
  await staleStorageManager.applyProviders([provider.id]);
  assert.equal(await text(), raw, 'Delayed storage notifications cannot rotate an unchanged key');
  assertUnrelated(raw);

  await waitForReload(raw);
  const dirty=new vscode.WorkspaceEdit();dirty.insert(uri,document.positionAt(0),'// unsaved user change\n');
  assert.ok(await vscode.workspace.applyEdit(dirty));assert.equal(document.isDirty,true);
  await assert.rejects(api.manager.applyProviders([provider.id]),/未保存修改|unsaved (?:changes|edits)/i);assert.equal(await text(),raw);
  const restore=new vscode.WorkspaceEdit();restore.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),raw);
  assert.ok(await vscode.workspace.applyEdit(restore));await saveFixtureDocument();

  await api.store.deleteProvider(provider.id);await api.manager.applyProviders([provider.id]);raw=await text();assertUnrelated(raw);
  assert.equal(listGroups(raw).some(group=>group.byokStudioId===provider.id),false);
  await assertChatModels([]);
  const secretDeadline = Date.now() + 3000;
  while (await api.store.key(provider.id) !== undefined) {
    assert.ok(Date.now() < secretDeadline, 'SecretStorage reflects the completed deletion');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(parseNativeGroups(raw).groups.map(group=>group.name),['Manual fixture','User session settings']);
  assert.ok(!(await vscode.commands.getCommands(true)).includes('byokStudio.sendRequest'));
  await api.openSettings();await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  fixtureProvider.dispose();
  console.log('OFFICIAL MANAGER HOST TEST PASSED: native encrypted key provisioning, exact unrelated-node/comment preservation, create/update/rename/key rotation/default clearing/deletion, dirty-file protection, idempotent saves and VS Code model-list refresh with a metadata-only fixture provider. No inference requests.');
}
