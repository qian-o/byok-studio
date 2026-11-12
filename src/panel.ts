import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { object, sanitizeError, text, validId, validateProvider } from './core/configuration';
import { MAX_IMPORT_BYTES, parseExportBundle, StudioStore } from './core/store';
import { discoverProviderModels } from './core/discovery';
import { renderHtml, t } from '../resources/shared/i18n.js';

export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly pending = new Set<AbortController>();
  private readonly stateSubscription: vscode.Disposable;
  constructor(private readonly context: vscode.ExtensionContext, private readonly store: StudioStore, changed: vscode.Event<void>, private readonly applyConfiguration: (providerIds: readonly string[], changedKeyId?: string) => Promise<void>) {
    this.stateSubscription = changed(() => { void this.broadcast(); });
  }
  async open(): Promise<void> {
    if (this.panel) { this.panel.reveal(); return; }
    const resources = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    const panel = vscode.window.createWebviewPanel('byokStudio.settings', t('BYOK Studio · 模型设置'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [resources], retainContextWhenHidden: true });
    this.panel = panel;
    const receive = panel.webview.onDidReceiveMessage(message => { void this.handle(message, panel); });
    panel.onDidDispose(() => {
      receive.dispose();
      for (const controller of this.pending) controller.abort();
      this.pending.clear();
      if (this.panel === panel) this.panel = undefined;
    });
    const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(resources, 'webview', 'index.html'))).toString('utf8');
    const nonce = randomBytes(24).toString('base64');
    panel.webview.html = renderHtml(raw)
      .replace(/\{\{resource:((?:webview|shared)\/[a-z0-9.-]+)\}\}/g, (_, path: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, ...path.split('/'))).toString())
      .replace(/\{\{CSP_SOURCE\}\}/g, panel.webview.cspSource)
      .replace(/\{\{NONCE\}\}/g, nonce);
  }
  private async broadcast(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    try { await panel.webview.postMessage({ event: 'state', data: await this.store.uiState() }); }
    catch { /* A webview can be closed while its state is being prepared. */ }
  }
  private async handle(message: unknown, panel: vscode.WebviewPanel): Promise<void> {
    let id: string;
    let command: string;
    let payload: Record<string, unknown>;
    try {
      const envelope = object(message);
      id = text(envelope.id, t('消息标识'), 100);
      command = text(envelope.command, t('操作'), 50);
      payload = envelope.payload == null ? {} : object(envelope.payload);
    } catch { return; }
    const sensitive: string[] = [];
    if (typeof payload.apiKey === 'string') sensitive.push(payload.apiKey);
    if (Array.isArray(payload.providers)) for (const entry of payload.providers) {
      if (entry && typeof entry === 'object' && typeof entry.apiKey === 'string') sensitive.push(entry.apiKey);
    }
    let changedKeyId: string | undefined;
    let importedIds: string[] | undefined;
    let affectedIds: string[] | undefined;
    try {
      let data: unknown = null;
      switch (command) {
        case 'getState': data = await this.store.uiState(); break;
        case 'saveProvider': {
          const providerId = validId(object(payload.provider).id, t('供应商标识'));
          await this.store.saveProvider(payload.provider, payload.apiKey, payload.clearKey === true);
          affectedIds = [providerId];
          if ((typeof payload.apiKey === 'string' && Boolean(payload.apiKey.trim())) || payload.clearKey === true) {
            changedKeyId = providerId;
          }
          break;
        }
        case 'deleteProvider': {
          const providerId = validId(payload.id, t('供应商标识'));
          await this.store.deleteProvider(providerId);
          affectedIds = [providerId];
          break;
        }
        case 'exportProviders': {
          const target = payload.target === 'file' ? 'file' : payload.target === 'clipboard' ? 'clipboard' : undefined;
          if (!target) throw new Error(t('请选择有效的导出方式。'));
          const bundle = await this.store.exportProviders(payload.ids);
          for (const provider of bundle.providers) if (provider.apiKey) sensitive.push(provider.apiKey);
          const content = JSON.stringify(bundle, null, 2) + '\n';
          if (target === 'clipboard') {
            await vscode.env.clipboard.writeText(content);
            data = { exported: bundle.providers.length, target };
          } else {
            const defaultName = `byok-providers-${new Date().toISOString().slice(0, 10)}.json`;
            const baseUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            const uri = await vscode.window.showSaveDialog({
              ...(baseUri ? { defaultUri: vscode.Uri.joinPath(baseUri, defaultName) } : {}),
              filters: { JSON: ['json'] },
              saveLabel: t('导出 JSON')
            });
            if (!uri) { data = { canceled: true }; break; }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            data = { exported: bundle.providers.length, target };
          }
          break;
        }
        case 'readImportSource': {
          const source = payload.source === 'file' ? 'file' : payload.source === 'clipboard' ? 'clipboard' : undefined;
          if (!source) throw new Error(t('请选择有效的导入来源。'));
          let content: string;
          if (source === 'clipboard') {
            content = await vscode.env.clipboard.readText();
          } else {
            const uris = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { JSON: ['json'] },
              openLabel: t('选择导入文件')
            });
            const uri = uris?.[0];
            if (!uri) { data = { canceled: true }; break; }
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > MAX_IMPORT_BYTES) throw new Error(t('导入内容超过 16 MiB 大小限制。'));
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error(t('导入内容超过 16 MiB 大小限制。'));
            try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { throw new Error(t('导入内容不是有效的 JSON。')); }
          }
          data = { providers: parseExportBundle(content, this.store.database()) };
          break;
        }
        case 'importProviders': {
          importedIds = await this.store.importProviders({ version: 1, providers: payload.providers });
          affectedIds = importedIds;
          break;
        }
        case 'discoverModels': {
          const provider = validateProvider(payload.provider, this.store.database(), true);
          const key = payload.apiKey === undefined ? await this.store.key(provider.id) ?? '' : text(payload.apiKey, 'API Key', 16000, true);
          sensitive.push(key);
          const controller = new AbortController();
          this.pending.add(controller);
          try { data = await discoverProviderModels(provider, key, controller.signal); }
          finally { this.pending.delete(controller); }
          break;
        }
        case 'openModels': await vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels'); break;
        default: throw new Error(t('不支持的操作。'));
      }
      if (affectedIds) {
        try { await this.applyConfiguration(affectedIds, changedKeyId); }
        catch (error) { throw new Error(t('配置已保存，但写入 Chat 配置失败：{0}', sanitizeError(error, sensitive))); }
        const state = await this.store.uiState();
        data = importedIds ? { state, importedIds } : state;
      }
      await panel.webview.postMessage({ id, ok: true, data });
    } catch (error) {
      if (this.panel !== panel) return;
      try { await panel.webview.postMessage({ id, ok: false, error: sanitizeError(error, sensitive) }); }
      catch { /* The panel may close during an outstanding request. */ }
    }
  }
  dispose(): void { this.stateSubscription.dispose(); this.panel?.dispose(); for (const controller of this.pending) controller.abort(); this.pending.clear(); }
}
