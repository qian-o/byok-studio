import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import { t } from '../resources/shared/i18n.js';
import {
  CATALOG_REFRESH_TTL_MS,
  CATALOG_TTL_MS,
  emptyCatalogSnapshot,
  fetchModelCatalog
} from './catalogBuilder';
import type { ConfigHost } from './configService';
import { listOfficialGroups, removeOfficialGroup } from './jsonc';
import { isSecretReference, validateCatalogSnapshot } from './models';
import type { CatalogSnapshot, ModelDatabase, RoutingHint } from './types';

const ROUTING_HINTS_KEY = 'byokStudio.routing.v1';
const CATALOG_CACHE_FILE = 'models-catalog.json';
const ADD_GROUP_COMMAND = 'lm.addLanguageModelsProviderGroup';
const secretKey = (id: string) => `byokStudio.provider.${id}`;
const normalizeEol = (value: string) => value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

export interface VsCodeConfigAdapter {
  host: ConfigHost;
  openOfficialFile(): Promise<void>;
}

export function createVsCodeAdapter(context: vscode.ExtensionContext): VsCodeConfigAdapter {
  const location = vscode.Uri.joinPath(context.globalStorageUri, '..', '..', 'chatLanguageModels.json');
  const userdataUri = location.with({ scheme: 'vscode-userdata' });
  const fileUri = location.with({ scheme: context.globalStorageUri.scheme });
  const catalogCacheUri = vscode.Uri.joinPath(context.globalStorageUri, CATALOG_CACHE_FILE);

  let cachedCatalog: CatalogSnapshot | undefined;
  let inflightCatalog: Promise<CatalogSnapshot> | undefined;

  let routingHints: Record<string, RoutingHint> = structuredClone(
    context.globalState.get<Record<string, RoutingHint>>(ROUTING_HINTS_KEY, {})
  );

  const isSameConfigUri = (uri: vscode.Uri): boolean =>
    ['file', 'vscode-userdata'].includes(uri.scheme)
    && uri.authority === userdataUri.authority
    && (process.platform === 'win32'
      ? uri.path.toLowerCase() === userdataUri.path.toLowerCase()
      : uri.path === userdataUri.path);

  const ensureNoDirtyOpenDocument = (): void => {
    const open = vscode.workspace.textDocuments.filter(doc => isSameConfigUri(doc.uri));
    if (open.some(doc => doc.isDirty)) {
      throw new Error(t('官方模型配置有未保存修改，请先保存该文件后重试。'));
    }
  };

  const readDiskText = async (): Promise<string | undefined> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(userdataUri);
      return Buffer.from(bytes).toString('utf8');
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound' && userdataUri.toString() === fileUri.toString()) {
        return undefined;
      }
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      return Buffer.from(bytes).toString('utf8');
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return undefined;
      }
      throw error;
    }
  };

  const openOrCreateDocument = async (create: boolean): Promise<vscode.TextDocument | undefined> => {
    ensureNoDirtyOpenDocument();
    const existingOpen = vscode.workspace.textDocuments.find(doc => isSameConfigUri(doc.uri) && doc.uri.scheme === 'vscode-userdata')
      ?? vscode.workspace.textDocuments.find(doc => isSameConfigUri(doc.uri));
    if (existingOpen) return existingOpen;

    try {
      return await vscode.workspace.openTextDocument(userdataUri);
    } catch {
      try {
        return await vscode.workspace.openTextDocument(fileUri);
      } catch (openError) {
        const exists = (await readDiskText()) !== undefined;
        if (exists) throw openError;
        if (!create) return undefined;
        const creation = new vscode.WorkspaceEdit();
        creation.createFile(fileUri, { ignoreIfExists: true, contents: Buffer.from('[]\n', 'utf8') });
        if (!await vscode.workspace.applyEdit(creation)) {
          throw new Error(t('无法创建官方模型配置文件。'));
        }
        return vscode.workspace.openTextDocument(fileUri);
      }
    }
  };

  const waitForBufferSync = async (document: vscode.TextDocument, expectedText: string): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (normalizeEol(document.getText()) !== normalizeEol(expectedText)) {
      if (document.isDirty || Date.now() >= deadline) {
        throw new Error(t('官方配置尚未完成重新加载，请稍后保存重试。'));
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  const ensureCopilotReady = async (): Promise<void> => {
    const official = vscode.extensions.getExtension('GitHub.copilot-chat');
    if (!official) {
      throw new Error(t('请安装或启用官方 GitHub Copilot Chat，再保存模型配置。'));
    }
    await official.activate();
    if (!(await vscode.commands.getCommands(true)).includes(ADD_GROUP_COMMAND)) {
      throw new Error(t('当前 VS Code 未提供官方模型配置命令，请更新 VS Code。'));
    }
  };

  const writeOfficialText = async (expectedBefore: string | undefined, nextText: string): Promise<void> => {
    if (expectedBefore === nextText) return;
    await ensureCopilotReady();
    ensureNoDirtyOpenDocument();

    const diskBefore = await readDiskText();
    if (diskBefore !== expectedBefore) {
      throw new Error(t('官方模型配置在保存期间发生变化，请检查该文件后重试。'));
    }

    const document = await openOrCreateDocument(true);
    if (!document) throw new Error(t('无法创建官方模型配置文件。'));
    const currentExpected = diskBefore ?? '[]\n';
    await waitForBufferSync(document, currentExpected);

    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    edit.set(document.uri, [
      vscode.TextEdit.replace(range, nextText),
      vscode.TextEdit.setEndOfLine(nextText.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF)
    ]);
    if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
      throw new Error(t('无法保存官方模型配置，请检查该文件后重试。'));
    }

    const saved = await readDiskText();
    if (document.isDirty || saved === undefined || !isDeepStrictEqual(listOfficialGroups(saved), listOfficialGroups(nextText))) {
      throw new Error(t('官方模型配置在保存期间发生变化，请检查该文件后重试。'));
    }
    if (saved !== nextText) {
      await vscode.workspace.fs.writeFile(document.uri, Buffer.from(nextText, 'utf8'));
    }
    await waitForBufferSync(document, nextText);
  };

  const host: ConfigHost = {
    async readCatalog(forceRefresh = false, signal?: AbortSignal): Promise<ModelDatabase> {
      if (!cachedCatalog) {
        try {
          const raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(catalogCacheUri)).toString('utf8'));
          cachedCatalog = validateCatalogSnapshot(raw);
        } catch {
          cachedCatalog = undefined;
        }
      }

      const modelCount = cachedCatalog ? Object.keys(cachedCatalog.database.models).length : 0;
      const age = cachedCatalog ? Math.max(0, Date.now() - Date.parse(cachedCatalog.updatedAt)) : Infinity;
      const ttl = forceRefresh ? CATALOG_REFRESH_TTL_MS : CATALOG_TTL_MS;

      const refreshOnline = (): Promise<CatalogSnapshot> => {
        if (!inflightCatalog) {
          inflightCatalog = (async () => {
            const fresh = await fetchModelCatalog();
            cachedCatalog = fresh;
            try {
              await vscode.workspace.fs.createDirectory(context.globalStorageUri);
              await vscode.workspace.fs.writeFile(catalogCacheUri, Buffer.from(JSON.stringify(fresh), 'utf8'));
            } catch {
              // Ignore non-fatal cache write errors.
            }
            return fresh;
          })().finally(() => {
            inflightCatalog = undefined;
          });
        }
        return inflightCatalog;
      };

      if (cachedCatalog && modelCount > 0) {
        if (age <= ttl) return cachedCatalog.database;
        if (!forceRefresh) {
          void refreshOnline().catch(() => {});
          return cachedCatalog.database;
        }
      }

      try {
        const pending = refreshOnline();
        const resolved = signal
          ? await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              })
            ])
          : await pending;
        return resolved.database;
      } catch {
        if (cachedCatalog) return cachedCatalog.database;
        return emptyCatalogSnapshot().database;
      }
    },

    async readOfficialText(): Promise<string | undefined> {
      const text = await readDiskText();
      if (text !== undefined) listOfficialGroups(text);
      return text;
    },

    writeOfficialText,

    async provisionSecretReference(_providerId: string, apiKey: string, beforeText: string | undefined): Promise<{ currentText: string; reference: string }> {
      await ensureCopilotReady();
      ensureNoDirtyOpenDocument();
      const diskNow = await readDiskText();
      if (diskNow !== beforeText) {
        throw new Error(t('官方模型配置在保存期间发生变化，请检查该文件后重试。'));
      }
      const openDoc = vscode.workspace.textDocuments.find(doc => isSameConfigUri(doc.uri));
      if (openDoc && beforeText !== undefined) {
        await waitForBufferSync(openDoc, beforeText);
      }

      const stagingId = `stage-${randomUUID()}`;
      const stagingName = t('BYOK Studio 凭据 {0}', stagingId.slice(6, 14));
      await vscode.commands.executeCommand(ADD_GROUP_COMMAND, {
        name: stagingName,
        vendor: 'customendpoint',
        byokStudioId: stagingId,
        models: [],
        apiKey
      });

      const afterText = await readDiskText();
      if (!afterText) {
        throw new Error(t('VS Code 未返回受保护的密钥引用，未发布模型。'));
      }
      const groups = listOfficialGroups(afterText);
      const staged = groups.find(g => g.vendor === 'customendpoint' && g.byokStudioId === stagingId);
      if (!staged || !isSecretReference(staged.apiKey)) {
        throw new Error(t('VS Code 未返回受保护的密钥引用，未发布模型。'));
      }
      const others = groups.filter(g => g !== staged);
      const expectedOthers = beforeText === undefined ? [] : listOfficialGroups(beforeText);
      if (!isDeepStrictEqual(others, expectedOthers)) {
        await writeOfficialText(afterText, removeOfficialGroup(afterText, stagingId)).catch(() => {});
        throw new Error(t('官方模型配置在保存期间发生变化，请检查该文件后重试。'));
      }
      return { currentText: afterText, reference: staged.apiKey };
    },

    async refreshChatModels(): Promise<void> {
      await vscode.lm.selectChatModels({ vendor: 'customendpoint' });
    },

    getSecret(providerId: string): Promise<string | undefined> {
      return Promise.resolve(context.secrets.get(secretKey(providerId)));
    },

    async setSecret(providerId: string, apiKey: string | undefined): Promise<void> {
      if (apiKey === undefined) await context.secrets.delete(secretKey(providerId));
      else await context.secrets.store(secretKey(providerId), apiKey);
    },

    getRoutingHints(): Record<string, RoutingHint> {
      return structuredClone(routingHints);
    },

    async saveRoutingHints(hints: Record<string, RoutingHint>): Promise<void> {
      const next = structuredClone(hints);
      await context.globalState.update(ROUTING_HINTS_KEY, next);
      routingHints = next;
    }
  };

  const openOfficialFile = async (): Promise<void> => {
    try {
      const document = await openOrCreateDocument(false);
      if (!document) {
        await vscode.window.showInformationMessage(t('尚未保存官方模型配置，请先保存供应商。'));
        return;
      }
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : t('操作失败，请重试。'));
    }
  };

  return { host, openOfficialFile };
}
