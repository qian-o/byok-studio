import { isDeepStrictEqual } from 'node:util';
import { object, text, validId, validateDatabase, validateProvider } from './configuration';
import { compileOfficialModel } from './officialConfig';
import { validateCatalogSnapshot } from './modelCatalog';
import { upgradeDatabase, upgradeProvider } from './legacyState';
import type { CatalogSnapshot, ExportBundle, ExportedProvider, ModelDatabase, ProviderConfig, StudioState } from './types';
import { t } from '../../resources/shared/i18n.js';
import { modelRules, normalizeRouting, type ModelRules } from '../../resources/shared/routing.js';

export { validateCatalogSnapshot };

export interface StateStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}
export interface SecretStorage {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}
export interface UiState {
  providers: Array<ProviderConfig & { hasKey: boolean }>;
  database: ModelDatabase;
  catalog?: Pick<CatalogSnapshot, 'source' | 'updatedAt'>;
  revision: number;
  modelRules: ModelRules;
}

const STATE_KEY = 'byokStudio.state.v1';
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const secretKey = (id: string) => `byokStudio.provider.${id}`;

function checkedProvider(value: unknown, database: ModelDatabase): ProviderConfig {
  const raw = object(value), provider = validateProvider(raw, database);
  const originals = new Map((raw.models as Record<string, unknown>[]).map(model => [String(model.id).trim(), model]));
  for (const model of provider.models) {
    const original = originals.get(model.id)!;
    if (original.reasoningEffort != null && original.reasoningEffort !== '' && model.reasoningEffort !== original.reasoningEffort) {
      throw new Error(t('模型 {0} 的推理档位 {1} 需要官方配置暂不支持的参数。请选择其他档位或恢复默认。', model.id, String(original.reasoningEffort)));
    }
  }
  const routing = normalizeRouting(provider);
  // Disabled providers can omit addresses, but their model parameters still need to compile.
  if (!provider.enabled) {
    routing.unified.url ||= 'https://validation.invalid';
    for (const api of ['responses', 'chatCompletions', 'messages'] as const) routing.endpoints[api] ||= 'https://validation.invalid';
  }
  for (const model of provider.models) compileOfficialModel(provider, database, model, routing);
  return provider;
}

export function parseExportBundle(value: unknown, database: ModelDatabase): ExportedProvider[] {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_IMPORT_BYTES) throw new Error(t('导入内容超过 16 MiB 大小限制。'));
    if (!value.trim()) throw new Error(t('未读取到有效的配置内容。'));
    try { value = JSON.parse(value.replace(/^\uFEFF/, '')); }
    catch { throw new Error(t('导入内容不是有效的 JSON。')); }
  }
  const raw = Array.isArray(value) ? { version: 1, providers: value } : object(value, t('导入的配置'));
  if (raw.version !== 1 || !Array.isArray(raw.providers)) throw new Error(t('导入的配置格式或版本不受支持。'));
  if (!raw.providers.length || raw.providers.length > 200) throw new Error(t('导入的供应商数量必须在 1–200 之间。'));
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  return raw.providers.map(entry => {
    const item = object(entry, t('供应商'));
    const provider = checkedProvider(item, database);
    if (seenIds.has(provider.id) || seenNames.has(provider.name)) throw new Error(t('导入的配置包含重复的供应商标识或名称。'));
    seenIds.add(provider.id);
    seenNames.add(provider.name);
    const apiKey = item.apiKey === undefined || item.apiKey === null || item.apiKey === '' ? undefined : text(item.apiKey, 'API Key', 16000);
    return apiKey === undefined ? provider : { ...provider, apiKey };
  });
}

export class StudioStore {
  private readonly bundled: ModelDatabase;
  private state: StudioState;
  private revision = 0;
  private migrationPending = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: StateStorage, private readonly secrets: SecretStorage, seed: ModelDatabase, private readonly changed: () => void) {
    this.bundled = validateDatabase(seed);
    const saved = storage.get<unknown>(STATE_KEY);
    if (saved === undefined) {
      this.state = { version: 1, providers: [] };
      return;
    }
    const raw = object(saved, t('已保存配置'));
    if (raw.version !== 1 || !Array.isArray(raw.providers)) throw new Error(t('保存的 BYOK 配置版本不受支持；原始数据未修改。'));
    const cached = raw.catalog === undefined ? undefined : object(raw.catalog);
    const catalog = cached === undefined ? undefined : validateCatalogSnapshot({ ...cached, database: upgradeDatabase(cached.database) });
    const activeDatabase = catalog?.database ?? this.bundled;
    const previous = raw.database === undefined ? undefined : upgradeDatabase(raw.database);
    const providers = raw.providers.map(p => {
      if (previous) checkedProvider(p, previous);
      return checkedProvider(previous ? upgradeProvider(p, previous, activeDatabase, raw.database) : p, activeDatabase);
    });
    if (new Set(providers.map(p => p.id)).size !== providers.length) throw new Error(t('保存的供应商标识重复；原始数据未修改。'));
    this.state = { version: 1, providers, ...(catalog ? { catalog } : {}) };
    this.migrationPending = !isDeepStrictEqual(raw, this.state);
  }

  snapshot(): StudioState { return structuredClone(this.state); }
  database(): ModelDatabase { return structuredClone(this.state.catalog?.database ?? this.bundled); }

  async uiState(): Promise<UiState> {
    await this.serialize(async () => {
      if (this.migrationPending) {
        await this.storage.update(STATE_KEY, this.snapshot());
        this.migrationPending = false;
      }
    });
    const snapshot = this.snapshot();
    const database = this.database();
    const revision = this.revision;
    return {
      providers: await Promise.all(snapshot.providers.map(async p => ({ ...p, hasKey: Boolean(await this.key(p.id)) }))),
      database,
      ...(snapshot.catalog ? { catalog: { source: snapshot.catalog.source, updatedAt: snapshot.catalog.updatedAt } } : {}),
      revision,
      modelRules: modelRules()
    };
  }

  key(id: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(secretKey(id))); }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async commit(next: StudioState): Promise<void> {
    await this.storage.update(STATE_KEY, next);
    this.state = next;
    this.migrationPending = false;
    this.revision++;
    this.changed();
  }

  private async commitWithKeys(next: StudioState, keys: ReadonlyMap<string, string | undefined>): Promise<void> {
    const previous = new Map(await Promise.all([...keys.keys()].map(async id => [id, await this.key(id)] as const)));
    const attempted: string[] = [];
    const writeKey = (id: string, value: string | undefined) => value === undefined
      ? this.secrets.delete(secretKey(id)) : this.secrets.store(secretKey(id), value);
    try {
      for (const [id, key] of keys) {
        attempted.push(id);
        await writeKey(id, key);
      }
      await this.commit(next);
    } catch (error) {
      const failures: unknown[] = [];
      for (const id of attempted.reverse()) {
        try { await writeKey(id, previous.get(id)); }
        catch (rollbackError) { failures.push(rollbackError); }
      }
      if (failures.length) throw new Error(t('保存失败，部分 API Key 未能恢复，请检查供应商密钥后重试。'), { cause: new AggregateError([error, ...failures]) });
      throw error;
    }
  }

  saveProvider(value: unknown, apiKey?: unknown, clearKey = false): Promise<void> {
    return this.serialize(async () => {
      const next = this.snapshot();
      const provider = checkedProvider(value, this.database());
      const replacement = apiKey === undefined || apiKey === '' ? undefined : text(apiKey, 'API Key', 16000);
      if (clearKey && replacement) throw new Error(t('不能同时设置和清除 API Key。'));
      const index = next.providers.findIndex(p => p.id === provider.id);
      if (index < 0) next.providers.push(provider); else next.providers[index] = provider;
      const keys = new Map<string, string | undefined>();
      if (clearKey || replacement !== undefined) keys.set(provider.id, clearKey ? undefined : replacement);
      await this.commitWithKeys(next, keys);
    });
  }

  deleteProvider(id: string): Promise<void> {
    return this.serialize(async () => {
      const next = this.snapshot();
      if (!next.providers.some(p => p.id === id)) return;
      next.providers = next.providers.filter(p => p.id !== id);
      await this.commitWithKeys(next, new Map([[id, undefined]]));
    });
  }

  exportProviders(ids: unknown): Promise<ExportBundle> {
    return this.serialize(async () => {
      if (!Array.isArray(ids) || !ids.length) throw new Error(t('请至少选择一个要导出的供应商。'));
      const selected = new Set(ids.map(item => validId(item, t('供应商标识'))));
      const matched = this.snapshot().providers.filter(provider => selected.has(provider.id));
      if (matched.length !== selected.size) throw new Error(t('部分所选供应商不存在，请重新选择后再导出。'));
      const providers: ExportedProvider[] = await Promise.all(matched.map(async provider => {
        const apiKey = await this.key(provider.id);
        return apiKey ? { ...provider, apiKey } : provider;
      }));
      return { version: 1, exportedAt: new Date().toISOString(), providers };
    });
  }

  importProviders(value: unknown): Promise<string[]> {
    return this.serialize(async () => {
      const incoming = parseExportBundle(value, this.database());
      const next = this.snapshot();
      const importedIds = new Set<string>();
      const keys = new Map<string, string>();
      for (const entry of incoming) {
        const { apiKey, ...rest } = entry;
        const existing = this.state.providers.find(item => item.id === rest.id)
          ?? this.state.providers.find(item => item.name === rest.name);
        const targetId = existing?.id ?? rest.id;
        if (importedIds.has(targetId) || this.state.providers.some(item => item.id !== targetId && item.name === rest.name)) {
          throw new Error(t('供应商名称“{0}”与本机现有其他供应商冲突，请先修改后再导入。', rest.name));
        }
        importedIds.add(targetId);
        const provider: ProviderConfig = { ...rest, id: targetId };
        const index = next.providers.findIndex(item => item.id === targetId);
        if (index < 0) next.providers.push(provider);
        else next.providers[index] = provider;
        if (apiKey !== undefined) keys.set(targetId, apiKey);
      }
      await this.commitWithKeys(next, keys);
      return [...importedIds];
    });
  }

  updateCatalog(snapshot: CatalogSnapshot): Promise<void> {
    return this.serialize(async () => {
      const incoming = validateCatalogSnapshot(snapshot);
      if (this.state.catalog && Date.parse(incoming.updatedAt) < Date.parse(this.state.catalog.updatedAt)) {
        throw new Error(t('目录更新早于当前缓存，未保存任何更改。'));
      }
      const next = this.snapshot();
      for (const provider of next.providers) {
        try { checkedProvider(provider, incoming.database); }
        catch (error) {
          throw new Error(t('目录更新与供应商 {0} 的模型配置不兼容，未保存任何更改：{1}', provider.name, error instanceof Error ? error.message : t('操作失败。')));
        }
      }
      next.catalog = incoming;
      if (isDeepStrictEqual(next, this.state) && !this.migrationPending) return;
      await this.commit(next);
    });
  }
}
