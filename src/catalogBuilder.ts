import { t } from '../resources/shared/i18n.js';
import { isExcludedModel, validDate } from '../resources/shared/routing.js';
import { isRecord, validateCatalogSnapshot, validateParameters } from './models';
import type { ApiType, CatalogSnapshot, ModelDatabase, ModelParameters, ProtocolProfile } from './types';

export const CATALOG_URL = 'https://models.dev/catalog.json';
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const CATALOG_REFRESH_TTL_MS = 15 * 60 * 1000;

const MAX_BYTES = 32 * 1024 * 1024;
const ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

type Json = Record<string, unknown>;
type LinkedEntry = { providerId: string; modelId: string; model: Json };

const ORIGIN_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  openai: ['openai', 'github-copilot', 'azure'],
  anthropic: ['anthropic', 'github-copilot', 'google-vertex-anthropic', 'amazon-bedrock'],
  google: ['google', 'google-vertex', 'github-copilot'],
  xai: ['xai', 'github-copilot'],
  deepseek: ['deepseek', 'fireworks-ai', 'togetherai', 'openrouter'],
  moonshotai: ['moonshotai', 'moonshotai-cn', 'github-copilot', 'openrouter'],
  zhipuai: ['zai', 'zhipuai', 'github-copilot', 'openrouter'],
  'bytedance-seed': ['volcengine', 'byteplus', 'openrouter'],
  alibaba: ['alibaba', 'alibaba-cn', 'openrouter'],
  meta: ['meta', 'togetherai', 'fireworks-ai', 'deepinfra', 'openrouter'],
  mistral: ['mistral', 'openrouter'],
  minimax: ['minimax', 'minimax-cn', 'openrouter']
};

const MAJOR_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'xai', 'deepseek', 'moonshotai', 'moonshotai-cn',
  'zai', 'zhipuai', 'volcengine', 'byteplus', 'alibaba', 'alibaba-cn', 'meta',
  'mistral', 'minimax', 'minimax-cn', 'cohere', 'github-copilot', 'openrouter',
  'fireworks-ai', 'togetherai', 'deepinfra', 'amazon-bedrock', 'azure', 'google-vertex',
  'google-vertex-anthropic'
]);

class CatalogError extends Error {
  override name = 'CatalogError';
}

function fail(message = t('模型目录数据格式无效。')): never {
  throw new CatalogError(message);
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 100_000_000;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/\s|[\x00-\x1f\x7f]/.test(value)
    && value !== '__proto__'
    && value !== 'constructor'
    && value !== 'prototype';
}

function modelLeaf(id: string): string {
  return id.split('/').at(-1) ?? id;
}

function defaultParameters(): ModelDatabase['defaults'] {
  return validateParameters({
    name: '',
    contextWindow: 128000,
    maxOutputTokens: 16000,
    toolCalling: false,
    vision: false,
    thinking: false,
    supportsReasoningEffort: []
  });
}

export function emptyCatalogSnapshot(updatedAt = new Date().toISOString()): CatalogSnapshot {
  return validateCatalogSnapshot({
    source: 'models.dev',
    updatedAt,
    database: {
      schemaVersion: 1,
      defaults: defaultParameters(),
      models: {}
    }
  });
}

function isChatRecord(id: string, model: unknown): model is Json {
  if (!safeId(id) || !isRecord(model)) return false;
  if (typeof model.name !== 'string' || !model.name.trim()) return false;
  if (model.type !== undefined && model.type !== 'chat' && model.type !== 'text') return false;
  if (!isRecord(model.modalities)) return false;
  const { input, output } = model.modalities;
  if (!Array.isArray(input) || !input.includes('text')) return false;
  if (!Array.isArray(output) || output.length !== 1 || output[0] !== 'text') return false;
  if (!isRecord(model.limit) || !positive(model.limit.context) || model.limit.context < 2) return false;
  return !isExcludedModel(id);
}

function rankProvider(providerId: string, modelId: string, origin: string, leaf: string): number {
  const preferred = ORIGIN_PROVIDERS[origin] ?? [origin];
  const index = preferred.indexOf(providerId);
  const exact = modelId === leaf || modelId === `${origin}/${leaf}` ? 1 : 0;
  if (index === 0) return 100 + exact * 10;
  if (index > 0) return 80 - index + exact * 5;
  if (providerId === origin) return 100 + exact * 10;
  if (MAJOR_PROVIDERS.has(providerId)) return 40 + exact * 5;
  return 10 + exact;
}

function isLegacyClaudeBudgetModel(id: string, family: string): boolean {
  const text = `${id} ${family}`.toLowerCase();
  if (!text.includes('claude')) return false;
  const match = text.match(/claude-(?:(?:opus|sonnet|haiku)-)?(\d+)(?:[.-](\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  return major < 4 || (major === 4 && minor <= 5);
}

function extractEffortsAndProtocols(
  id: string,
  thinking: boolean,
  origin: string,
  family: string,
  optionSource: Json | undefined
): {
  supportsReasoningEffort: string[];
  protocols?: Partial<Record<ApiType, ProtocolProfile>>;
} {
  const rawOptions = Array.isArray(optionSource?.reasoning_options) ? optionSource.reasoning_options : [];
  const supportsReasoningEffort = thinking
    ? [...new Set(
        rawOptions
          .filter((opt): opt is Json => isRecord(opt) && opt.type === 'effort' && Array.isArray(opt.values))
          .flatMap(opt => (opt.values as unknown[]).filter(
            (v): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(v)
          ))
      )].slice(0, 32)
    : [];

  const protocols: Partial<Record<ApiType, ProtocolProfile>> = {};

  if (thinking && (origin === 'anthropic' || family.startsWith('claude') || /^claude(?:[-.]|$)/i.test(modelLeaf(id)))) {
    const budget = rawOptions.find((opt): opt is Json => isRecord(opt) && opt.type === 'budget_tokens');
    if (isLegacyClaudeBudgetModel(id, family)) {
      const min = budget && positive(budget.min) ? budget.min : 1024;
      const max = budget && positive(budget.max) && budget.max >= min ? budget.max : 63999;
      protocols.messages = {
        effortFormat: supportsReasoningEffort.length ? 'messages' : 'unsupported',
        thinkingBudget: { min, max }
      };
    } else {
      protocols.messages = {
        ...(supportsReasoningEffort.length ? {} : { effortFormat: 'unsupported' }),
        adaptiveThinking: true
      };
    }
  }

  if (family === 'kimi-k3') {
    protocols.chatCompletions = { modelOptions: { top_p: 0.95 } };
  }

  return {
    supportsReasoningEffort,
    ...(Object.keys(protocols).length ? { protocols } : {})
  };
}

function buildModelParameters(
  id: string,
  primary: Json,
  optionSource: Json | undefined,
  canonical: Json | undefined,
  updatedAt: string
): ModelParameters | undefined {
  const primaryLimit = isRecord(primary.limit) ? primary.limit : {};
  const canonicalLimit = isRecord(canonical?.limit) ? canonical.limit : {};
  const contextWindow = positive(canonicalLimit.context) && canonicalLimit.context >= 2
    ? canonicalLimit.context
    : positive(primaryLimit.context) && primaryLimit.context >= 2
      ? primaryLimit.context
      : undefined;
  if (!contextWindow) return undefined;

  const outputCandidates = [primaryLimit.output, canonicalLimit.output].filter(positive);
  const upstreamOutput = outputCandidates.length ? Math.min(...outputCandidates) : 16000;
  const maxOutputTokens = Math.min(
    upstreamOutput,
    131072,
    Math.max(1, Math.floor(contextWindow / 4))
  );
  if (maxOutputTokens >= contextWindow) return undefined;

  const modalities = isRecord(canonical?.modalities)
    ? canonical.modalities
    : isRecord(primary.modalities) ? primary.modalities : {};
  const inputs = Array.isArray(modalities.input) ? modalities.input : ['text'];
  const vision = inputs.some(item => item === 'image' || (typeof item === 'string' && item.startsWith('image/')));
  const toolCalling = (canonical?.tool_call ?? primary.tool_call) === true;
  const thinking = (canonical?.reasoning ?? primary.reasoning) === true;
  const family = typeof canonical?.family === 'string'
    ? canonical.family
    : typeof primary.family === 'string' ? primary.family : '';
  const canonicalId = typeof canonical?.id === 'string' ? canonical.id : '';
  const origin = canonicalId.includes('/') ? canonicalId.split('/')[0]! : '';

  const rawRelease = canonical?.release_date ?? primary.release_date;
  const releaseDate = validDate(rawRelease) && rawRelease <= updatedAt.slice(0, 10)
    ? rawRelease
    : undefined;

  const name = String(primary.name || canonical?.name || id).trim().slice(0, 200);
  try {
    return validateParameters({
      name,
      contextWindow,
      maxOutputTokens,
      toolCalling,
      vision,
      thinking,
      ...extractEffortsAndProtocols(canonicalId || id, thinking, origin, family, optionSource),
      ...(releaseDate ? { releaseDate } : {})
    });
  } catch {
    return undefined;
  }
}

export function buildModelCatalog(raw: unknown, updatedAt: string): CatalogSnapshot {
  if (!isRecord(raw)) fail();
  const rawModels = isRecord(raw.models) ? raw.models : undefined;
  const rawProviders = isRecord(raw.providers) ? raw.providers : {};
  if (!rawModels || !Object.keys(rawModels).length) fail();

  const validCanonical = new Map<string, Json>();
  for (const [id, value] of Object.entries(rawModels)) {
    if (isChatRecord(id, value)) validCanonical.set(id, value);
  }
  if (!validCanonical.size) fail();

  const linkedByCanonical = new Map<string, LinkedEntry[]>();
  const standaloneByModelId = new Map<string, LinkedEntry[]>();

  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (!safeId(providerId) || !isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
    for (const [modelId, entry] of Object.entries(rawProvider.models)) {
      if (!isChatRecord(modelId, entry)) continue;
      const explicitLink = typeof entry.canonical_model_id === 'string' ? entry.canonical_model_id : undefined;
      const implicitLink = `${providerId}/${modelId}`;
      const targetCanonical = explicitLink && validCanonical.has(explicitLink)
        ? explicitLink
        : !explicitLink && validCanonical.has(implicitLink)
          ? implicitLink
          : undefined;

      if (targetCanonical) {
        let bucket = linkedByCanonical.get(targetCanonical);
        if (!bucket) {
          bucket = [];
          linkedByCanonical.set(targetCanonical, bucket);
        }
        bucket.push({ providerId, modelId, model: entry });
      } else if (!explicitLink) {
        let bucket = standaloneByModelId.get(modelId);
        if (!bucket) {
          bucket = [];
          standaloneByModelId.set(modelId, bucket);
        }
        bucket.push({ providerId, modelId, model: entry });
      }
    }
  }

  const models: Record<string, ModelParameters> = Object.create(null);

  for (const [canonicalId, canonicalModel] of [...validCanonical.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const slash = canonicalId.indexOf('/');
    const origin = slash >= 0 ? canonicalId.slice(0, slash) : '';
    const leaf = slash >= 0 ? canonicalId.slice(slash + 1) : canonicalId;
    const linked = [...(linkedByCanonical.get(canonicalId) ?? [])].sort(
      (a, b) => rankProvider(b.providerId, b.modelId, origin, leaf) - rankProvider(a.providerId, a.modelId, origin, leaf)
    );
    const optionSource = linked.find(item => Array.isArray(item.model.reasoning_options) && item.model.reasoning_options.length > 0)?.model
      ?? linked[0]?.model;
    const built = buildModelParameters(canonicalId, canonicalModel, optionSource, canonicalModel, updatedAt);
    if (!built) continue;
    models[canonicalId] = built;
    if (safeId(leaf) && !Object.hasOwn(models, leaf)) {
      models[leaf] = structuredClone(built);
    }
  }

  const aliasClaims = new Map<string, Map<string, { rank: number; entry: LinkedEntry; canonicalId: string }>>();
  for (const [canonicalId, entries] of linkedByCanonical) {
    const slash = canonicalId.indexOf('/');
    const origin = slash >= 0 ? canonicalId.slice(0, slash) : '';
    const leaf = slash >= 0 ? canonicalId.slice(slash + 1) : canonicalId;
    for (const entry of entries) {
      let byCanonical = aliasClaims.get(entry.modelId);
      if (!byCanonical) {
        byCanonical = new Map();
        aliasClaims.set(entry.modelId, byCanonical);
      }
      const rank = rankProvider(entry.providerId, entry.modelId, origin, leaf);
      const existing = byCanonical.get(canonicalId);
      if (!existing || rank > existing.rank) {
        byCanonical.set(canonicalId, { rank, entry, canonicalId });
      }
    }
  }

  const datelessFallbacks: Array<{ baseId: string; releaseDate: string; params: ModelParameters }> = [];

  for (const [modelId, byCanonical] of [...aliasClaims.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const ranked = [...byCanonical.values()].sort((a, b) => b.rank - a.rank);
    const top = ranked[0];
    if (!top) continue;
    const runnerUp = ranked[1];
    if (runnerUp && !(top.rank >= 75 && top.rank >= runnerUp.rank + 15)) continue;
    const canonicalParams = models[top.canonicalId];
    if (!canonicalParams) continue;

    if (!Object.hasOwn(models, modelId)) {
      const preferredName = top.rank >= 75 && typeof top.entry.model.name === 'string' && top.entry.model.name.trim()
        ? top.entry.model.name.trim().slice(0, 200)
        : canonicalParams.name;
      models[modelId] = { ...structuredClone(canonicalParams), name: preferredName };
    }

    if (top.rank >= 75) {
      const stripped = modelId.replace(/-(?:20\d{6}|\d{6})$/, '');
      if (stripped !== modelId && safeId(stripped)) {
        datelessFallbacks.push({
          baseId: stripped,
          releaseDate: canonicalParams.releaseDate ?? '',
          params: structuredClone(canonicalParams)
        });
      }
    }
  }

  datelessFallbacks.sort((a, b) => (b.releaseDate < a.releaseDate ? -1 : b.releaseDate > a.releaseDate ? 1 : 0));
  for (const item of datelessFallbacks) {
    if (!Object.hasOwn(models, item.baseId)) {
      models[item.baseId] = item.params;
    }
  }

  for (const [modelId, entries] of [...standaloneByModelId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (Object.hasOwn(models, modelId)) continue;
    const ranked = [...entries].sort(
      (a, b) => Number(MAJOR_PROVIDERS.has(b.providerId)) - Number(MAJOR_PROVIDERS.has(a.providerId))
    );
    const chosen = ranked[0];
    if (!chosen || (!MAJOR_PROVIDERS.has(chosen.providerId) && entries.length > 1)) continue;
    const built = buildModelParameters(modelId, chosen.model, chosen.model, undefined, updatedAt);
    if (!built) continue;
    models[modelId] = built;
    const leaf = modelLeaf(modelId);
    if (leaf !== modelId && safeId(leaf) && !Object.hasOwn(models, leaf) && MAJOR_PROVIDERS.has(chosen.providerId)) {
      models[leaf] = structuredClone(built);
    }
  }

  if (!Object.keys(models).length) fail();
  return validateCatalogSnapshot({
    source: 'models.dev',
    updatedAt,
    database: {
      schemaVersion: 1,
      defaults: defaultParameters(),
      models
    }
  });
}

async function fetchCatalogOnce(userSignal: AbortSignal | undefined, fetcher: typeof fetch): Promise<CatalogSnapshot> {
  const signal = userSignal
    ? AbortSignal.any([userSignal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)])
    : AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
  const response = await fetcher(CATALOG_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal
  });
  if (!response.ok || response.redirected || !response.body) fail();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) fail();
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return buildModelCatalog(raw, new Date().toISOString());
}

export async function fetchModelCatalog(userSignal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<CatalogSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    userSignal?.throwIfAborted();
    try {
      return await fetchCatalogOnce(userSignal, fetcher);
    } catch (error) {
      lastError = error;
      const timedOut = isRecord(error) && error.name === 'TimeoutError';
      if (userSignal?.aborted || timedOut || error instanceof CatalogError) throw error;
      if (attempt + 1 < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new CatalogError(t('模型目录数据格式无效。'));
}
