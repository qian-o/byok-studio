import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { object, sanitizeError, text, validId, validateDatabase, validateProvider } from './core/configuration';
import { StudioStore } from './core/store';
import { discoverProviderModels } from './core/discovery';
import { renderHtml, t } from '../resources/shared/i18n.js';

export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly pending = new Set<AbortController>();
  private readonly stateSubscription: vscode.Disposable;
  constructor(private readonly context: vscode.ExtensionContext, private readonly store: StudioStore, changed: vscode.Event<void>, private readonly synchronizeGroups: (changedKeyId?: string) => Promise<void>) {
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
  private async exportJson(value: unknown, filename: string): Promise<void> {
    const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(require('node:os').homedir()), filename);
    const uri = await vscode.window.showSaveDialog({ defaultUri, filters: { JSON: ['json'] }, saveLabel: t('导出') });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
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
    let sensitive: string | undefined;
    try {
      let data: unknown = null;
      switch (command) {
        case 'getState': data = await this.store.uiState(); break;
        case 'saveProvider':
          sensitive = typeof payload.apiKey === 'string' ? payload.apiKey : undefined;
          await this.store.saveProvider(payload.provider, payload.apiKey, payload.clearKey === true);
          data = await this.store.uiState(); break;
        case 'deleteProvider':
          await this.store.deleteProvider(validId(payload.id, t('供应商标识')));
          data = await this.store.uiState(); break;
        case 'discoverModels': {
          const provider = validateProvider(payload.provider, this.store.snapshot().database, true);
          const key = payload.apiKey === undefined ? await this.store.key(provider.id) ?? '' : text(payload.apiKey, 'API Key', 16000, true);
          sensitive = key;
          const controller = new AbortController();
          this.pending.add(controller);
          try { data = await discoverProviderModels(provider, key, controller.signal); }
          finally { this.pending.delete(controller); }
          break;
        }
        case 'saveDatabase':
          await this.store.saveDatabase(payload.database);
          data = await this.store.uiState(); break;
        case 'importDatabase': {
          const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: t('导入参数库') });
          const file = files?.[0];
          if (file) {
            const stat = await vscode.workspace.fs.stat(file);
            if (stat.size > 10 * 1024 * 1024) throw new Error(t('参数库文件不能超过 10 MB。'));
            const imported = validateDatabase(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8')));
            const confirmed = await vscode.window.showWarningMessage(t('用文件中的 {0} 个模型替换当前参数库？现有模型手动覆盖将保留。', Object.keys(imported.models).length), { modal: true }, t('替换'));
            if (confirmed === t('替换')) await this.store.saveDatabase(imported);
          }
          data = await this.store.uiState(); break;
        }
        case 'exportDatabase':
          await this.exportJson(validateDatabase(payload.database ?? this.store.snapshot().database), 'byok-model-parameters.json'); break;
        case 'exportConfig': {
          const provider = validateProvider(payload.provider, this.store.snapshot().database);
          await this.exportJson({ schemaVersion: 1, provider }, 'byok-provider.json'); break;
        }
        case 'openModels': await vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels'); break;
        default: throw new Error(t('不支持的操作。'));
      }
      if (['saveProvider', 'deleteProvider', 'saveDatabase', 'importDatabase'].includes(command)) {
        const changingKey = command === 'saveProvider' && ((typeof payload.apiKey === 'string' && Boolean(payload.apiKey.trim())) || payload.clearKey === true);
        const changedKeyId = changingKey ? validId(object(payload.provider).id, t('供应商标识')) : undefined;
        await this.synchronizeGroups(changedKeyId);
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
