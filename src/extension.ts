import * as vscode from 'vscode';
import { StudioStore } from './core/store';
import { validateCatalogSnapshot } from './core/configuration';
import { SettingsPanel } from './panel';
import { OfficialConfigurationManager } from './officialManager';
import { createStateStorage } from './stateStorage';
import { setLocale } from '../resources/shared/i18n.js';

export interface ExtensionApi { openSettings(): Promise<void> }
export interface ExtensionTestApi extends ExtensionApi { store: StudioStore; manager: OfficialConfigurationManager }
export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  setLocale(vscode.env.language);
  const bundled = validateCatalogSnapshot(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'resources', 'catalog', 'models.json'))).toString('utf8')));
  const changed = new vscode.EventEmitter<void>();
  const store = new StudioStore(await createStateStorage(context), context.secrets, bundled.database, () => changed.fire());
  const manager = new OfficialConfigurationManager(context, store);
  const panel = new SettingsPanel(context, store, changed.event, (ids, changedKeyId) => manager.applyProviders(ids, changedKeyId));
  context.subscriptions.push(changed, panel,
    vscode.commands.registerCommand('byokStudio.manage', () => panel.open()),
    vscode.commands.registerCommand('byokStudio.openModels', () => vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels')),
    vscode.commands.registerCommand('byokStudio.openOfficialConfiguration', () => manager.openConfiguration())
  );
  const api: ExtensionApi = { openSettings: () => panel.open() };
  if (context.extensionMode === vscode.ExtensionMode.Test) return Object.assign(api, { store, manager });
  return api;
}
export function deactivate(): void { }
