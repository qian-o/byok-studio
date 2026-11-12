import * as vscode from 'vscode';
import { setLocale } from '../resources/shared/i18n.js';
import { ConfigService } from './configService';
import { SettingsPanel } from './panel';
import { createVsCodeAdapter } from './vscodeHost';

export interface ExtensionApi {
  openSettings(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  setLocale(vscode.env.language);
  const { host, openOfficialFile } = createVsCodeAdapter(context);
  const service = new ConfigService(host);
  const panel = new SettingsPanel(context, service);

  context.subscriptions.push(
    panel,
    vscode.commands.registerCommand('byokStudio.manage', () => panel.open()),
    vscode.commands.registerCommand('byokStudio.openModels', () =>
      vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels')
    ),
    vscode.commands.registerCommand('byokStudio.openOfficialConfiguration', () => openOfficialFile())
  );
  return { openSettings: () => panel.open() };
}

export function deactivate(): void {}
