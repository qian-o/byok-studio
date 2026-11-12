import { t } from '../resources/shared/i18n.js';
import { isExcludedModel, normalizeRouting } from '../resources/shared/routing.js';
import { isRecord, resolveEndpoint } from './models';
import type { ApiType, DiscoveredModel, ProviderConfig } from './types';

const MODELS_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

class DiscoveryError extends Error {
  override name = 'DiscoveryError';
}

function fail(message: string): never {
  throw new DiscoveryError(message);
}

function requestHeaders(apiType: ApiType, apiKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(apiType === 'messages'
      ? (apiKey ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { 'anthropic-version': '2023-06-01' })
      : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}))
  };
}

function toSafeError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    const timedOut = isRecord(signal.reason) && signal.reason.name === 'TimeoutError';
    const result = new Error(timedOut ? t('服务商请求超时。') : t('服务商请求已取消。'));
    result.name = timedOut ? 'TimeoutError' : 'AbortError';
    return result;
  }
  return error instanceof DiscoveryError ? error : new DiscoveryError(t('服务商连接或响应无效。'));
}

async function readJsonBody(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(t('服务商返回 HTTP {0}。', response.status));
  }
  if (!response.body) fail(t('服务商返回了空的模型响应。'));

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_JSON_BYTES) fail(t('模型响应超过大小限制。'));
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(t('服务商返回的模型 JSON 格式错误。')); }
  if (!isRecord(parsed)) fail(t('服务商返回了无效的模型响应。'));
  return parsed;
}

async function fetchEndpointModels(
  target: { apiType: ApiType; url: string },
  apiKey: string,
  userSignal: AbortSignal
): Promise<DiscoveredModel[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([userSignal, controller.signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]);
  try {
    signal.throwIfAborted();
    const endpoint = new URL(resolveEndpoint(target.url, target.apiType, 'models'));
    if (target.apiType === 'messages') endpoint.searchParams.set('limit', '100');
    const output = new Map<string, DiscoveredModel>();
    const cursors = new Set<string>();

    for (let page = 0; page < 100; page++) {
      const response = await fetch(endpoint, { headers: requestHeaders(target.apiType, apiKey), signal, redirect: 'error' });
      const data = await readJsonBody(response, signal);
      if (data.error) fail(t('服务商报告了模型错误。'));
      if (!Array.isArray(data.data)) fail(t('服务商返回了无效的模型响应。'));

      for (const raw of data.data) {
        if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
          fail(t('服务商返回了无效的模型响应。'));
        }
        const id = raw.id;
        const name = typeof raw.display_name === 'string' && raw.display_name
          ? raw.display_name
          : typeof raw.name === 'string' && raw.name ? raw.name : id;
        if (!output.has(id)) output.set(id, { id, name });
      }

      if (target.apiType !== 'messages' || data.has_more !== true) {
        signal.throwIfAborted();
        return [...output.values()];
      }
      const cursor = typeof data.last_id === 'string' && data.last_id ? data.last_id : '';
      if (!cursor || !data.data.length || cursors.has(cursor)) fail(t('服务商返回了无效的模型分页。'));
      cursors.add(cursor);
      endpoint.searchParams.set('after_id', cursor);
    }
    return fail(t('模型响应超过分页限制。'));
  } catch (error) {
    throw toSafeError(error, signal);
  } finally {
    controller.abort();
  }
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
}

export async function discoverProviderModels(
  provider: ProviderConfig,
  apiKey: string,
  signal: AbortSignal
): Promise<DiscoveryResult> {
  const routing = normalizeRouting(provider);
  const priority: ApiType[] = routing.routingMode === 'unified'
    ? [routing.unified.apiType]
    : ['chatCompletions', 'responses', 'messages'];

  const targets = new Map<string, Array<{ apiType: ApiType; url: string }>>();
  for (const apiType of priority) {
    const url = routing.routingMode === 'unified' ? routing.unified.url : routing.endpoints[apiType];
    if (!url) continue;
    const endpoint = resolveEndpoint(url, apiType, 'models');
    const candidates = targets.get(endpoint) ?? [];
    if (!candidates.some(c => (c.apiType === 'messages') === (apiType === 'messages'))) {
      candidates.push({ apiType, url });
    }
    targets.set(endpoint, candidates);
  }
  if (!targets.size) throw new Error(t('请至少填写一个协议的基础 URL，再刷新模型。'));

  const result = new Map<string, DiscoveredModel>();
  const controller = new AbortController();
  const linked = AbortSignal.any([signal, controller.signal]);
  try {
    const pages = await Promise.all([...targets.values()].map(async candidates => {
      let lastError: unknown;
      for (const candidate of candidates) {
        linked.throwIfAborted();
        try { return await fetchEndpointModels(candidate, apiKey, linked); }
        catch (error) { lastError = error; }
      }
      throw lastError;
    }));
    for (const models of pages) {
      for (const model of models) {
        if (isExcludedModel(model.id)) continue;
        if (!result.has(model.id)) result.set(model.id, model);
      }
    }
    if (result.size > 5000) throw new Error(t('返回的聊天模型超过 5000 个，请缩小端点模型范围。'));
    return { models: [...result.values()] };
  } finally {
    controller.abort();
  }
}
