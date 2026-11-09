import * as vscode from 'vscode';
import { validateDatabase } from './core/configuration';
import type { ModelDatabase } from './core/types';
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
  const seed = bundled.database;
  const changed = new vscode.EventEmitter<void>();
  const store = new StudioStore(await createStateStorage(context), context.secrets, seed, () => changed.fire());
  const cached = store.snapshot().catalog;
  let initialBaseline: ModelDatabase | undefined;
  if (store.hasSavedState && !cached) {
    const migrations = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'resources', 'catalog', 'migrations.json'))).toString('utf8')) as { modelsDevBaseline: ModelDatabase; updates: Array<{kind: string; id: string; payload?: unknown}> };
    initialBaseline = validateDatabase(migrations.modelsDevBaseline);
    for (const migration of migrations.updates) {
      const payload = migration.payload;
      switch (migration.kind) {
        case 'add': await store.applyCatalogUpdate(migration.id, initialBaseline, payload as string[]); break;
        case 'replace': await store.applyCatalogReplacements(migration.id, payload as Array<{id:string;before:unknown;after:unknown}>); break;
        case 'revision': await store.applyCatalogRevision(migration.id, payload as Array<{id:string;before:unknown;after:unknown}>); break;
        case 'fields': await store.applyCatalogFields(migration.id, payload as Array<{id:string;before:unknown;after:unknown}>); break;
        case 'dates': await store.applyReleaseDates(migration.id, initialBaseline); break;
        case 'pricing': await store.applyContextPricing(migration.id, initialBaseline); break;
        case 'names': await store.applyDisplayNames(migration.id, payload as Record<string,string>); break;
        default: throw new Error(t('内置目录迁移类型无效。'));
      }
    }
  }
  if (!cached || Date.parse(bundled.updatedAt) > Date.parse(cached.updatedAt)) await store.updateCatalog(bundled, initialBaseline);
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
