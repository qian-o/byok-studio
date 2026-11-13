import { t } from '../resources/shared/i18n.js';
import { discoverProviderModels, type DiscoveryResult } from './discovery';
import { findOfficialGroupIndex, listOfficialGroups, removeOfficialGroup, upsertOfficialGroup } from './jsonc';
import {
  asText,
  buildMergedOfficialGroup,
  groupIdentity,
  isSecretReference,
  parseImportData,
  readOfficialGroup,
  validateDatabase,
  validateProvider,
  validId
} from './models';
import type { ExportBundle, ExportedProvider, ModelDatabase, ProviderConfig, ProviderView, RoutingHint, UiState } from './types';

export interface ConfigHost {
  readCatalog(forceRefresh?: boolean, signal?: AbortSignal): Promise<ModelDatabase>;
  readOfficialText(): Promise<string | undefined>;
  writeOfficialText(expectedBefore: string | undefined, nextText: string): Promise<void>;
  provisionSecretReference(providerId: string, apiKey: string, beforeText: string | undefined): Promise<{ currentText: string; reference: string }>;
  refreshChatModels(): Promise<void>;
  getSecret(providerId: string): Promise<string | undefined>;
  setSecret(providerId: string, apiKey: string | undefined): Promise<void>;
  getRoutingHints(): Record<string, RoutingHint>;
  saveRoutingHints(hints: Record<string, RoutingHint>): Promise<void>;
}

export class ConfigService {
  private rawCatalogRef: ModelDatabase | undefined;
  private cachedDatabase: ModelDatabase | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: ConfigHost) {}

  async database(forceRefresh = false, signal?: AbortSignal): Promise<ModelDatabase> {
    if (!this.cachedDatabase || forceRefresh) {
      const next = await this.host.readCatalog(forceRefresh, signal);
      if (next !== this.rawCatalogRef || !this.cachedDatabase) {
        this.cachedDatabase = validateDatabase(next);
        this.rawCatalogRef = next;
      }
    }
    return this.cachedDatabase;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readCurrentState(database: ModelDatabase): Promise<UiState> {
    const rawText = await this.host.readOfficialText();
    if (rawText === undefined) {
      return { providers: [], database };
    }
    const groups = listOfficialGroups(rawText);
    const hints = this.host.getRoutingHints();
    const providers: ProviderView[] = [];
    for (const group of groups) {
      const id = groupIdentity(group);
      const parsed = readOfficialGroup(group, database, id ? hints[id] : undefined);
      if (!parsed) continue;
      const hasSecret = Boolean(await this.host.getSecret(parsed.id));
      const hasKey = hasSecret || isSecretReference(group.apiKey);
      providers.push({ ...parsed, hasKey });
    }
    return { providers, database };
  }

  getUiState(): Promise<UiState> {
    return this.serialize(async () => {
      const db = await this.database();
      return this.readCurrentState(db);
    });
  }

  saveProvider(rawProvider: unknown, rawApiKey?: unknown): Promise<UiState> {
    return this.serialize(async () => {
      const db = await this.database();
      const provider = validateProvider(rawProvider, db);
      const newKey = rawApiKey === undefined || rawApiKey === null || rawApiKey === ''
        ? undefined
        : asText(rawApiKey, 'API Key', 16000);

      const initialText = await this.host.readOfficialText();
      const baseText = initialText ?? '[]\n';
      const groups = listOfficialGroups(baseText);
      const existingIndex = findOfficialGroupIndex(groups, provider.id);
      if (groups.some((g, i) => i !== existingIndex && g.vendor === 'customendpoint' && g.name === provider.name)) {
        throw new Error(t('官方配置已有同名分组“{0}”，请修改供应商名称后重试。', provider.name));
      }

      const existingGroup = existingIndex >= 0 ? groups[existingIndex] : undefined;
      let diskText: string | undefined = initialText;
      let secretRef = isSecretReference(existingGroup?.apiKey) ? existingGroup.apiKey : undefined;
      const keyToProvision = newKey ?? (!secretRef ? await this.host.getSecret(provider.id) : undefined);

      if (keyToProvision) {
        const provisioned = await this.host.provisionSecretReference(provider.id, keyToProvision, diskText);
        diskText = provisioned.currentText;
        secretRef = provisioned.reference;
      }

      const mergedGroup = buildMergedOfficialGroup(provider, db, existingGroup, secretRef);
      const finalText = upsertOfficialGroup(baseText, provider.id, mergedGroup);
      await this.host.writeOfficialText(diskText, finalText);

      if (newKey !== undefined) {
        await this.host.setSecret(provider.id, newKey);
      }
      const hints = {
        ...this.host.getRoutingHints(),
        [provider.id]: {
          routingMode: provider.routingMode,
          unified: provider.unified,
          endpoints: provider.endpoints
        }
      };
      await this.host.saveRoutingHints(hints);
      await this.host.refreshChatModels();
      return this.readCurrentState(db);
    });
  }

  deleteProvider(rawId: unknown): Promise<UiState> {
    return this.serialize(async () => {
      const db = await this.database();
      const id = validId(rawId, t('供应商标识'));
      const initialText = await this.host.readOfficialText();
      if (initialText !== undefined) {
        const nextText = removeOfficialGroup(initialText, id);
        if (nextText !== initialText) {
          await this.host.writeOfficialText(initialText, nextText);
          await this.host.refreshChatModels();
        }
      }
      await this.host.setSecret(id, undefined);
      const hints = { ...this.host.getRoutingHints() };
      if (Object.hasOwn(hints, id)) {
        delete hints[id];
        await this.host.saveRoutingHints(hints);
      }
      return this.readCurrentState(db);
    });
  }

  exportProviders(rawIds: unknown): Promise<ExportBundle> {
    return this.serialize(async () => {
      const db = await this.database();
      if (!Array.isArray(rawIds) || !rawIds.length) {
        throw new Error(t('请至少选择一个要导出的供应商。'));
      }
      const selected = new Set(rawIds.map(item => validId(item, t('供应商标识'))));
      const { providers: current } = await this.readCurrentState(db);
      const matched = current.filter(p => selected.has(p.id));
      if (matched.length !== selected.size) {
        throw new Error(t('部分所选供应商不存在，请重新选择后再导出。'));
      }
      const providers: ExportedProvider[] = await Promise.all(matched.map(async ({ hasKey: _hasKey, ...provider }) => {
        const apiKey = await this.host.getSecret(provider.id);
        return apiKey ? { ...provider, apiKey } : provider;
      }));
      return { version: 1, exportedAt: new Date().toISOString(), providers };
    });
  }

  importProviders(rawProviders: unknown): Promise<{ state: UiState; importedIds: string[] }> {
    return this.serialize(async () => {
      const db = await this.database();
      const incoming = parseImportData({ version: 1, providers: rawProviders }, db);
      const initialText = await this.host.readOfficialText();
      const baseText = initialText ?? '[]\n';
      const initialGroups = listOfficialGroups(baseText);

      const planned: Array<{
        provider: ProviderConfig;
        apiKey?: string;
        existingGroup?: Record<string, unknown>;
        existingIndex: number;
      }> = [];
      const claimedIndices = new Set<number>();
      const claimedIds = new Set<string>();

      for (const entry of incoming) {
        const { apiKey, ...rest } = entry;
        let matchIndex = findOfficialGroupIndex(initialGroups, rest.id);
        if (matchIndex < 0) {
          matchIndex = initialGroups.findIndex(g => g.vendor === 'customendpoint' && g.name === rest.name);
        }
        const existingGroup = matchIndex >= 0 ? initialGroups[matchIndex] : undefined;
        const targetId = existingGroup ? (groupIdentity(existingGroup) ?? rest.id) : rest.id;

        if ((matchIndex >= 0 && claimedIndices.has(matchIndex)) || claimedIds.has(targetId)) {
          throw new Error(t('供应商名称“{0}”与本机现有其他供应商冲突，请先修改后再导入。', rest.name));
        }
        if (matchIndex >= 0) claimedIndices.add(matchIndex);
        claimedIds.add(targetId);

        planned.push({
          provider: { ...rest, id: targetId },
          apiKey,
          existingGroup,
          existingIndex: matchIndex
        });
      }

      const incomingNames = new Map(planned.map(p => [p.provider.name, p.provider.name]));
      for (let idx = 0; idx < initialGroups.length; idx++) {
        if (claimedIndices.has(idx)) continue;
        const group = initialGroups[idx]!;
        if (group.vendor === 'customendpoint' && typeof group.name === 'string' && incomingNames.has(group.name)) {
          throw new Error(t('供应商名称“{0}”与本机现有其他供应商冲突，请先修改后再导入。', group.name));
        }
      }

      let diskText: string | undefined = initialText;
      const secretRefs = new Map<string, string | undefined>();

      try {
        for (const item of planned) {
          let ref = isSecretReference(item.existingGroup?.apiKey) ? item.existingGroup.apiKey : undefined;
          const keyToProvision = item.apiKey ?? (!ref ? await this.host.getSecret(item.provider.id) : undefined);
          if (keyToProvision) {
            const provisioned = await this.host.provisionSecretReference(item.provider.id, keyToProvision, diskText);
            diskText = provisioned.currentText;
            ref = provisioned.reference;
          }
          secretRefs.set(item.provider.id, ref);
        }
      } catch (error) {
        if (diskText !== initialText) {
          await this.host.writeOfficialText(diskText, initialText ?? '[]\n').catch(() => {});
        }
        throw error;
      }

      let currentText = baseText;
      for (const item of planned) {
        if (item.existingIndex >= 0) {
          currentText = removeOfficialGroup(currentText, item.provider.id);
        }
      }
      for (const item of planned) {
        const merged = buildMergedOfficialGroup(item.provider, db, item.existingGroup, secretRefs.get(item.provider.id));
        currentText = upsertOfficialGroup(currentText, item.provider.id, merged);
      }

      await this.host.writeOfficialText(diskText, currentText);

      const hints = { ...this.host.getRoutingHints() };
      for (const item of planned) {
        if (item.apiKey !== undefined) {
          await this.host.setSecret(item.provider.id, item.apiKey);
        }
        hints[item.provider.id] = {
          routingMode: item.provider.routingMode,
          unified: item.provider.unified,
          endpoints: item.provider.endpoints
        };
      }
      await this.host.saveRoutingHints(hints);
      await this.host.refreshChatModels();

      return {
        state: await this.readCurrentState(db),
        importedIds: planned.map(item => item.provider.id)
      };
    });
  }

  async discoverModels(
    rawProvider: unknown,
    rawApiKey: unknown,
    signal: AbortSignal
  ): Promise<DiscoveryResult & { database?: ModelDatabase }> {
    const initialDb = await this.database(false, signal);
    const beforeRef = this.rawCatalogRef;
    const provider = validateProvider(rawProvider, initialDb, true);
    const key = rawApiKey === undefined || rawApiKey === null || rawApiKey === ''
      ? (await this.host.getSecret(provider.id) ?? '')
      : asText(rawApiKey, 'API Key', 16000, true);
    const [discovered, refreshedDb] = await Promise.all([
      discoverProviderModels(provider, key, signal),
      this.database(true, signal).catch(() => initialDb)
    ]);
    return this.rawCatalogRef !== beforeRef
      ? { models: discovered.models, database: refreshedDb }
      : { models: discovered.models };
  }
}
