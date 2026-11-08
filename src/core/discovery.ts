import { t } from '../../resources/shared/i18n.js';
import { excludedKind, normalizeRouting } from '../../resources/shared/routing.js';
import { discoverModels } from './discoveryTransport';
import { resolveEndpoint } from './endpoints';
import type { ApiType, DiscoveredModel, ProviderConfig } from './types';

export interface DiscoveryResult { models: DiscoveredModel[]; excludedCount: number; sourceCount: number }
export async function discoverProviderModels(provider: ProviderConfig, apiKey: string, signal: AbortSignal): Promise<DiscoveryResult> {
  const targets = new Map<string, Array<{ apiType: ApiType; url: string }>>();
  const routing = normalizeRouting(provider);
  // OpenAI-compatible discovery works for both Responses and Chat Completions.
  const priority: ApiType[] = routing.routingMode === 'unified' ? [routing.unified.apiType] : ['chatCompletions', 'responses', 'messages'];
  for (const apiType of priority) {
    const url = routing.routingMode === 'unified' ? routing.unified.url : routing.endpoints[apiType];
    if (!url) continue;
    const endpoint = resolveEndpoint(url, apiType, 'models');
    const candidates = targets.get(endpoint) ?? [];
    if (!candidates.some(candidate => (candidate.apiType === 'messages') === (apiType === 'messages'))) candidates.push({ apiType, url });
    targets.set(endpoint, candidates);
  }
  if (!targets.size) throw new Error(t('请至少填写一个协议的 API 地址。'));
  const result = new Map<string, DiscoveredModel>();
  const excludedIds = new Set<string>();
  const controller = new AbortController();
  const linked = AbortSignal.any([signal, controller.signal]);
  try {
    const pages = await Promise.all([...targets.values()].map(async candidates => {
      let lastError: unknown;
      for (const candidate of candidates) {
        linked.throwIfAborted();
        try { return await discoverModels(candidate, apiKey, linked); }
        catch (error) { lastError = error; }
      }
      throw lastError;
    }));
    for (const models of pages) for (const model of models) {
      if (excludedKind(model.id)) { excludedIds.add(model.id); continue; }
      if (!result.has(model.id)) result.set(model.id, model);
    }
    if (result.size > 5000) throw new Error(t('返回的聊天模型超过 5000 个，请缩小端点模型范围。'));
    return { models: [...result.values()], excludedCount: excludedIds.size, sourceCount: targets.size };
  } finally { controller.abort(); }
}
