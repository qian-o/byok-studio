import type { ApiType, ProviderConnection, DiscoveredModel } from './types';
import { resolveEndpoint } from './endpoints';
import { t } from '../../resources/shared/i18n.js';

type Json = Record<string, unknown>;
const MODELS_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
class TransportError extends Error { override name = 'TransportError'; }
function fail(message: string): never { throw new TransportError(message); }
function record(value: unknown): value is Json { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function object(value: unknown): Json { return record(value) ? value : fail(t('服务商返回了无效的对象。')); }
function string(value: unknown): string { return typeof value === 'string' ? value : fail(t('服务商返回了无效的字符串。')); }
function nonempty(value: unknown): string { const result = string(value); return result ? result : fail(t('缺少必需的标识。')); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : fail(t('服务商返回了无效的列表。')); }

function headers(apiType: ApiType, apiKey: string, stream: boolean): Record<string, string> {
  return {
    Accept: stream ? 'text/event-stream' : 'application/json',
    ...(stream ? { 'Content-Type': 'application/json' } : {}),
    ...(apiType === 'messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${apiKey}` }),
  };
}

function safeError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    const timeout = record(signal.reason) && signal.reason.name === 'TimeoutError';
    const result = new Error(timeout ? t('服务商请求超时。') : t('服务商请求已取消。'));
    result.name = timeout ? 'TimeoutError' : 'AbortError';
    return result;
  }
  // Neither server error bodies nor native fetch errors are safe to expose: they can echo credentials.
  return error instanceof TransportError ? error : new TransportError(t('服务商连接或响应无效。'));
}

async function checkResponse(response: Response): Promise<void> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(t('服务商返回 HTTP {0}。', response.status));
  }
}


async function readJson(response: Response, signal: AbortSignal): Promise<Json> {
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
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch (error) { if (error instanceof TransportError) throw error; return fail(t('服务商返回的模型 JSON 格式错误。')); }
}

export async function discoverModels(provider: Pick<ProviderConnection, 'apiType' | 'url'>, apiKey: string, userSignal: AbortSignal): Promise<DiscoveredModel[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([userSignal, controller.signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]);
  try {
    signal.throwIfAborted();
    const endpoint = new URL(resolveEndpoint(provider.url, provider.apiType, 'models'));
    if (provider.apiType === 'messages') endpoint.searchParams.set('limit', '100');
    const output = new Map<string, DiscoveredModel>(), cursors = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const response = await fetch(endpoint, { headers: headers(provider.apiType, apiKey, false), signal, redirect: 'error' });
      await checkResponse(response);
      const data = await readJson(response, signal);
      if (data.error) fail(t('服务商报告了模型错误。'));
      const models = array(data.data);
      for (const raw of models) {
        const model = object(raw), id = nonempty(model.id);
        const name = typeof model.display_name === 'string' && model.display_name ? model.display_name : typeof model.name === 'string' && model.name ? model.name : id;
        if (!output.has(id)) output.set(id, { id, name });
      }
      if (provider.apiType !== 'messages' || data.has_more !== true) { signal.throwIfAborted(); return [...output.values()]; }
      const cursor = nonempty(data.last_id);
      if (!models.length || cursors.has(cursor)) fail(t('服务商返回了无效的模型分页。'));
      cursors.add(cursor);
      // Only a cursor is accepted. Provider-supplied next URLs never choose a destination.
      endpoint.searchParams.set('after_id', cursor);
    }
    return fail(t('模型响应超过分页限制。'));
  } catch (error) { throw safeError(error, signal); }
  finally { controller.abort(); }
}
