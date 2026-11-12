import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { renderHtml, t } from '../resources/shared/i18n.js';
import type { ConfigService } from './configService';
import { asObject, asText, isRecord, MAX_IMPORT_BYTES, parseImportData, sanitizeError } from './models';

export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly pending = new Set<AbortController>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ConfigService
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const resources = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    const panel = vscode.window.createWebviewPanel(
      'byokStudio.settings',
      t('BYOK Studio · 模型设置'),
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [resources], retainContextWhenHidden: true }
    );
    this.panel = panel;

    const receive = panel.webview.onDidReceiveMessage(message => {
      void this.handle(message, panel);
    });
    panel.onDidDispose(() => {
      receive.dispose();
      for (const controller of this.pending) controller.abort();
      this.pending.clear();
      if (this.panel === panel) this.panel = undefined;
    });

    const rawHtml = Buffer.from(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(resources, 'webview', 'index.html'))
    ).toString('utf8');
    const nonce = randomBytes(24).toString('base64');
    panel.webview.html = renderHtml(rawHtml)
      .replace(/\{\{resource:((?:webview|shared)\/[a-z0-9.-]+)\}\}/g, (_, relPath: string) =>
        panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, ...relPath.split('/'))).toString()
      )
      .replace(/\{\{CSP_SOURCE\}\}/g, panel.webview.cspSource)
      .replace(/\{\{NONCE\}\}/g, nonce);
  }

  private async handle(message: unknown, panel: vscode.WebviewPanel): Promise<void> {
    let id: string;
    let command: string;
    let payload: Record<string, unknown>;
    try {
      const envelope = asObject(message);
      id = asText(envelope.id, 'id', 100);
      command = asText(envelope.command, 'command', 50);
      payload = envelope.payload == null ? {} : asObject(envelope.payload);
    } catch {
      return;
    }

    const sensitive: string[] = [];
    if (typeof payload.apiKey === 'string') sensitive.push(payload.apiKey);
    if (Array.isArray(payload.providers)) {
      for (const entry of payload.providers) {
        if (isRecord(entry) && typeof entry.apiKey === 'string') sensitive.push(entry.apiKey);
      }
    }

    try {
      let data: unknown = null;
      switch (command) {
        case 'getState':
          data = await this.service.getUiState();
          break;

        case 'saveProvider':
          data = await this.service.saveProvider(payload.provider, payload.apiKey);
          break;

        case 'deleteProvider':
          data = await this.service.deleteProvider(payload.id);
          break;

        case 'discoverModels': {
          const controller = new AbortController();
          this.pending.add(controller);
          try {
            data = await this.service.discoverModels(payload.provider, payload.apiKey, controller.signal);
          } finally {
            this.pending.delete(controller);
          }
          break;
        }

        case 'exportProviders': {
          const target = payload.target === 'file' ? 'file' : payload.target === 'clipboard' ? 'clipboard' : undefined;
          if (!target) throw new Error(t('请选择有效的导出方式。'));
          const bundle = await this.service.exportProviders(payload.ids);
          for (const provider of bundle.providers) {
            if (provider.apiKey) sensitive.push(provider.apiKey);
          }
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
          data = { providers: parseImportData(content, await this.service.database()) };
          break;
        }

        case 'importProviders':
          data = await this.service.importProviders(payload.providers);
          break;

        default:
          throw new Error(t('不支持的操作。'));
      }
      await panel.webview.postMessage({ id, ok: true, data });
    } catch (error) {
      if (this.panel !== panel) return;
      try {
        await panel.webview.postMessage({ id, ok: false, error: sanitizeError(error, sensitive) });
      } catch { /* Panel closed while request was in flight. */ }
    }
  }

  dispose(): void {
    this.panel?.dispose();
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
}
