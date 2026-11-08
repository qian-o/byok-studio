import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { ExtensionTestApi } from './extension';
import type { ProviderConfig } from './core/types';
import { normalizeRouting } from '../media/model-vendors.js';
import { listGroups, parseNativeGroups, updateOwnedGroup } from './core/officialJson';
import { OfficialConfigurationManager } from './officialManager';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionTestApi>('byok-studio-local.byok-studio');
  assert.ok(extension);
  const api = await extension.activate();
  const official = vscode.extensions.getExtension('GitHub.copilot-chat');
  assert.ok(official, 'The test explicitly loads the installed official provider extension');
  await official.activate();
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
  const database = api.store.snapshot().database;
  database.models['fixture-model'] = { ...database.defaults, name: 'Fixture Model', toolCalling: true, thinking: true, supportsReasoningEffort: ['low','high'],
    contextPricing: { kind: 'tiered', scope: 'custom', thresholds: [32768], source: 'https://example.test/pricing', checkedAt: null, note: '' } };
  await api.store.saveDatabase(database);
  const provider: ProviderConfig = { id: 'manager-fixture', name: 'Managed fixture', enabled: true, zeroDataRetentionEnabled: true,
    ...normalizeRouting({ apiType: 'responses', url: 'http://127.0.0.1:1/v1' }),
    models: [{ id: 'fixture-model', name: '', discoveredName: '', overrides: {defaultOutputTokens:4096}, reasoningEffort:'high' }] };
  Object.assign(provider.models[0]!, { contextSize: 32768 });
  await api.store.saveProvider(provider, 'isolated-manager-key-one');
  assert.equal(Object.hasOwn(api.store.snapshot().providers[0]!.models[0]!, 'contextSize'), false);
  await api.manager.synchronize(provider.id);
  let raw = await text();
  assertUnrelated(raw);
  assert.ok(raw.startsWith('// preserve header\r\n['), 'Original CRLF style survives official key provisioning');
  assert.ok(!raw.includes('isolated-manager-key-one'));
  assert.equal(listGroups(raw).filter(group=>group.vendor==='byok-studio').length,0);
  let managed = listGroups(raw).find(group=>group.byokStudioId===provider.id)!;
  assert.ok(managed);
  assert.equal(managed.vendor,'customendpoint');
  const published = (managed.models as Array<{maxInputTokens:number;maxOutputTokens:number}>)[0]!;
  assert.equal(published.maxInputTokens + published.maxOutputTokens, database.defaults.contextWindow, 'Billing tiers do not shrink native model capacity');
  const firstReference = managed.apiKey;
  assert.equal(typeof firstReference,'string');
  assert.equal((managed.settings as Record<string,{reasoningEffort:string}>)['fixture-model']!.reasoningEffort,'high');
  assert.equal((managed.models as Array<{defaultReasoningEffort:string}>)[0]!.defaultReasoningEffort,'high');
  assert.equal(listGroups(raw).filter(group=>group.byokStudioStageFor).length,0);

  provider.name = 'Renamed managed fixture';
  provider.models[0]!.reasoningEffort = undefined;
  await api.store.saveProvider(provider);
  await api.manager.synchronize();
  raw=await text();assertUnrelated(raw);
  managed=listGroups(raw).find(group=>group.byokStudioId===provider.id)!;
  assert.equal(managed.name,provider.name);assert.equal(managed.apiKey,firstReference);
  assert.equal(managed.settings,undefined,'Clearing a managed default removes only that setting');
  assert.equal((managed.models as Array<{defaultReasoningEffort?:string}>)[0]!.defaultReasoningEffort,undefined);

  const enriched=updateOwnedGroup(raw,provider.id,{...managed,apiType:'responses',models:[{...(managed.models as object[])[0],adaptiveThinking:true,minThinkingBudget:1024,streaming:true,reasoningEffortFormat:'responses',statefulResponses:false,modelOptions:{temperature:0.6},futureModelOption:'keep'}],futureGroupOption:{keep:true}});
  const document=await vscode.workspace.openTextDocument(uri);
  const waitForReload = async (expected: string) => {
    const deadline = Date.now() + 5000;
    while (document.getText().replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) {
      assert.ok(Date.now() < deadline, 'The editor reloads the configuration written to disk');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await waitForReload(raw);
  const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),enriched);
  assert.ok(await vscode.workspace.applyEdit(edit));assert.ok(await document.save());
  await api.manager.synchronize();raw=await text();assertUnrelated(raw);
  managed=listGroups(raw).find(group=>group.byokStudioId===provider.id)!;
  const model=(managed.models as Array<Record<string,unknown>>)[0]!;
  assert.equal(model.adaptiveThinking,undefined);assert.equal(model.minThinkingBudget,undefined);assert.equal(model.modelOptions,undefined);assert.equal(model.futureModelOption,'keep');
  assert.equal(managed.apiType,undefined,'The legacy group protocol is removed during synchronization');
  assert.equal(model.streaming,undefined);assert.equal(model.reasoningEffortFormat,undefined);
  assert.equal(model.statefulResponses,undefined,'ZDR already disables Responses chaining');
  assert.equal(model.zeroDataRetentionEnabled,true);
  assert.deepEqual(JSON.parse(JSON.stringify(managed.futureGroupOption)),{keep:true});

  await api.store.saveProvider(provider,'isolated-manager-key-two');
  await api.manager.synchronize(provider.id);
  raw=await text();assertUnrelated(raw);assert.ok(!raw.includes('isolated-manager-key-two'));
  managed=listGroups(raw).find(group=>group.byokStudioId===provider.id)!;
  assert.notEqual(managed.apiKey,firstReference,'Key changes use a fresh protected native reference');
  assert.equal(listGroups(raw).filter(group=>group.byokStudioStageFor).length,0);
  await api.manager.synchronize();assert.equal(await text(),raw,'Unchanged save does not rewrite native configuration');

  const staleStorageManager = new OfficialConfigurationManager({
    globalStorageUri: vscode.Uri.joinPath(uri, '..', 'globalStorage', 'stale-bindings-fixture').with({ scheme: 'file' }),
    globalState: { get: (_key: string, fallback: unknown) => structuredClone(fallback), update: async () => {} }
  } as unknown as vscode.ExtensionContext, api.store);
  await staleStorageManager.synchronize();
  raw = await text();
  await staleStorageManager.synchronize();
  assert.equal(await text(), raw, 'Delayed storage notifications cannot rotate an unchanged key');
  assertUnrelated(raw);

  await waitForReload(raw);
  const dirty=new vscode.WorkspaceEdit();dirty.insert(uri,document.positionAt(0),'// unsaved user change\n');
  assert.ok(await vscode.workspace.applyEdit(dirty));assert.equal(document.isDirty,true);
  await assert.rejects(api.manager.synchronize(),/未保存修改|unsaved (?:changes|edits)/i);assert.equal(await text(),raw);
  const restore=new vscode.WorkspaceEdit();restore.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),raw);
  assert.ok(await vscode.workspace.applyEdit(restore));assert.ok(await document.save());

  await api.store.deleteProvider(provider.id);await api.manager.synchronize();raw=await text();assertUnrelated(raw);
  assert.equal(listGroups(raw).some(group=>group.byokStudioId===provider.id),false);
  const secretDeadline = Date.now() + 3000;
  while (await api.store.key(provider.id) !== undefined) {
    assert.ok(Date.now() < secretDeadline, 'SecretStorage reflects the completed deletion');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(parseNativeGroups(raw).groups.map(group=>group.name),['Manual fixture','User session settings']);
  assert.ok(!(await vscode.commands.getCommands(true)).includes('byokStudio.sendRequest'));
  await api.openSettings();await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  console.log('OFFICIAL MANAGER HOST TEST PASSED: native encrypted key provisioning, exact unrelated-node/comment preservation, create/update/rename/key rotation/default clearing/deletion, dirty-file protection and idempotent saves. No custom language-model provider or paid inference requests.');
}
