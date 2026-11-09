import type { CatalogSnapshot, ContextPricing, ModelApiProfile, ModelParameters, ReasoningControls } from './types';
import { validateParameters, validateReasoningControls, validId } from './configuration';
import { validateCatalogSnapshot } from './store';
import { excludedKind } from '../../resources/shared/routing.js';
import { validDate } from '../../resources/shared/model-policy.js';
import { t } from '../../resources/shared/i18n.js';

const SOURCE_URL = 'https://models.dev/catalog.json';
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
type Json = Record<string, unknown>;
type ProviderPolicy = { families: string[]; canonicalProviders: string[]; contextWindowMode?: 'input' | 'shared'; nativeMessages?: boolean };
type Patch = { source: string; contextWindowMode?: 'input' | 'shared'; reasoningControls?: ReasoningControls };
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
function mode(value: unknown): value is 'input' | 'shared' | undefined { return value === undefined || value === 'input' || value === 'shared'; }

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
      keys(entry, ['families', 'canonicalProviders', 'contextWindowMode', 'nativeMessages']);
      if (!strings(entry.families) || !strings(entry.canonicalProviders) || !mode(entry.contextWindowMode)
        || (entry.nativeMessages !== undefined && typeof entry.nativeMessages !== 'boolean')) fail();
      providerDefaults[id] = entry as ProviderPolicy;
    }
    const citation = (value: unknown): string => {
      if (typeof value !== 'string' || !value.startsWith('https://') || value.length > 1500) fail();
      return value;
    };
    const profiles: Record<string, Patch> = Object.create(null);
    for (const [id, value] of Object.entries(declaredProfiles)) {
      if (validId(id) !== id) fail();
      const profile = object(value);
      keys(profile, ['source', 'reasoningControls']);
      profiles[id] = { source: citation(profile.source), reasoningControls: validateReasoningControls(profile.reasoningControls) };
    }
    const models: Record<string, Patch> = Object.create(null);
    for (const [id, value] of Object.entries(patches)) {
      if (validId(id) !== id) fail();
      const patch = object(value);
      keys(patch, ['source', 'contextWindowMode', 'profile']);
      if (!mode(patch.contextWindowMode)) fail();
      if (patch.profile !== undefined && (typeof patch.profile !== 'string' || !Object.hasOwn(profiles, patch.profile))) fail();
      const profile = typeof patch.profile === 'string' ? profiles[patch.profile] : undefined;
      const source = patch.source === undefined ? profile?.source : citation(patch.source);
      if (!source || (!profile && patch.contextWindowMode === undefined)) fail();
      models[id] = { ...profile, source, ...(patch.contextWindowMode ? { contextWindowMode: patch.contextWindowMode } : {}) };
    }
    return { providers: raw.providers, providerDefaults, models };
  } catch { return fail(t('模型目录兼容配置无效。')); }
}
// Loading the same module in the offline checker also validates the shipped policy.
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
      if (entry.type === 'effort' && (!strings(entry.values) || entry.values.length > 32 || entry.values.some(value => !/^[a-zA-Z0-9_-]{1,40}$/.test(value)))) fail();
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
function documentation(provider: Json): string {
  if (typeof provider.doc !== 'string' || provider.doc.length > 1500) return '';
  try { const url = new URL(provider.doc); return url.protocol === 'https:' && !url.username && !url.password ? `; provider documentation: ${url.href}` : ''; }
  catch { return ''; }
}
function provenance(provider: string, providers: Json, updatedAt: string): string {
  return `${SOURCE_URL}; models.dev community snapshot ${updatedAt}; provider: ${provider}; not independently verified${documentation(object(providers[provider]))}`;
}
function pricing(raw: unknown, source: string): ContextPricing {
  const unknown: ContextPricing = { kind: 'unknown', scope: 'direct-api', thresholds: [], source, checkedAt: null,
    note: 'Community snapshot; missing, ambiguous, or unsupported prices are not treated as verified flat rates.' };
  if (!record(raw)) return unknown;
  const price = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const rates = (value: Json) => {
    if (!price(value.input) || !price(value.output) || ['cache_read', 'cache_write'].some(key => value[key] !== undefined && !price(value[key]))
      || (value.reasoning !== undefined && value.reasoning !== value.output)) return undefined;
    return { input: value.input, output: value.output,
      ...(price(value.cache_read) ? { cacheRead: value.cache_read } : {}), ...(price(value.cache_write) ? { cacheWrite: value.cache_write } : {}) };
  };
  const base = rates(raw);
  if (!base) return unknown;
  const tiers = raw.tiers === undefined ? [] : raw.tiers;
  if (!Array.isArray(tiers) || tiers.length > 8 || (raw.context_over_200k !== undefined && tiers.length === 0)) return unknown;
  const thresholds: number[] = [], bands: NonNullable<ContextPricing['rates']>['bands'] = [];
  let previous = 0, current = base;
  for (const rawTier of tiers) {
    if (!record(rawTier) || !record(rawTier.tier) || rawTier.tier.type !== 'context' || !positive(rawTier.tier.size) || rawTier.tier.size <= previous) return unknown;
    // Partial tier prices inherit the base, never an unrelated provider's rates.
    const next = rates({ ...raw, ...rawTier });
    if (!next) return unknown;
    thresholds.push(rawTier.tier.size);
    bands.push({ inputUpTo: rawTier.tier.size, ...current });
    current = next; previous = rawTier.tier.size;
  }
  bands.push({ inputUpTo: null, ...current });
  return { kind: thresholds.length ? 'tiered' : 'flat', scope: 'direct-api', thresholds, source, checkedAt: null,
    note: `USD per 1M text tokens from the models.dev community snapshot; provider/channel pricing is not independently verified. ${thresholds.length ? 'Context tiers use the exact reported token boundaries.' : 'Only a base rate is reported; absence of tiers is not independent confirmation of flat pricing.'} Auxiliary modality prices are not represented.`,
    rates: { currency: 'USD', perTokens: 1000000, bands } };
}
function reasoning(model: Json, defaults: ProviderPolicy, patch?: Patch): { supportsReasoningEffort: string[]; reasoningControls?: ReasoningControls } {
  const options = (model.reasoning_options ?? []) as Json[];
  const supportsReasoningEffort = [...new Set(options.filter(option => option.type === 'effort').flatMap(option => option.values as string[]))];
  let controls: ReasoningControls | undefined;
  const budgets = options.filter(option => option.type === 'budget_tokens');
  const budget = budgets.length === 1 ? budgets[0] : undefined;
  if (model.reasoning === true && defaults.nativeMessages && budget && positive(budget.min) && positive(budget.max) && budget.min <= budget.max) {
    const messages: ModelApiProfile = { effortPath: supportsReasoningEffort.length ? ['output_config', 'effort'] : null,
      modePath: ['thinking', 'type'], enabledValue: 'enabled', defaultMode: 'enabled',
      budgetPath: ['thinking', 'budget_tokens'], budget: { min: budget.min, max: budget.max, default: budget.min } };
    controls = { protocols: { messages }, note: 'Native Messages budget bounds explicitly supplied by the community source.' };
  }
  if (patch?.reasoningControls) {
    controls = { ...patch.reasoningControls, protocols: { ...controls?.protocols, ...patch.reasoningControls.protocols } };
  }
  return { supportsReasoningEffort, ...(controls ? { reasoningControls: controls } : {}) };
}
function normalize(candidate: Candidate, providers: Json, canonical: Json, updatedAt: string): ModelParameters {
  const { id, model, provider } = candidate, defaults = policy.providerDefaults[provider]!;
  const patch = policy.models[id], limit = object(model.limit);
  if (!positive(limit.context)) fail();
  for (const field of ['input', 'output']) if (limit[field] !== undefined && limit[field] !== null && !positive(limit[field])) fail();
  const contextWindow = limit.context, contextWindowMode = patch?.contextWindowMode ?? defaults.contextWindowMode ?? 'shared';
  const reportedOutput = positive(limit.output) ? limit.output : undefined;
  const maxOutputTokens = contextWindowMode === 'input' ? reportedOutput ?? 16000 : Math.min(reportedOutput ?? 16000, contextWindow);
  const canonicalModel = candidate.canonicalId ? object(canonical[candidate.canonicalId]) : undefined;
  const canonicalOutput = canonicalModel ? object(canonicalModel.limit).output : undefined;
  const reservation = Math.min(maxOutputTokens, 131072, Math.max(1, Math.floor(contextWindow / 4)));
  const defaultOutputTokens = positive(canonicalOutput) && canonicalOutput < maxOutputTokens ? Math.min(canonicalOutput, reservation) : reservation;
  let source = provenance(provider, providers, updatedAt);
  if (candidate.canonicalId) source += `; canonical model: ${candidate.canonicalId}`;
  if (reportedOutput === undefined) source += '; output ceiling missing: conservative editable fallback, not an official limit';
  if (reportedOutput !== undefined && maxOutputTokens < reportedOutput) source += '; reported output clamped to the shared context policy';
  if (positive(canonicalOutput) && canonicalOutput < maxOutputTokens) source += `; default output budget bounded by canonical output ${canonicalOutput}`;
  if (positive(limit.input) && limit.input > contextWindow) source += '; reported input clamped to the context policy';
  if (patch) source += `; protocol/context compatibility: ${patch.source}`;
  const modalities = object(model.modalities);
  const releaseDate = validDate(model.release_date) && (model.release_date as string) <= updatedAt.slice(0, 10) ? model.release_date as string : undefined;
  return { name: model.name as string, contextWindow, contextWindowMode, maxOutputTokens, defaultOutputTokens,
    ...(positive(limit.input) ? { maxInputTokens: Math.min(limit.input, contextWindow) } : {}),
    toolCalling: model.tool_call === true, vision: (modalities.input as string[]).some(input => input === 'image' || input.startsWith('image/')),
    thinking: model.reasoning === true, ...reasoning(model, defaults, patch), source, verifiedAt: null,
    ...(releaseDate ? { releaseDate } : {}), contextPricing: pricing(model.cost, provenance(provider, providers, updatedAt)) };
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
      // Exact IDs retain declared provider priority; canonical-origin records supply matching facts and prices.
      const normalized = normalize(source, providers, canonical, updatedAt);
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
      models[id] = { ...structuredClone(models[sourceId]!), aliasOf: sourceId,
        source: `${models[sourceId]!.source}; exact alias declared by canonical_model_id` };
    }
    if (!Object.keys(models).length) fail();
    const source = `${SOURCE_URL}; models.dev community snapshot ${updatedAt}; unknown model: editable conservative fallback, not official specifications`;
    const defaults = validateParameters({ name: '', contextWindow: 128000, maxOutputTokens: 16000, toolCalling: false, vision: false, thinking: false,
      supportsReasoningEffort: [], source, verifiedAt: null, contextPricing: pricing(undefined, source) });
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
