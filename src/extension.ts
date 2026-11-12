import * as vscode from 'vscode';
import { StudioStore, validateCatalogSnapshot } from './core/store';
import { SettingsPanel } from './panel';
import { OfficialConfigurationManager } from './officialManager';
import { createStateStorage } from './stateStorage';
import { setLocale, t } from '../resources/shared/i18n.js';

export interface ExtensionApi { openSettings(): Promise<void> }
export interface ExtensionTestApi extends ExtensionApi { store: StudioStore; manager: OfficialConfigurationManager }
export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  setLocale(vscode.env.language);
  const bundled = validateCatalogSnapshot(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'resources', 'catalog', 'models.json'))).toString('utf8')));
  const changed = new vscode.EventEmitter<void>();
  const store = new StudioStore(await createStateStorage(context), context.secrets, bundled.database, () => changed.fire());
  const cached = store.snapshot().catalog;
  if (!cached || Date.parse(bundled.updatedAt) > Date.parse(cached.updatedAt)) {
    try { await store.updateCatalog(bundled); }
    catch (error) { void vscode.window.showErrorMessage(t('BYOK Studio 模型目录更新失败：{0}', error instanceof Error ? error.message : t('未知错误'))); }
  }
  const manager = new OfficialConfigurationManager(context, store);
  const panel = new SettingsPanel(context, store, changed.event, changedKeyId => manager.synchronize(changedKeyId));
  context.subscriptions.push(changed, panel,
    vscode.commands.registerCommand('byokStudio.manage', () => panel.open()),
    vscode.commands.registerCommand('byokStudio.openModels', () => vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels')),
    vscode.commands.registerCommand('byokStudio.openOfficialConfiguration', () => manager.openConfiguration())
  );
  const api: ExtensionApi = { openSettings: () => panel.open() };
  if (context.extensionMode !== vscode.ExtensionMode.Test) void manager.synchronize().catch(error => vscode.window.showErrorMessage(t('BYOK Studio 官方配置写入失败：{0}', error instanceof Error ? error.message : t('未知错误'))));
  if (context.extensionMode === vscode.ExtensionMode.Test) return Object.assign(api, { store, manager });
  return api;
}
export function deactivate(): void { }
