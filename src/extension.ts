import * as vscode from 'vscode';
import { setLocale, t } from '../resources/shared/i18n.js';
import { ConfigService } from './configService';
import { SettingsPanel } from './panel';
import { createVsCodeAdapter } from './vscodeHost';
import { sanitizeError } from './models';

const CONFIG_SECTION = 'byokStudio';
const SHOW_STATUS_BAR_SETTING = 'showStatusBarItem';
const MANAGE_COMMAND = 'byokStudio.manage';
// Sits directly to the left of VS Code's Copilot/editor-mode cluster (priority 100.1).
const STATUS_BAR_PRIORITY = 100.15;

export interface ExtensionApi {
  openSettings(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  setLocale(vscode.env.language);
  const { host, openOfficialFile } = createVsCodeAdapter(context);
  const service = new ConfigService(host);
  const panel = new SettingsPanel(context, service);
  const openSettings = async (): Promise<void> => {
    try {
      await panel.open();
    } catch (error) {
      void vscode.window.showErrorMessage(t('BYOK Studio：{0}', sanitizeError(error)));
    }
  };

  const statusBarLabel = t('配置 BYOK');
  const statusBarItem = vscode.window.createStatusBarItem(MANAGE_COMMAND, vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
  statusBarItem.name = 'BYOK Studio';
  statusBarItem.text = '$(key)';
  statusBarItem.tooltip = statusBarLabel;
  statusBarItem.accessibilityInformation = { label: statusBarLabel, role: 'button' };
  statusBarItem.command = MANAGE_COMMAND;
  const syncStatusBar = (): void => {
    if (vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SHOW_STATUS_BAR_SETTING, false)) {
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  };

  context.subscriptions.push(
    panel,
    statusBarItem,
    vscode.commands.registerCommand(MANAGE_COMMAND, openSettings),
    vscode.commands.registerCommand('byokStudio.openModels', () =>
      vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels')
    ),
    vscode.commands.registerCommand('byokStudio.openOfficialConfiguration', () => openOfficialFile()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${SHOW_STATUS_BAR_SETTING}`)) syncStatusBar();
    })
  );
  syncStatusBar();
  return { openSettings };
}

export function deactivate(): void {}
