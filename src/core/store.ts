import { isDeepStrictEqual } from 'node:util';
import { effectiveParameters, object, text, validateContextPricing, validateDatabase, validateParameters, validateProvider } from './configuration';
import { compileOfficialModel } from './officialConfig';
import type { ApiType, CatalogSnapshot, ModelConfig, ModelDatabase, ModelParameters, ProviderConfig, StudioState } from './types';
import { projectEfforts, validDate } from '../../resources/shared/model-policy.js';
import { t } from '../../resources/shared/i18n.js';
import { modelRules, normalizeRouting, routeForModel, type ModelRules } from '../../resources/shared/routing.js';

export interface StateStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}
export interface SecretStorage {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}
export interface UiState { providers: Array<ProviderConfig & { hasKey: boolean }>; database: ModelDatabase; catalog?: Pick<CatalogSnapshot, 'source' | 'updatedAt'>; revision: number; modelRules: ModelRules }
const STATE_KEY = 'byokStudio.state.v1';
const secretKey = (id: string) => `byokStudio.provider.${id}`;

export function validateCatalogSnapshot(value: unknown): CatalogSnapshot {
  const raw = object(value);
  if (raw.source !== 'models.dev') throw new Error(t('模型目录来源必须是 models.dev。'));
  const timestamp = raw.updatedAt;
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`)) {
    throw new Error(t('模型目录更新时间必须是有效的 UTC ISO 8601 时间戳。'));
  }
  return { source: 'models.dev', updatedAt: timestamp, database: validateDatabase(raw.database) };
}

function mergeCatalogParameters(current: ModelParameters, baseline: ModelParameters, incoming: ModelParameters): ModelParameters {
  const merged = { ...current } as unknown as Record<string, unknown>;
  const previous = baseline as unknown as Record<string, unknown>;
  const updated = incoming as unknown as Record<string, unknown>;
  // Nested profiles and policies are indivisible fields, so a manual nested edit is preserved in full.
  for (const field of new Set([...Object.keys(previous), ...Object.keys(updated)])) {
    if (Object.hasOwn(merged, field) !== Object.hasOwn(previous, field) || !isDeepStrictEqual(merged[field], previous[field])) continue;
    if (Object.hasOwn(updated, field)) merged[field] = updated[field];
    else delete merged[field];
  }
  return validateParameters(merged);
}

export class StudioStore {
  /** Whether persisted state existed at construction; stays fixed for this store instance. */
  readonly hasSavedState: boolean;
  private readonly seedBaseline?: ModelDatabase;
  private state: StudioState;
  private revision = 0;
  private migrationPending = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: StateStorage, private readonly secrets: SecretStorage, seed: ModelDatabase, private readonly changed: () => void) {
    const saved = storage.get<unknown>(STATE_KEY);
    this.hasSavedState = saved !== undefined;
    if (saved === undefined) {
      this.seedBaseline = validateDatabase(seed);
      this.state = { version: 1, providers: [], database: structuredClone(this.seedBaseline) };
      return;
    }
    const raw = object(saved, t('已保存配置'));
    if (raw.version !== 1 || !Array.isArray(raw.providers)) throw new Error(t('保存的 BYOK 配置版本不受支持；原始数据未修改。'));
    const database = validateDatabase(raw.database);
    const updates = raw.appliedCatalogUpdates;
    if (updates !== undefined && (!Array.isArray(updates) || updates.some(value => typeof value !== 'string'))) throw new Error(t('保存的参数库更新记录无效；原始数据未修改。'));
    const catalog = raw.catalog === undefined ? undefined : validateCatalogSnapshot(raw.catalog);
    this.state = { version: 1, database, providers: raw.providers.map(p => validateProvider(p, database)), ...(catalog ? { catalog } : {}), appliedCatalogUpdates: updates as string[] | undefined };
    this.migrationPending = JSON.stringify(raw.providers) !== JSON.stringify(this.state.providers);
  }
  snapshot(): StudioState { return structuredClone(this.state); }
  async uiState(): Promise<UiState> {
    await this.serialize(async () => undefined);
    const snapshot = this.snapshot();
    const revision = this.revision;
    return { providers: await Promise.all(snapshot.providers.map(async p => ({ ...p, hasKey: Boolean(await this.key(p.id)) }))), database: snapshot.database, ...(snapshot.catalog ? { catalog: { source: snapshot.catalog.source, updatedAt: snapshot.catalog.updatedAt } } : {}), revision, modelRules: modelRules() };
  }
  key(id: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(secretKey(id))); }
  private serialize<T>(work: () => Promise<T>, persistMigration = true): Promise<T> {
    const result = this.queue.then(async () => {
      // Catalog updates fold a pending migration into their single atomic commit.
      if (persistMigration && this.migrationPending) {
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
    this.migrationPending = false;
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
  updateCatalog(snapshot: CatalogSnapshot, initialBaseline?: ModelDatabase): Promise<void> {
    return this.serialize(async () => {
      const catalog = validateCatalogSnapshot(snapshot);
      if (!this.state.catalog && this.hasSavedState && initialBaseline === undefined) throw new Error(t('更新旧参数库需要提供初始目录基线。'));
      const baseline = this.state.catalog?.database ?? this.seedBaseline ?? validateDatabase(initialBaseline);
      const next = this.snapshot();
      type Reference = { model: ModelConfig; apiType: ApiType; validEffort: boolean; projectedEffort: boolean; checkCompilation?: (database: ModelDatabase) => void };
      const references = new Map<string, Reference[]>();
      for (const provider of next.providers) {
        const routing = normalizeRouting(provider);
        for (const model of provider.models) {
          const parameters = effectiveParameters(next.database, model);
          const apiType = routeForModel(provider, model.id, routing).apiType;
          const validEffort = Boolean(model.reasoningEffort && parameters.thinking && parameters.supportsReasoningEffort.includes(model.reasoningEffort));
          const projectedEffort = validEffort && projectEfforts(parameters, apiType).levels.includes(model.reasoningEffort!);
          let checkCompilation: Reference['checkCompilation'];
          try {
            compileOfficialModel(provider, next.database, model, routing);
            checkCompilation = database => { compileOfficialModel(provider, database, model, routing); };
          } catch { /* Existing compilation failures must not block unrelated catalog repairs. */ }
          const entries = references.get(model.id) ?? [];
          entries.push({ model, apiType, validEffort, projectedEffort, checkCompilation });
          references.set(model.id, entries);
        }
      }
      const compatible = (database: ModelDatabase, entries: Reference[]): boolean => entries.every(({ model, apiType, validEffort, projectedEffort, checkCompilation }) => {
        const parameters = effectiveParameters(database, model);
        if (validEffort && (!parameters.thinking || !parameters.supportsReasoningEffort.includes(model.reasoningEffort!))) return false;
        if (projectedEffort && !projectEfforts(parameters, apiType).levels.includes(model.reasoningEffort!)) return false;
        checkCompilation?.(database);
        return true;
      });
      const defaultReferences = [...references].filter(([id]) => !Object.hasOwn(next.database.models, id)).flatMap(([, entries]) => entries);
      try {
        const defaults = mergeCatalogParameters(next.database.defaults, baseline.defaults, catalog.database.defaults);
        if (compatible({ ...next.database, defaults }, defaultReferences)) next.database.defaults = defaults;
      } catch { /* Keep a working record when coupled manual fields or overrides conflict. */ }
      for (const [id, incoming] of Object.entries(catalog.database.models)) {
        const current = Object.hasOwn(next.database.models, id) ? next.database.models[id] : undefined;
        const previous = Object.hasOwn(baseline.models, id) ? baseline.models[id] : undefined;
        // Missing current entries are user removals; untracked current entries are custom records.
        if (Boolean(current) !== Boolean(previous)) continue;
        try {
          next.database.models[id] = current && previous ? mergeCatalogParameters(current, previous, incoming) : incoming;
          if (compatible(next.database, references.get(id) ?? [])) continue;
        } catch { /* Roll back only this record, leaving provider settings untouched. */ }
        if (current) next.database.models[id] = current;
        else delete next.database.models[id];
      }
      validateDatabase(next.database);
      // Cache the upstream baseline, never the merged database containing manual edits.
      next.catalog = catalog;
      if (isDeepStrictEqual(next, this.state) && !this.migrationPending) return;
      await this.commit(next);
    }, false);
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
