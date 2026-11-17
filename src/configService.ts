import { t } from '../resources/shared/i18n.js';
import { discoverGroupModels, type DiscoveryResult } from './discovery';
import { officialGroupName } from '../resources/shared/routing.js';
import { findOfficialGroupIndex, listOfficialGroups, removeOfficialGroup, upsertOfficialGroup } from './jsonc';
import {
  asText,
  buildMergedOfficialGroup,
  groupIdentity,
  isSecretReference,
  parseImportData,
  readOfficialGroup,
  validateDatabase,
  validateGroup,
  validateProviderInfo,
  validId
} from './models';
import type { ExportBundle, ExportedProvider, GroupConfig, ModelDatabase, ProviderInfo, ProviderView, RoutingHint, UiState } from './types';

interface GroupWrite {
  provider: ProviderInfo;
  group: GroupConfig;
  officialName: string;
  existingGroup?: Record<string, unknown>;
  apiKey?: string;
  renameOnly?: boolean;
}

export interface ConfigHost {
  readCatalog(forceRefresh?: boolean, signal?: AbortSignal): Promise<ModelDatabase>;
  readOfficialText(): Promise<string | undefined>;
  writeOfficialText(expectedBefore: string | undefined, nextText: string): Promise<void>;
  provisionSecretReference(groupId: string, apiKey: string, beforeText: string | undefined): Promise<{ currentText: string; reference: string }>;
  refreshChatModels(): Promise<void>;
  getSecret(groupId: string): Promise<string | undefined>;
  setSecret(groupId: string, apiKey: string | undefined): Promise<void>;
  getRoutingHints(): Record<string, RoutingHint>;
  saveRoutingHints(hints: Record<string, RoutingHint>): Promise<void>;
}

export class ConfigService {
  private rawCatalogRef: ModelDatabase | undefined;
  private cachedDatabase: ModelDatabase | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshPending = false;

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

  private hint(group: GroupConfig, provider: ProviderInfo, officialName: string, secretReference?: string): RoutingHint {
    return {
      routingMode: group.routingMode,
      unified: group.unified,
      endpoints: group.endpoints,
      officialName,
      providerId: provider.id,
      providerName: provider.name,
      groupName: group.name,
      secretReference
    };
  }

  private async readCurrentState(database: ModelDatabase, snapshot?: string): Promise<UiState> {
    const rawText = snapshot ?? await this.host.readOfficialText();
    if (rawText === undefined) {
      return { providers: [], database };
    }
    const groups = listOfficialGroups(rawText);
    const hints = this.host.getRoutingHints();
    const providers: ProviderView[] = [];
    for (const group of groups) {
      if (group.byokStudioStageFor !== undefined) continue;
      const id = groupIdentity(group);
      const parsed = readOfficialGroup(group, database, id ? hints[id] : undefined);
      if (!parsed) continue;
      const { providerId: _rawProviderId, providerName: _rawProviderName, hasKey: _hasKey, officialName: _officialName, ...config } = parsed;
      const hasSecret = Boolean(await this.host.getSecret(parsed.id));
      // A reference changed by VS Code may point to an inaccessible copy of the key.
      // Do not treat it as proof that this group still has a usable credential.
      const hasKey = hasSecret || parsed.hasKey;
      let provider = providers.find(p => p.id === parsed.providerId || p.name === parsed.providerName);
      if (provider && (provider.id !== parsed.providerId || provider.name !== parsed.providerName)) {
        // Broken external metadata must not merge unrelated suppliers.
        provider = undefined;
      }
      if (!provider) {
        provider = { id: parsed.providerId, name: parsed.providerName, groups: [] };
        providers.push(provider);
      }
      provider.groups.push({ ...config, hasKey, officialName: group.name as string });
    }
    return { providers, database };
  }

  getUiState(): Promise<UiState> {
    return this.serialize(async () => {
      const db = await this.database();
      return this.readCurrentState(db);
    });
  }

  private async persistGroups(initialText: string | undefined, plans: GroupWrite[], database: ModelDatabase): Promise<void> {
    const baseText = initialText ?? '[]\n';
    const previousHints = this.host.getRoutingHints();
    const hints = { ...previousHints };
    const writes = plans.map(plan => ({
      ...plan,
      merged: plan.renameOnly ? {
        ...plan.existingGroup,
        name: plan.officialName,
        byokStudioId: plan.group.id,
        byokStudioProviderId: plan.provider.id,
        byokStudioProviderName: plan.provider.name,
        byokStudioGroupName: plan.group.name
      } : buildMergedOfficialGroup(plan.group, plan.provider, plan.officialName, database, plan.existingGroup,
        isSecretReference(plan.existingGroup?.apiKey) ? plan.existingGroup.apiKey : undefined)
    }));
    const localKeys = new Map<string, { before: string | undefined; after: string | undefined }>();
    let diskText = initialText;
    let finalText = baseText;
    const attemptedSecrets: string[] = [];
    let hintsAttempted = false;
    let changed = false;

    try {
      for (const item of writes) {
        const { group, provider, officialName, merged } = item;
        if (item.renameOnly) {
          hints[group.id] = {
            ...(hints[group.id] ?? this.hint(group, provider, officialName)),
            officialName, providerId: provider.id, providerName: provider.name, groupName: group.name
          };
        } else {
          let reference = isSecretReference(item.existingGroup?.apiKey) ? item.existingGroup.apiKey : undefined;
          const localKey = await this.host.getSecret(group.id);
          const oldReference = previousHints[group.id]?.secretReference;
          const keyToProvision = item.apiKey !== undefined
            ? (item.apiKey !== localKey || !reference || oldReference !== reference ? item.apiKey : undefined)
            : (!reference ? localKey : undefined);
          localKeys.set(group.id, {
            before: localKey,
            after: item.apiKey ?? (reference && oldReference && oldReference !== reference ? undefined : localKey)
          });
          if (keyToProvision) {
            const provisioned = await this.host.provisionSecretReference(group.id, keyToProvision, diskText);
            diskText = provisioned.currentText;
            reference = provisioned.reference;
            merged.apiKey = reference;
          }
          hints[group.id] = this.hint(group, provider, officialName, reference);
        }
        // Build from the original snapshot so temporary credential groups never become permanent.
        finalText = upsertOfficialGroup(finalText, group.id, merged, false);
      }
      if (diskText !== finalText) {
        await this.host.writeOfficialText(diskText, finalText);
        diskText = finalText;
        changed = true;
      }
      for (const [id, { before, after }] of localKeys) {
        if (before === after) continue;
        attemptedSecrets.push(id);
        await this.host.setSecret(id, after);
        changed = true;
      }
      if (JSON.stringify(hints) !== JSON.stringify(previousHints)) {
        hintsAttempted = true;
        await this.host.saveRoutingHints(hints);
        changed = true;
      }
    } catch (error) {
      const failures: unknown[] = [error];
      if (hintsAttempted) {
        try { await this.host.saveRoutingHints(previousHints); } catch (rollbackError) { failures.push(rollbackError); }
      }
      for (const id of attemptedSecrets.reverse()) {
        try { await this.host.setSecret(id, localKeys.get(id)!.before); } catch (rollbackError) { failures.push(rollbackError); }
      }
      if (diskText !== initialText) {
        try { await this.host.writeOfficialText(diskText, baseText); } catch (rollbackError) { failures.push(rollbackError); }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, failures.map(failure => failure instanceof Error ? failure.message : t('操作失败，请重试。')).join('\n'));
      }
      throw error;
    }
    this.refreshPending ||= changed;
    if (this.refreshPending) {
      await this.host.refreshChatModels();
      this.refreshPending = false;
    }
  }

  saveGroup(rawProvider: unknown, rawGroup: unknown, rawApiKey?: unknown): Promise<UiState> {
    return this.serialize(async () => {
      const db = await this.database();
      const provider = validateProviderInfo(rawProvider);
      const group = validateGroup(rawGroup, db);
      const newKey = rawApiKey === undefined || rawApiKey === null || rawApiKey === ''
        ? undefined : asText(rawApiKey, 'API Key', 16000);

      const initialText = await this.host.readOfficialText();
      const baseText = initialText ?? '[]\n';
      const nativeGroups = listOfficialGroups(baseText);
      const current = await this.readCurrentState(db, baseText);
      const savedOwner = current.providers.find(p => p.groups.some(g => g.id === group.id));
      const savedGroup = savedOwner?.groups.find(g => g.id === group.id);
      if (savedOwner && savedOwner.id !== provider.id) {
        throw new Error(t('不能将已保存的分组移动到其他供应商。'));
      }
      if (current.providers.some(p => p.name === provider.name && p.id !== provider.id)) {
        throw new Error(t('供应商名称“{0}”已被使用，请修改后重试。', provider.name));
      }
      const savedProvider = current.providers.find(p => p.id === provider.id);
      if (savedProvider?.groups.some(g => g.id !== group.id && g.name === group.name)) {
        throw new Error(t('同一供应商内不能重复分组名称“{0}”。', group.name || t('默认分组')));
      }
      const existingIndex = findOfficialGroupIndex(nativeGroups, group.id);
      const existingGroup = existingIndex >= 0 ? nativeGroups[existingIndex] : undefined;
      const targetName = savedGroup && savedOwner?.name === provider.name && savedGroup.name === group.name
        ? savedGroup.officialName : officialGroupName(provider.name, group.name);
      const changedIndices = new Set<number>([existingIndex]);
      const renames = new Map<string, string>([[group.id, targetName]]);
      if (savedProvider && savedProvider.name !== provider.name) {
        for (const sibling of savedProvider.groups) {
          if (sibling.id === group.id) continue;
          const index = findOfficialGroupIndex(nativeGroups, sibling.id);
          if (index < 0) continue;
          changedIndices.add(index);
          renames.set(sibling.id, officialGroupName(provider.name, sibling.name));
        }
      }
      const newNames = new Set(renames.values());
      if (newNames.size !== renames.size) {
        throw new Error(t('供应商重命名后会产生同名分组，请先调整分组名称。'));
      }
      for (let index = 0; index < nativeGroups.length; index++) {
        const native = nativeGroups[index]!;
        if (!changedIndices.has(index) && native.vendor === 'customendpoint' && newNames.has(String(native.name))) {
          throw new Error(t('官方配置已有同名分组“{0}”，请修改名称后重试。', String(native.name)));
        }
      }

      const planned: GroupWrite[] = [];
      if (savedProvider && savedProvider.name !== provider.name) {
        for (const sibling of savedProvider.groups) {
          if (sibling.id === group.id) continue;
          const index = findOfficialGroupIndex(nativeGroups, sibling.id);
          if (index < 0) continue;
          planned.push({ provider, group: sibling, officialName: renames.get(sibling.id)!, existingGroup: nativeGroups[index], renameOnly: true });
        }
      }
      planned.push({ provider, group, officialName: targetName, existingGroup, apiKey: newKey });
      await this.persistGroups(initialText, planned, db);
      return this.readCurrentState(db);
    });
  }

  deleteProvider(rawId: unknown): Promise<UiState> {
    return this.serialize(async () => {
      const db = await this.database();
      const id = validId(rawId, t('供应商标识'));
      const initialText = await this.host.readOfficialText();
      const baseText = initialText ?? '[]\n';
      const hints = { ...this.host.getRoutingHints() };
      const groupIds = listOfficialGroups(baseText).flatMap(group => {
        if (group.byokStudioStageFor !== undefined) return [];
        const groupId = groupIdentity(group);
        const parsed = readOfficialGroup(group, db, groupId ? hints[groupId] : undefined);
        return parsed?.providerId === id ? [parsed.id] : [];
      });
      if (!groupIds.length) throw new Error(t('供应商不存在，请重新加载后重试。'));

      let nextText = baseText;
      for (const groupId of groupIds) nextText = removeOfficialGroup(nextText, groupId);
      await this.host.writeOfficialText(initialText, nextText);

      for (const groupId of groupIds) {
        await this.host.setSecret(groupId, undefined);
        delete hints[groupId];
      }
      await this.host.saveRoutingHints(hints);
      await this.host.refreshChatModels();
      return this.readCurrentState(db);
    });
  }

  deleteGroup(rawId: unknown): Promise<UiState> {
    return this.serialize(async () => {
      const db = await this.database();
      const id = validId(rawId, t('分组标识'));
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
      const providers: ExportedProvider[] = await Promise.all(matched.map(async provider => {
        const groups = await Promise.all(provider.groups.map(async ({ hasKey: _hasKey, officialName: _officialName, ...group }) => {
          const apiKey = await this.host.getSecret(group.id);
          return apiKey ? { ...group, apiKey } : group;
        }));
        return { id: provider.id, name: provider.name, groups };
      }));
      return { version: 2, exportedAt: new Date().toISOString(), providers };
    });
  }

  importProviders(rawProviders: unknown): Promise<{ state: UiState; importedIds: string[] }> {
    return this.serialize(async () => {
      const db = await this.database();
      const incoming = parseImportData({ version: 2, providers: rawProviders }, db);
      const initialText = await this.host.readOfficialText();
      const baseText = initialText ?? '[]\n';
      const initialGroups = listOfficialGroups(baseText);
      const current = await this.readCurrentState(db, baseText);

      const planned: GroupWrite[] = [];
      const claimedIndices = new Set<number>();
      const claimedIds = new Set<string>();
      const claimedProviders = new Set<string>();

      for (const incomingProvider of incoming) {
        const sameId = current.providers.find(p => p.id === incomingProvider.id);
        const sameName = current.providers.find(p => p.name === incomingProvider.name);
        const matchedProvider = sameId ?? sameName;
        if (sameId && sameName && sameId.id !== sameName.id) {
          throw new Error(t('供应商“{0}”的标识和名称分别匹配不同供应商，请先修改后再导入。', incomingProvider.name));
        }
        const provider = { id: matchedProvider?.id ?? incomingProvider.id, name: incomingProvider.name };
        if (claimedProviders.has(provider.id) || current.providers.some(p => p.id !== provider.id && p.name === provider.name)) {
          throw new Error(t('供应商名称“{0}”与本机现有其他供应商冲突，请先修改后再导入。', provider.name));
        }
        claimedProviders.add(provider.id);
        const existingProvider = current.providers.find(p => p.id === provider.id);

        for (const entry of incomingProvider.groups) {
          const { apiKey, ...group } = entry;
          let matchIndex = findOfficialGroupIndex(initialGroups, group.id);
          if (matchIndex < 0 && existingProvider) {
            const match = existingProvider.groups.find(g => g.name === group.name);
            if (match) matchIndex = findOfficialGroupIndex(initialGroups, match.id);
          }
          const existingGroup = matchIndex >= 0 ? initialGroups[matchIndex] : undefined;
          const targetId = existingGroup ? (groupIdentity(existingGroup) ?? group.id) : group.id;
          const owner = current.providers.find(p => p.groups.some(g => g.id === targetId));
          if (owner && owner.id !== provider.id) {
            throw new Error(t('不能将已保存的分组移动到其他供应商。'));
          }
          if ((matchIndex >= 0 && claimedIndices.has(matchIndex)) || claimedIds.has(targetId)) {
            throw new Error(t('导入的多个分组匹配了同一现有分组，请检查标识和名称。'));
          }
          if (matchIndex >= 0) claimedIndices.add(matchIndex);
          claimedIds.add(targetId);
          if (existingProvider?.groups.some(g => g.id !== targetId && g.name === group.name)) {
            throw new Error(t('同一供应商内不能重复分组名称“{0}”。', group.name || t('默认分组')));
          }
          const savedGroup = existingProvider?.groups.find(g => g.id === targetId);
          planned.push({
            provider,
            group: { ...group, id: targetId },
            apiKey,
            existingGroup,
            officialName: savedGroup && existingProvider?.name === provider.name && savedGroup.name === group.name
              ? savedGroup.officialName : officialGroupName(provider.name, group.name)
          });
        }
        // Renaming an imported supplier also renames groups not present in the file.
        if (existingProvider && existingProvider.name !== provider.name) {
          for (const sibling of existingProvider.groups) {
            if (planned.some(item => item.group.id === sibling.id)) continue;
            const index = findOfficialGroupIndex(initialGroups, sibling.id);
            if (index < 0) continue;
            claimedIndices.add(index);
            claimedIds.add(sibling.id);
            planned.push({ provider, group: sibling, existingGroup: initialGroups[index], renameOnly: true,
              officialName: officialGroupName(provider.name, sibling.name) });
          }
        }
      }

      const officialNames = new Set(planned.map(item => item.officialName));
      if (officialNames.size !== planned.length) throw new Error(t('导入后会产生同名分组，请先调整名称。'));
      for (let index = 0; index < initialGroups.length; index++) {
        const group = initialGroups[index]!;
        if (!claimedIndices.has(index) && group.vendor === 'customendpoint' && officialNames.has(String(group.name))) {
          throw new Error(t('官方配置已有同名分组“{0}”，请修改名称后重试。', String(group.name)));
        }
      }

      await this.persistGroups(initialText, planned, db);
      return { state: await this.readCurrentState(db), importedIds: [...claimedProviders] };
    });
  }

  async discoverModels(
    rawGroup: unknown,
    rawApiKey: unknown,
    signal: AbortSignal
  ): Promise<DiscoveryResult & { database?: ModelDatabase }> {
    const initialDb = await this.database(false, signal);
    const beforeRef = this.rawCatalogRef;
    const group = validateGroup(rawGroup, initialDb, true);
    const key = rawApiKey === undefined || rawApiKey === null || rawApiKey === ''
      ? (await this.host.getSecret(group.id) ?? '')
      : asText(rawApiKey, 'API Key', 16000, true);
    const [discovered, refreshedDb] = await Promise.all([
      discoverGroupModels(group, key, signal),
      this.database(true, signal).catch(() => initialDb)
    ]);
    return this.rawCatalogRef !== beforeRef
      ? { models: discovered.models, database: refreshedDb }
      : { models: discovered.models };
  }
}
