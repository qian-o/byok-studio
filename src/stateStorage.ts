import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { t } from '../resources/shared/i18n.js';
import type { StateStorage } from './core/store';

const STATE_KEY = 'byokStudio.state.v1';

export async function createStateStorage(context: Pick<vscode.ExtensionContext, 'globalState' | 'globalStorageUri'>): Promise<StateStorage> {
  const { globalState, globalStorageUri } = context;
  const stateUri = vscode.Uri.joinPath(globalStorageUri, 'studio-state.json');
  let state: unknown;
  let bytes: Uint8Array | undefined;
  try {
    bytes = await vscode.workspace.fs.readFile(stateUri);
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
      throw new Error(t('无法读取 BYOK Studio 本地状态；原始数据未修改。'));
    }
    state = structuredClone(globalState.get<unknown>(STATE_KEY));
  }
  if (bytes !== undefined) {
    try {
      state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error(t('BYOK Studio 本地状态不是有效的 UTF-8 JSON；原始数据未修改。'));
    }
  }

  let queue: Promise<void> = Promise.resolve();
  return {
    get<T>(key: string): T | undefined {
      return key === STATE_KEY ? structuredClone(state) as T | undefined : globalState.get<T>(key);
    },
    async update(key: string, value: unknown): Promise<void> {
      if (key !== STATE_KEY) return globalState.update(key, value);
      let content: Uint8Array;
      let next: unknown;
      try {
        // Capture the caller's value before waiting for earlier writes.
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error();
        content = Buffer.from(serialized, 'utf8');
        next = JSON.parse(serialized);
      } catch {
        throw new Error(t('无法保存 BYOK Studio 本地状态；已保存的数据未修改。'));
      }
      const pending = queue.then(async () => {
        const temporaryUri = vscode.Uri.joinPath(globalStorageUri, `studio-state.${randomUUID()}.tmp`);
        try {
          await vscode.workspace.fs.createDirectory(globalStorageUri);
          await vscode.workspace.fs.writeFile(temporaryUri, content);
          await vscode.workspace.fs.rename(temporaryUri, stateUri, { overwrite: true });
          state = next;
        } catch {
          throw new Error(t('无法保存 BYOK Studio 本地状态；已保存的数据未修改。'));
        } finally {
          try { await vscode.workspace.fs.delete(temporaryUri); } catch { /* Best-effort staging cleanup. */ }
        }
        // The file is committed; legacy cleanup must not turn success into a failed save.
        try {
          if (globalState.get(STATE_KEY) !== undefined) await globalState.update(STATE_KEY, undefined);
        } catch { /* A later successful save can retry; the file always takes precedence. */ }
      });
      queue = pending.catch(() => undefined);
      return pending;
    }
  };
}
