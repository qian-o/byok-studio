import type { ApiType, CatalogSnapshot, ModelDatabase, ModelParameters, ProtocolProfile } from './types';
import { validateCatalogSnapshot, validateParameters, validateProtocols, validId } from './configuration';
import { excludedKind } from '../../resources/shared/routing.js';
import { validDate } from '../../resources/shared/model-policy.js';
import { t } from '../../resources/shared/i18n.js';

const SOURCE_URL = 'https://models.dev/catalog.json';
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
type Json = Record<string, unknown>;
type ProviderPolicy = { families: string[]; canonicalProviders: string[]; nativeMessages?: boolean };
type Patch = { protocols?: Partial<Record<ApiType, ProtocolProfile>> };
type Policy = { providers: string[]; providerDefaults: Record<string, ProviderPolicy>; models: Record<string, Patch> };
type Candidate = { id: string; provider: string; model: Json; canonicalId?: string };

class CatalogError extends Error { override name = 'CatalogError'; }
function fail(message = t('模型目录数据格式无效，未更新本地目录。')): never { throw new CatalogError(message); }
function record(value: unknown): value is Json { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function object(value: unknown): Json { return record(value) ? value : fail(); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 100_000_000; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200); }
function own(value: Json, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail(); }

function readPolicy(value: unknown): Policy {
  try {
    const raw = object(value);
    keys(raw, ['schemaVersion', 'providers', 'providerDefaults', 'profiles', 'models']);
    if (raw.schemaVersion !== 1 || !strings(raw.providers) || new Set(raw.providers).size !== raw.providers.length) fail();
    const defaults = object(raw.providerDefaults), patches = object(raw.models), declaredProfiles = object(raw.profiles);
    if (Object.keys(defaults).length !== raw.providers.length) fail();
    const providerDefaults: Record<string, ProviderPolicy> = Object.create(null);
    for (const id of raw.providers) {
      if (validId(id) !== id) fail();
      const entry = object(own(defaults, id));
      keys(entry, ['families', 'canonicalProviders', 'nativeMessages']);
      if (!strings(entry.families) || !strings(entry.canonicalProviders)
        || (entry.nativeMessages !== undefined && typeof entry.nativeMessages !== 'boolean')) fail();
      providerDefaults[id] = entry as ProviderPolicy;
    }
    const profiles: Record<string, Patch> = Object.create(null);
    for (const [id, item] of Object.entries(declaredProfiles)) {
      if (validId(id) !== id) fail();
      const profile = object(item);
      keys(profile, ['protocols']);
      profiles[id] = { protocols: validateProtocols(profile.protocols) };
    }
    const models: Record<string, Patch> = Object.create(null);
    for (const [id, item] of Object.entries(patches)) {
      if (validId(id) !== id) fail();
      const patch = object(item);
      keys(patch, ['profile']);
      if (typeof patch.profile !== 'string' || !Object.hasOwn(profiles, patch.profile)) fail();
      models[id] = { ...profiles[patch.profile] };
    }
    return { providers: raw.providers, providerDefaults, models };
  } catch { return fail(t('模型目录兼容配置无效。')); }
}
const policy = readPolicy(require('../../resources/catalog/compatibility.json'));

function readModel(id: string, value: unknown): Json {
  const model = object(value);
  if (validId(id) !== id || model.id !== id || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 200) fail();
  if (model.family !== undefined && typeof model.family !== 'string') fail();
  if (model.type !== undefined && typeof model.type !== 'string') fail();
  for (const field of ['reasoning', 'tool_call']) if (model[field] !== undefined && typeof model[field] !== 'boolean') fail();
  const modalities = object(model.modalities);
  if (!strings(modalities.input) || !strings(modalities.output)) fail();
  object(model.limit);
  if (model.canonical_model_id !== undefined && (typeof model.canonical_model_id !== 'string' || validId(model.canonical_model_id) !== model.canonical_model_id)) fail();
  if (model.reasoning_options !== undefined) {
    if (!Array.isArray(model.reasoning_options) || model.reasoning_options.length > 32) fail();
    for (const option of model.reasoning_options) {
      const entry = object(option);
      if (typeof entry.type !== 'string') fail();
      if (entry.type === 'effort' && (!strings(entry.values) || entry.values.length > 32 || entry.values.some(item => !/^[a-zA-Z0-9_-]{1,40}$/.test(item)))) fail();
      for (const field of ['min', 'max']) if (entry[field] !== undefined && (!Number.isSafeInteger(entry[field]) || (entry[field] as number) < 0 || (entry[field] as number) > 100_000_000)) fail();
      if (typeof entry.min === 'number' && typeof entry.max === 'number' && entry.min > entry.max) fail();
    }
  }
  return model;
}

function chatModel(id: string, model: Json): boolean {
  const modalities = object(model.modalities);
  return (model.type === undefined || model.type === 'chat' || model.type === 'text')
    && (modalities.input as string[]).includes('text') && (modalities.output as string[]).length === 1
    && (modalities.output as string[])[0] === 'text' && !excludedKind(id);
}

function canonicalId(provider: string, id: string, model: Json, canonical: Json): string | undefined {
  if (typeof model.canonical_model_id === 'string') return model.canonical_model_id;
  const exact = `${provider}/${id}`;
  return Object.hasOwn(canonical, exact) ? exact : undefined;
}

function origin(id: string): string { return id.split('/')[0]!; }

function reasoning(model: Json, defaults: ProviderPolicy, patch?: Patch): { supportsReasoningEffort: string[]; protocols?: Partial<Record<ApiType, ProtocolProfile>> } {
  const options = (model.reasoning_options ?? []) as Json[];
  const supportsReasoningEffort = [...new Set(options.filter(option => option.type === 'effort').flatMap(option => option.values as string[]))];
  let protocols: Partial<Record<ApiType, ProtocolProfile>> | undefined;
  const budgets = options.filter(option => option.type === 'budget_tokens');
  const budget = budgets.length === 1 ? budgets[0] : undefined;
  if (model.reasoning === true && defaults.nativeMessages && budget && positive(budget.min) && positive(budget.max) && budget.min <= budget.max) {
    protocols = {
      messages: {
        ...(supportsReasoningEffort.length ? { effortFormat: 'messages' } : { effortFormat: 'unsupported' }),
        thinkingBudget: { min: budget.min, max: budget.max }
      }
    };
  }
  if (patch?.protocols) {
    protocols = { ...protocols, ...patch.protocols };
  }
  return { supportsReasoningEffort, ...(protocols && Object.keys(protocols).length ? { protocols } : {}) };
}

function normalize(candidate: Candidate, canonical: Json, updatedAt: string): ModelParameters {
  const { id, model, provider } = candidate, defaults = policy.providerDefaults[provider]!;
  const patch = policy.models[id], limit = object(model.limit);
  if (!positive(limit.context)) fail();
  if (limit.output !== undefined && limit.output !== null && !positive(limit.output)) fail();
  const contextWindow = limit.context;
  const canonicalModel = candidate.canonicalId ? object(canonical[candidate.canonicalId]) : undefined;
  const canonicalOutput = canonicalModel ? object(canonicalModel.limit).output : undefined;
  const maxOutputTokens = Math.min(positive(limit.output) ? limit.output : 16000,
    positive(canonicalOutput) ? canonicalOutput : Infinity, 131072, Math.max(1, Math.floor(contextWindow / 4)));
  const modalities = object(model.modalities);
  const releaseDate = validDate(model.release_date) && (model.release_date as string) <= updatedAt.slice(0, 10) ? model.release_date as string : undefined;
  return {
    name: model.name as string,
    contextWindow,
    maxOutputTokens,
    toolCalling: model.tool_call === true,
    vision: (modalities.input as string[]).some(input => input === 'image' || input.startsWith('image/')),
    thinking: model.reasoning === true,
    ...reasoning(model, defaults, patch),
    ...(releaseDate ? { releaseDate } : {})
  };
}

export function buildModelCatalog(raw: unknown, updatedAt: string): CatalogSnapshot {
  try {
    const root = object(raw), providers = object(root.providers), canonical = object(root.models);
    if (!Object.keys(canonical).length) fail();
    for (const [id, model] of Object.entries(canonical)) readModel(id, model);
    const candidates: Candidate[] = [];
    for (const provider of policy.providers) {
      const entry = object(own(providers, provider)), models = object(entry.models), defaults = policy.providerDefaults[provider]!;
      if (entry.id !== provider || typeof entry.name !== 'string' || !entry.name.trim() || !Object.keys(models).length) fail();
      for (const [id, value] of Object.entries(models).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const model = readModel(id, value), link = canonicalId(provider, id, model, canonical);
        if (link && !Object.hasOwn(canonical, link)) fail();
        if (!chatModel(id, model) || (link && !chatModel(link, object(canonical[link])))) continue;
        if (link ? !defaults.canonicalProviders.includes(origin(link)) : !defaults.families.includes(String(model.family))) continue;
        candidates.push({ id, provider, model, canonicalId: link });
      }
    }
    const sources = new Map<string, Candidate>();
    for (const candidate of candidates) {
      if (!candidate.canonicalId) continue;
      const old = sources.get(candidate.canonicalId);
      const preferred = (item: Candidate) => item.provider === origin(item.canonicalId!) ? (item.canonicalId === `${item.provider}/${item.id}` ? 2 : 1) : 0;
      if (!old || preferred(candidate) > preferred(old)) sources.set(candidate.canonicalId, candidate);
    }
    const models: Record<string, ModelParameters> = Object.create(null), known = new Map<string, string>();
    for (const candidate of candidates) {
      if (Object.hasOwn(models, candidate.id)) continue;
      const source = candidate.canonicalId ? sources.get(candidate.canonicalId)! : candidate;
      const normalized = normalize(source, canonical, updatedAt);
      models[candidate.id] = { ...normalized, name: candidate.model.name as string };
      if (candidate.canonicalId && !known.has(candidate.canonicalId)) known.set(candidate.canonicalId, candidate.id);
    }
    const aliases = new Map<string, Set<string | undefined>>();
    for (const rawProvider of Object.values(providers)) {
      const entries = object(object(rawProvider).models);
      for (const [id, value] of Object.entries(entries)) {
        if (Object.hasOwn(models, id)) continue;
        const claims = aliases.get(id) ?? new Set<string | undefined>();
        aliases.set(id, claims);
        if (!record(value) || typeof value.canonical_model_id !== 'string') { claims.add(undefined); continue; }
        let link: string | undefined;
        try {
          const model = readModel(id, value);
          if (chatModel(id, model) && known.has(value.canonical_model_id)) link = value.canonical_model_id;
        } catch { /* An invalid relay record cannot establish an alias. */ }
        claims.add(link);
      }
    }
    for (const [id, claims] of [...aliases].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const [link] = claims;
      if (claims.size !== 1 || link === undefined || !known.has(link)) continue;
      const sourceId = known.get(link)!;
      models[id] = { ...structuredClone(models[sourceId]!), aliasOf: sourceId };
    }
    if (!Object.keys(models).length) fail();
    const defaults: ModelDatabase['defaults'] = validateParameters({
      name: '', contextWindow: 128000, maxOutputTokens: 16000, toolCalling: false, vision: false, thinking: false, supportsReasoningEffort: []
    });
    return validateCatalogSnapshot({ source: 'models.dev', updatedAt, database: { schemaVersion: 1, defaults, models } });
  } catch (error) { if (error instanceof CatalogError) throw error; return fail(); }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) { void operation.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); fail(t('模型目录请求失败，请稍后重试。')); }
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {}); fail(t('模型目录响应超过 16 MiB 大小限制。'));
  }
  if (!response.body) fail();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) fail(t('模型目录响应超过 16 MiB 大小限制。'));
      chunks.push(chunk.value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail(); }
}
export async function fetchModelCatalog(userSignal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<CatalogSnapshot> {
  const controller = new AbortController(), signal = userSignal ? AbortSignal.any([userSignal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(new DOMException('Catalog timeout', 'TimeoutError')), TIMEOUT_MS);
  try {
    signal.throwIfAborted();
    const request = fetcher(SOURCE_URL, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit',
      redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal });
    const response = await abortable(request.then(response => {
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
      return response;
    }), signal);
    const raw = await readResponse(response, signal);
    signal.throwIfAborted();
    const result = buildModelCatalog(raw, new Date().toISOString());
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) {
      const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
      const safe = new CatalogError(timedOut ? t('模型目录请求超时，请稍后重试。') : t('模型目录请求已取消。'));
      safe.name = timedOut ? 'TimeoutError' : 'AbortError';
      throw safe;
    }
    if (error instanceof CatalogError) throw error;
    return fail(t('模型目录请求失败，请稍后重试。'));
  } finally { clearTimeout(timeout); controller.abort(); }
}
