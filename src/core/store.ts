import { effectiveParameters, object, text, validateContextPricing, validateDatabase, validateParameters, validateProvider } from './configuration';
import type { ModelDatabase, ProviderConfig, StudioState } from './types';
import { validDate } from '../../media/model-order.js';
import { t } from '../../media/i18n.js';
import { modelRules, type ModelRules } from '../../media/model-vendors.js';

export interface StateStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}
export interface SecretStorage {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}
export interface UiState { providers: Array<ProviderConfig & { hasKey: boolean }>; database: ModelDatabase; revision: number; modelRules: ModelRules }
const STATE_KEY = 'byokStudio.state.v1';
const secretKey = (id: string) => `byokStudio.provider.${id}`;

export class StudioStore {
  private state: StudioState;
  private revision = 0;
  private migrationPending = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: StateStorage, private readonly secrets: SecretStorage, seed: ModelDatabase, private readonly changed: () => void) {
    const saved = storage.get<unknown>(STATE_KEY);
    if (saved === undefined) { this.state = { version: 1, providers: [], database: validateDatabase(seed) }; return; }
    const raw = object(saved, t('已保存配置'));
    if (raw.version !== 1 || !Array.isArray(raw.providers)) throw new Error(t('保存的 BYOK 配置版本不受支持；原始数据未修改。'));
    const database = validateDatabase(raw.database);
    const updates = raw.appliedCatalogUpdates;
    if (updates !== undefined && (!Array.isArray(updates) || updates.some(value => typeof value !== 'string'))) throw new Error(t('保存的参数库更新记录无效；原始数据未修改。'));
    this.state = { version: 1, database, providers: raw.providers.map(p => validateProvider(p, database)), appliedCatalogUpdates: updates as string[] | undefined };
    this.migrationPending = JSON.stringify(raw.providers) !== JSON.stringify(this.state.providers);
  }
  snapshot(): StudioState { return structuredClone(this.state); }
  async uiState(): Promise<UiState> {
    await this.serialize(async () => undefined);
    const snapshot = this.snapshot();
    const revision = this.revision;
    return { providers: await Promise.all(snapshot.providers.map(async p => ({ ...p, hasKey: Boolean(await this.key(p.id)) }))), database: snapshot.database, revision, modelRules: modelRules() };
  }
  key(id: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(secretKey(id))); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      // Persist migration before other writes; a failed write stays pending for retry.
      if (this.migrationPending) {
        await this.storage.update(STATE_KEY, this.snapshot());
        this.migrationPending = false;
      }
      return work();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async commit(next: StudioState): Promise<void> {
    await this.storage.update(STATE_KEY, next);
    this.state = next;
    this.revision++;
    this.changed();
  }
  saveProvider(value: unknown, apiKey?: unknown, clearKey = false): Promise<void> {
    return this.serialize(async () => {
      const next = this.snapshot();
      const provider = validateProvider(value, next.database);
      const previousKey = await this.key(provider.id);
      const replacement = apiKey === undefined || apiKey === '' ? undefined : text(apiKey, 'API Key', 16000);
      if (clearKey && replacement) throw new Error(t('不能同时设置和清除 API Key。'));
      const index = next.providers.findIndex(p => p.id === provider.id);
      if (index < 0) next.providers.push(provider); else next.providers[index] = provider;
      const changingKey = clearKey || replacement !== undefined;
      if (clearKey) await this.secrets.delete(secretKey(provider.id));
      else if (replacement !== undefined) await this.secrets.store(secretKey(provider.id), replacement);
      try { await this.commit(next); }
      catch (error) {
        if (changingKey) {
          if (previousKey === undefined) await this.secrets.delete(secretKey(provider.id));
          else await this.secrets.store(secretKey(provider.id), previousKey);
        }
        throw error;
      }
    });
  }
  deleteProvider(id: string): Promise<void> {
    return this.serialize(async () => {
      const next = this.snapshot();
      if (!next.providers.some(p => p.id === id)) return;
      const key = await this.key(id);
      next.providers = next.providers.filter(p => p.id !== id);
      await this.secrets.delete(secretKey(id));
      try { await this.commit(next); }
      catch (error) { if (key !== undefined) await this.secrets.store(secretKey(id), key); throw error; }
    });
  }
  applyCatalogUpdate(updateId: string, bundled: ModelDatabase, ids: readonly string[]): Promise<void> {
    return this.serialize(async () => {
      if (this.state.appliedCatalogUpdates?.includes(updateId)) return;
      const next = this.snapshot();
      for (const id of ids) {
        if (Object.hasOwn(next.database.models, id)) continue;
        const entry = bundled.models[id];
        if (!entry) throw new Error(t('内置参数库缺少更新条目。'));
        const candidate = structuredClone(next.database);
        candidate.models[id] = structuredClone(entry);
        try { for (const provider of next.providers) validateProvider(provider, candidate); }
        catch { continue; } // Preserve working user overrides if a new preset conflicts.
        next.database = candidate;
      }
      next.appliedCatalogUpdates = [...next.appliedCatalogUpdates ?? [], updateId];
      await this.commit(next);
    });
  }
  applyCatalogReplacements(updateId: string, replacements: readonly { id: string; before: unknown; after: unknown }[]): Promise<void> {
    return this.serialize(async () => {
      if (this.state.appliedCatalogUpdates?.includes(updateId)) return;
      const next = this.snapshot();
      for (const replacement of replacements) {
        const current = next.database.models[replacement.id];
        if (!current || JSON.stringify(current) !== JSON.stringify(validateParameters(replacement.before))) continue;
        const candidate = structuredClone(next.database);
        candidate.models[replacement.id] = validateParameters(replacement.after);
        try { for (const provider of next.providers) validateProvider(provider, candidate); }
        catch { continue; }
        next.database = candidate;
      }
      next.appliedCatalogUpdates = [...next.appliedCatalogUpdates ?? [], updateId];
      await this.commit(next);
    });
  }
  applyCatalogRevision(updateId: string, replacements: readonly { id: string; before: unknown; after: unknown }[]): Promise<void> {
    return this.serialize(async () => {
      if (this.state.appliedCatalogUpdates?.includes(updateId)) return;
      const next = this.snapshot();
      const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
      for (const replacement of replacements) {
        const current = next.database.models[replacement.id];
        if (!current) continue;
        const before = validateParameters(replacement.before);
        const after = validateParameters(replacement.after);
        const specification = (entry: typeof before) => {
          const { name, source, verifiedAt, releaseDate, contextPricing, ...parameters } = entry;
          return parameters;
        };
        // Keep user-maintained capabilities together; presentation and pricing can be maintained independently.
        const candidate = structuredClone(next.database);
        const entry = same(specification(current), specification(before)) ? { ...after, name: current.name } : structuredClone(current);
        if (Object.hasOwn(current, 'releaseDate') && !same(current.releaseDate, before.releaseDate)) entry.releaseDate = current.releaseDate;
        if (current.contextPricing !== undefined && !same(current.contextPricing, before.contextPricing)) entry.contextPricing = current.contextPricing;
        else if (after.contextPricing !== undefined) entry.contextPricing = after.contextPricing;
        candidate.models[replacement.id] = entry;
        try { for (const provider of next.providers) validateProvider(provider, candidate); }
        catch { continue; }
        next.database = candidate;
      }
      next.appliedCatalogUpdates = [...next.appliedCatalogUpdates ?? [], updateId];
      await this.commit(next);
    });
  }
  applyCatalogFields(updateId: string, replacements: readonly { id: string; before: unknown; after: unknown }[]): Promise<void> {
    return this.serialize(async () => {
      if (this.state.appliedCatalogUpdates?.includes(updateId)) return;
      const next = this.snapshot();
      for (const replacement of replacements) {
        const current = next.database.models[replacement.id];
        if (!current) continue;
        const before = validateParameters(replacement.before);
        const after = validateParameters(replacement.after);
        const merged = structuredClone(current) as unknown as Record<string, unknown>;
        const previous = before as unknown as Record<string, unknown>;
        const updated = after as unknown as Record<string, unknown>;
        for (const field of new Set([...Object.keys(previous), ...Object.keys(updated)])) {
          if (JSON.stringify(merged[field]) !== JSON.stringify(previous[field])) continue;
          if (Object.hasOwn(updated, field)) merged[field] = structuredClone(updated[field]);
          else delete merged[field];
        }
        const candidate = structuredClone(next.database);
        try {
          candidate.models[replacement.id] = validateParameters(merged);
          for (const provider of next.providers) for (const model of provider.models) effectiveParameters(candidate, model);
        } catch { continue; }
        next.database = candidate;
      }
      for (const provider of next.providers) for (const model of provider.models) {
        const parameters = effectiveParameters(next.database, model);
        if (model.reasoningEffort && !parameters.supportsReasoningEffort.includes(model.reasoningEffort)) delete model.reasoningEffort;
      }
      next.appliedCatalogUpdates = [...next.appliedCatalogUpdates ?? [], updateId];
      await this.commit(next);
    });
  }
  applyReleaseDates(updateId: string, bundled: ModelDatabase): Promise<void> {
    return this.serialize(async () => {
      if (this.state.appliedCatalogUpdates?.includes(updateId)) return;
      const next = this.snapshot();
      for (const [id, entry] of Object.entries(next.database.models)) {
        const date = bundled.models[id]?.releaseDate;
        if (!Object.hasOwn(entry, 'releaseDate') && validDate(date)) entry.releaseDate = date;
      }
      next.appliedCatalogUpdates = [...next.appliedCatalogUpdates ?? [], updateId];
      await this.commit(next);
    });
  }
  applyContextPricing(updateId: string, bundled: ModelDatabase): Promise<void> {
    return this.serialize(async () => {
      if (this.state.appliedCatalogUpdates?.includes(updateId)) return;
      const next = this.snapshot();
      for (const [id, entry] of Object.entries(next.database.models)) {
        const policy = bundled.models[id]?.contextPricing;
        if (!Object.hasOwn(entry, 'contextPricing') && policy !== undefined) entry.contextPricing = validateContextPricing(policy);
      }
      next.appliedCatalogUpdates = [...next.appliedCatalogUpdates ?? [], updateId];
      await this.commit(next);
    });
  }
  applyDisplayNames(updateId: string, names: Record<string, string>): Promise<void> {
    return this.serialize(async () => {
      if (this.state.appliedCatalogUpdates?.includes(updateId)) return;
      const next = this.snapshot();
      for (const [id, displayName] of Object.entries(names)) {
        const name = text(displayName, t('模型显示名称'), 200);
        const entry = next.database.models[id];
        if (entry && (!entry.name || entry.name === id)) entry.name = name;
      }
      next.appliedCatalogUpdates = [...next.appliedCatalogUpdates ?? [], updateId];
      await this.commit(next);
    });
  }
  saveDatabase(value: unknown): Promise<void> {
    return this.serialize(async () => {
      const next = this.snapshot();
      next.database = validateDatabase(value);
      for (const provider of next.providers) {
        for (const model of provider.models) {
          try { effectiveParameters(next.database, model); }
          catch { throw new Error(t('参数库更新会使“{0}”的手动覆盖无效，请先调整其 Token 参数。', model.name || model.discoveredName || model.id)); }
          const parameters = effectiveParameters(next.database, model);
          if (model.reasoningEffort && (!parameters.thinking || !parameters.supportsReasoningEffort.includes(model.reasoningEffort))) delete model.reasoningEffort;
        }
      }
      await this.commit(next);
    });
  }
}
