import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { StudioStore } from './core/store';
import { compileOfficialGroup } from './core/officialConfig';
import { listGroups, updateOwnedGroup, removeLegacyGroups } from './core/officialJson';
import { t } from '../resources/shared/i18n.js';

const BINDINGS_KEY = 'byokStudio.officialBindings.v1';
const ADD_GROUP = 'lm.addLanguageModelsProviderGroup';
const MANAGED_MODEL_FIELDS = ['id', 'name', 'url', 'apiType', 'toolCalling', 'vision', 'thinking', 'maxInputTokens', 'maxOutputTokens', 'contextWindow', 'defaultOutputTokens', 'contextWindowMode', 'adaptiveThinking', 'minThinkingBudget', 'maxThinkingBudget', 'supportsReasoningEffort', 'reasoningEffortFormat', 'defaultReasoningEffort', 'streaming', 'modelOptions', 'zeroDataRetentionEnabled', 'statefulResponses'];
interface Binding { keyFingerprint?: string; secretReference?: string; clearKeyPending?: boolean }
type Bindings = Record<string, Binding>;
interface Snapshot { document: vscode.TextDocument; text: string }
const fingerprint = (value: string | undefined) => value ? createHash('sha256').update(value).digest('hex') : undefined;
const isSecretReference = (value: unknown): value is string => typeof value === 'string' && /^\$\{input:chat\.lm\.secret\.[^}]+\}$/.test(value);

export class OfficialConfigurationManager {
  readonly configurationUri: vscode.Uri;
  private pending: Promise<void> = Promise.resolve();
  private bindings: Bindings;
  constructor(private readonly context: vscode.ExtensionContext, private readonly store: StudioStore) {
    const location = vscode.Uri.joinPath(context.globalStorageUri, '..', '..', 'chatLanguageModels.json');
    this.configurationUri = location.with({ scheme: 'vscode-userdata' });
    this.bindings = structuredClone(context.globalState.get<Bindings>(BINDINGS_KEY, {}));
  }
  private async saveBindings(bindings: Bindings): Promise<void> {
    await this.context.globalState.update(BINDINGS_KEY, structuredClone(bindings));
    // Storage change notifications can lag behind completed writes; the queue retains its latest state.
    this.bindings = structuredClone(bindings);
  }
  applyProviders(providerIds: readonly string[], changedKeyId?: string): Promise<void> {
    const selected = new Set(providerIds);
    const next = this.pending.catch(() => undefined).then(() => this.apply(selected, changedKeyId));
    this.pending = next;
    return next;
  }
  async openConfiguration(): Promise<void> {
    const snapshot = await this.read(false);
    await vscode.window.showTextDocument(snapshot.document, { preview: false });
  }
  private async ready(): Promise<void> {
    const official = vscode.extensions.getExtension('GitHub.copilot-chat');
    if (!official) throw new Error(t('请安装或启用官方 GitHub Copilot Chat，再保存模型配置。'));
    await official.activate();
    if (!(await vscode.commands.getCommands(true)).includes(ADD_GROUP)) throw new Error(t('当前 VS Code 未提供官方模型配置命令，请更新 VS Code。'));
  }
  private async read(create = true): Promise<Snapshot> {
    const samePath = (uri: vscode.Uri) => ['file', 'vscode-userdata'].includes(uri.scheme) && uri.authority === this.configurationUri.authority
      && (process.platform === 'win32' ? uri.path.toLowerCase() === this.configurationUri.path.toLowerCase() : uri.path === this.configurationUri.path);
    const open = vscode.workspace.textDocuments.filter(document => samePath(document.uri));
    if (open.some(document => document.isDirty)) throw new Error(t('官方模型配置有未保存修改，请先保存该文件后重试。'));
    let document = open.find(document => document.uri.scheme === 'vscode-userdata');
    if (!document) {
      try { document = await vscode.workspace.openTextDocument(this.configurationUri); }
      catch {
        const file = this.configurationUri.with({ scheme: this.context.globalStorageUri.scheme });
        try { document = await vscode.workspace.openTextDocument(file); }
        catch (openError) {
          let exists = true;
          try { await vscode.workspace.fs.stat(file); }
          catch (statError) {
            if (!(statError instanceof vscode.FileSystemError) || statError.code !== 'FileNotFound') throw statError;
            exists = false;
          }
          if (exists) throw openError;
          if (!create) throw new Error(t('尚未保存官方模型配置，请先保存供应商。'));
          const creation = new vscode.WorkspaceEdit();
          creation.createFile(file, { ignoreIfExists: true, contents: Buffer.from('[]\n') });
          if (!await vscode.workspace.applyEdit(creation)) throw new Error(t('无法创建官方模型配置文件。'));
          document = await vscode.workspace.openTextDocument(file);
        }
      }
    }
    const text = Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8');
    listGroups(text);
    return { document, text };
  }
  private async backup(text: string): Promise<void> {
    const folder = vscode.Uri.joinPath(this.context.globalStorageUri, 'native-config-backups');
    await vscode.workspace.fs.createDirectory(folder);
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonc`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, filename), Buffer.from(text));
    const backups = (await vscode.workspace.fs.readDirectory(folder)).filter(([name, kind]) => kind === vscode.FileType.File && name.endsWith('.jsonc')).sort(([a], [b]) => b.localeCompare(a));
    for (const [name] of backups.slice(10)) await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, name));
  }
  private async write(snapshot: Snapshot, text: string): Promise<void> {
    if (snapshot.text === text) return;
    await this.waitForReload(snapshot);
    const unchanged = async () => !snapshot.document.isDirty
      && Buffer.from(await vscode.workspace.fs.readFile(snapshot.document.uri)).toString('utf8') === snapshot.text;
    if (!await unchanged()) throw new Error(t('官方模型配置在写入期间发生变化，未覆盖其他修改，请重试。'));
    await this.backup(snapshot.text);
    if (!await unchanged()) throw new Error(t('官方模型配置在备份期间发生变化，请重试。'));
    // The native watcher reads the text model, so update it before saving the file.
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(snapshot.document.positionAt(0), snapshot.document.positionAt(snapshot.document.getText().length));
    edit.set(snapshot.document.uri, [vscode.TextEdit.replace(range, text), vscode.TextEdit.setEndOfLine(text.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF)]);
    if (!await vscode.workspace.applyEdit(edit) || !await snapshot.document.save()) throw new Error(t('无法保存官方模型配置，请检查该文件后重试。'));
    const saved = Buffer.from(await vscode.workspace.fs.readFile(snapshot.document.uri)).toString('utf8');
    if (snapshot.document.isDirty || !isDeepStrictEqual(listGroups(saved), listGroups(text))) throw new Error(t('官方模型配置在保存期间发生变化，请检查该文件后重试。'));
    // Save participants may format unrelated nodes. Restore their original bytes after the model is current.
    if (saved !== text) {
      if (snapshot.document.isDirty || Buffer.from(await vscode.workspace.fs.readFile(snapshot.document.uri)).toString('utf8') !== saved) throw new Error(t('官方模型配置在写入期间发生变化，未覆盖其他修改，请重试。'));
      await vscode.workspace.fs.writeFile(snapshot.document.uri, Buffer.from(text));
    }
    await this.waitForReload({ ...snapshot, text });
  }
  private async waitForReload(snapshot: Snapshot): Promise<void> {
    const normalize = (value: string) => value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const deadline = Date.now() + 3000;
    while (normalize(snapshot.document.getText()) !== normalize(snapshot.text)) {
      if (snapshot.document.isDirty || Date.now() >= deadline) throw new Error(t('官方配置尚未完成重新加载，请稍后保存重试。'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  private async provisionKey(providerId: string, key: string, snapshot: Snapshot): Promise<{ snapshot: Snapshot; originalText: string; reference: string }> {
    const stagingId = `stage-${randomUUID()}`;
    const name = t('BYOK Studio 凭据 {0}', randomUUID());
    const current = async () => !snapshot.document.isDirty && Buffer.from(await vscode.workspace.fs.readFile(snapshot.document.uri)).toString('utf8') === snapshot.text;
    if (!await current()) throw new Error(t('官方配置已变化，未创建密钥分组，请重试。'));
    await this.backup(snapshot.text);
    if (!await current()) throw new Error(t('官方配置在备份期间已变化，请重试。'));
    await this.waitForReload(snapshot);
    if (!await current()) throw new Error(t('官方配置已变化，请重试。'));
    await vscode.commands.executeCommand(ADD_GROUP, { name, vendor: 'customendpoint', byokStudioId: stagingId, byokStudioStageFor: providerId, models: [], apiKey: key });
    const after = await this.read();
    const groups = listGroups(after.text);
    const staged = groups.find(group => group.vendor === 'customendpoint' && group.byokStudioId === stagingId);
    if (!staged || !isSecretReference(staged.apiKey)) throw new Error(t('VS Code 未返回受保护的密钥引用，未发布模型。'));
    const others = groups.filter(group => group !== staged);
    const originalGroups = listGroups(snapshot.text);
    if (!isDeepStrictEqual(others, originalGroups)) {
      await this.write(after, updateOwnedGroup(after.text, stagingId, null));
      throw new Error(t('官方配置在密钥保存期间发生变化，未覆盖其他分组，请重试。'));
    }
    // The official command normalizes the file. Restore the original text while publishing only our node.
    return { snapshot: after, originalText: snapshot.text, reference: staged.apiKey };
  }
  private async apply(selected: ReadonlySet<string>, changedKeyId?: string): Promise<void> {
    if (!selected.size) return;
    const state = this.store.snapshot();
    const database = this.store.database();
    const bindings = structuredClone(this.bindings);
    if (changedKeyId && selected.has(changedKeyId) && !await this.store.key(changedKeyId)) {
      bindings[changedKeyId] = { ...bindings[changedKeyId], clearKeyPending: true };
      await this.saveBindings(bindings);
    }
    await this.ready();
    let snapshot = await this.read();
    const active = state.providers.filter(provider => selected.has(provider.id) && provider.enabled && provider.models.length);
    const planned = new Map(active.map(provider => [provider.id, compileOfficialGroup(provider, database)]));
    const names = new Set<string>();
    const initialGroups = listGroups(snapshot.text);
    for (const [id, group] of planned) {
      if (names.has(group.name) || initialGroups.some(existing => existing.vendor === 'customendpoint' && existing.name === group.name && existing.byokStudioId !== id)) throw new Error(t('官方配置已有同名分组“{0}”，请修改供应商名称后重试。', group.name));
      names.add(group.name);
      bindings[id] ??= {};
    }
    await this.saveBindings(bindings);
    const currentIds = new Set(active.map(provider => provider.id));
    let text = removeLegacyGroups(snapshot.text, [...selected]);
    for (const group of listGroups(text)) {
      if (group.vendor !== 'customendpoint' || typeof group.byokStudioId !== 'string') continue;
      const id = group.byokStudioId;
      if ((selected.has(id) && !currentIds.has(id)) || (typeof group.byokStudioStageFor === 'string' && selected.has(group.byokStudioStageFor))) text = updateOwnedGroup(text, id, null);
    }
    if (text !== snapshot.text) { await this.write(snapshot, text); snapshot = await this.read(); }
    for (const provider of active) {
      const generated = planned.get(provider.id)!;
      const groups = listGroups(snapshot.text);
      const existing = groups.find(group => group.byokStudioId === provider.id && group.vendor === 'customendpoint');
      if (groups.some(group => group.vendor === 'customendpoint' && group.name === generated.name && group.byokStudioId !== provider.id)) throw new Error(t('官方配置已有同名分组“{0}”，请修改供应商名称后重试。', generated.name));
      const key = await this.store.key(provider.id);
      const keyFingerprint = fingerprint(key);
      let reference = isSecretReference(existing?.apiKey) ? existing.apiKey : undefined;
      let originalText = snapshot.text;
      const previous = bindings[provider.id];
      if (key && (!reference || changedKeyId === provider.id || (previous && previous.keyFingerprint !== keyFingerprint))) {
        const provisioned = await this.provisionKey(provider.id, key, snapshot);
        snapshot = provisioned.snapshot;
        originalText = provisioned.originalText;
        reference = provisioned.reference;
      } else if (!key && previous?.clearKeyPending) reference = undefined;
      const merged: Record<string, unknown> = { ...existing, ...generated };
      if (reference) merged.apiKey = reference; else delete merged.apiKey;
      merged.models = generated.models;
      const settings = structuredClone(existing?.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings) ? existing.settings : {}) as Record<string, Record<string, unknown>>;
      for (const model of generated.models) {
        const current = settings[model.id] && typeof settings[model.id] === 'object' ? { ...settings[model.id] } : {};
        delete current.zeroDataRetentionEnabled;
        delete current.statefulResponses;
        if (model.defaultReasoningEffort) current.reasoningEffort = model.defaultReasoningEffort;
        else delete current.reasoningEffort;
        if (Object.keys(current).length) settings[model.id] = current;
        else delete settings[model.id];
      }
      if (Object.keys(settings).length) merged.settings = settings; else delete merged.settings;
      const patched = updateOwnedGroup(originalText, provider.id, merged, { managedModelFields: MANAGED_MODEL_FIELDS, replaceFields: ['settings'], removeFields: ['apiType', 'zeroDataRetentionEnabled', 'statefulResponses', ...(reference ? [] : ['apiKey'])] });
      await this.write(snapshot, patched);
      bindings[provider.id] = { keyFingerprint, secretReference: reference };
      await this.saveBindings(bindings);
      snapshot = await this.read();
    }
    for (const id of selected) if (!currentIds.has(id)) delete bindings[id];
    await this.saveBindings(bindings);
    await vscode.lm.selectChatModels({ vendor: 'customendpoint' });
  }
}
