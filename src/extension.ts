import * as vscode from 'vscode';
import { validateDatabase } from './core/configuration';
import { StudioStore } from './core/store';
import { SettingsPanel } from './panel';
import { OfficialConfigurationManager } from './officialManager';
import { setLocale, t } from '../media/i18n.js';

export interface ExtensionApi { openSettings(): Promise<void> }
export interface ExtensionTestApi extends ExtensionApi { store: StudioStore; manager: OfficialConfigurationManager }
export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  setLocale(vscode.env.language);
  const seed = validateDatabase(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'data', 'model-parameters.json'))).toString('utf8')));
  const changed = new vscode.EventEmitter<void>();
  const store = new StudioStore(context.globalState, context.secrets, seed, () => changed.fire());
  const migrations = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'data', 'catalog-migrations.json'))).toString('utf8')) as Array<{kind: string; id: string; file?: string; field?: string; ids?: string[]}>;
  for (const migration of migrations) {
    let payload: unknown = migration.ids;
    if (migration.file) {
      if (!/^[a-z0-9.-]+\.json$/i.test(migration.file)) throw new Error(t('内置目录迁移文件名无效。'));
      const loaded = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'data', migration.file))).toString('utf8'));
      payload = migration.field ? loaded[migration.field] : loaded;
    }
    switch (migration.kind) {
      case 'add': await store.applyCatalogUpdate(migration.id, seed, payload as string[]); break;
      case 'replace': await store.applyCatalogReplacements(migration.id, payload as Array<{id:string;before:unknown;after:unknown}>); break;
      case 'revision': await store.applyCatalogRevision(migration.id, payload as Array<{id:string;before:unknown;after:unknown}>); break;
      case 'fields': await store.applyCatalogFields(migration.id, payload as Array<{id:string;before:unknown;after:unknown}>); break;
      case 'dates': await store.applyReleaseDates(migration.id, seed); break;
      case 'pricing': await store.applyContextPricing(migration.id, seed); break;
      case 'names': await store.applyDisplayNames(migration.id, payload as Record<string,string>); break;
      default: throw new Error(t('内置目录迁移类型无效。'));
    }
  }
  const manager = new OfficialConfigurationManager(context, store);
  const panel = new SettingsPanel(context, store, changed.event, changedKeyId => manager.synchronize(changedKeyId));
  context.subscriptions.push(changed, panel,
    vscode.commands.registerCommand('byokStudio.manage', () => panel.open()),
    vscode.commands.registerCommand('byokStudio.openModels', () => vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels')),
    vscode.commands.registerCommand('byokStudio.openOfficialConfiguration', () => manager.openConfiguration())
  );
  const api: ExtensionApi = { openSettings: () => panel.open() };
  if (context.extensionMode !== vscode.ExtensionMode.Test) void manager.synchronize().catch(error => vscode.window.showErrorMessage(t('BYOK Studio 官方配置同步失败：{0}', error instanceof Error ? error.message : t('未知错误'))));
  if (context.extensionMode === vscode.ExtensionMode.Test) return Object.assign(api, { store, manager });
  return api;
}
export function deactivate(): void { }
