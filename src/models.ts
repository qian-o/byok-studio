import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { t } from '../resources/shared/i18n.js';
import {
  apiTypes,
  baseParametersForProtocol,
  displayModelName,
  formatModelName,
  isExcludedModel,
  lookupPreset,
  normalizeRouting,
  recommendedProtocol,
  routeForModel,
  validDate,
  type RoutingConfig
} from '../resources/shared/routing.js';
import type {
  ApiType,
  CatalogSnapshot,
  ExportedProvider,
  ModelConfig,
  ModelDatabase,
  ModelParameters,
  OfficialGroup,
  OfficialModel,
  OfficialProtocol,
  ParameterOverrides,
  ProtocolProfile,
  ProviderConfig,
  RoutingHint
} from './types';

export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const OVERRIDE_KEYS = ['contextWindow', 'maxOutputTokens', 'toolCalling', 'vision', 'thinking', 'supportsReasoningEffort'] as const;
const EFFORT_FORMATS = new Set(['chat-completions', 'responses', 'messages', 'unsupported']);
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|responses|messages|models)$/;
const VERSION_SEGMENT = /(?:^|\/)v\d+(?:[a-z][\w.-]*)?(?:\/|$)/i;

export const MANAGED_MODEL_FIELDS = [
  'id', 'name', 'url', 'apiType', 'toolCalling', 'vision', 'thinking',
  'maxInputTokens', 'maxOutputTokens', 'contextWindow', 'defaultOutputTokens', 'contextWindowMode',
  'adaptiveThinking', 'minThinkingBudget', 'maxThinkingBudget',
  'supportsReasoningEffort', 'reasoningEffortFormat', 'defaultReasoningEffort',
  'streaming', 'modelOptions', 'zeroDataRetentionEnabled', 'statefulResponses'
] as const;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const isSecretReference = (value: unknown): value is string =>
  typeof value === 'string' && /^\$\{input:chat\.lm\.secret\.[^}]+\}$/.test(value);

export function asObject(value: unknown, label = t('配置')): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(t('{0}必须是对象。', label));
  return value;
}

export function asText(value: unknown, label: string, max = 512, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error(t('{0}不是有效文本。', label));
  }
  return value.trim();
}

function asBool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(t('{0}必须是布尔值。', label));
  return value;
}

function asPositiveInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100_000_000) {
    throw new Error(t('{0}必须是 1–100000000 的整数。', label));
  }
  return value as number;
}

function asEfforts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(v))) {
    throw new Error(t('推理档位格式无效。'));
  }
  return [...new Set(value)] as string[];
}

export function validId(value: unknown, label = t('模型 ID')): string {
  const id = asText(value, label, 512);
  if (/\s|[\x00-\x1f\x7f]/.test(id) || UNSAFE_KEYS.has(id)) {
    throw new Error(t('{0}不能包含空白或控制字符。', label));
  }
  return id;
}

export function validateUrl(value: unknown): string {
  const raw = asText(value, t('API 地址'), 4096);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(t('请填写有效的 API Base URL。')); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error(t('请填写 http(s) 基础地址，不包含账号、查询参数或片段。'));
  }
  return raw.replace(/\/+$/, '');
}

export function resolveEndpoint(baseUrl: string, apiType: ApiType, operation: 'chat' | 'models'): string {
  if (!apiTypes.includes(apiType) || !['chat', 'models'].includes(operation)) {
    throw new Error(t('不支持的操作。'));
  }
  const clean = validateUrl(baseUrl);
  const url = new URL(clean);
  let pathname = url.pathname.replace(/\/+$/, '');
  if (ENDPOINT_SUFFIX.test(pathname)) {
    pathname = pathname.replace(ENDPOINT_SUFFIX, '');
  } else if (!VERSION_SEGMENT.test(pathname)) {
    pathname += '/v1';
  }
  const suffix = operation === 'models'
    ? 'models'
    : { responses: 'responses', chatCompletions: 'chat/completions', messages: 'messages' }[apiType];
  url.pathname = `${pathname}/${suffix}`;
  return url.toString();
}

export function extractBaseUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) {
      return '';
    }
    const stripped = url.pathname.replace(/\/+$/, '');
    if (ENDPOINT_SUFFIX.test(stripped)) {
      const prefix = stripped.replace(ENDPOINT_SUFFIX, '');
      if (VERSION_SEGMENT.test(prefix)) {
        url.pathname = prefix;
        return url.toString().replace(/\/+$/, '');
      }
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function officialProtocol(apiType: ApiType): OfficialProtocol {
  return apiType === 'chatCompletions' ? 'chat-completions' : apiType;
}

export function fromOfficialProtocol(protocol: unknown, fallbackModelId: string): ApiType {
  if (protocol === 'responses') return 'responses';
  if (protocol === 'messages') return 'messages';
  if (protocol === 'chat-completions' || protocol === 'chatCompletions') return 'chatCompletions';
  return recommendedProtocol(fallbackModelId);
}

function validateProtocolProfile(value: unknown): ProtocolProfile {
  const v = asObject(value, t('协议配置'));
  const allowed = ['effortFormat', 'adaptiveThinking', 'thinkingBudget', 'modelOptions'];
  if (Object.keys(v).some(key => !allowed.includes(key))) throw new Error(t('协议配置包含未知字段。'));
  const result: ProtocolProfile = {};
  if (v.effortFormat !== undefined) {
    if (typeof v.effortFormat !== 'string' || !EFFORT_FORMATS.has(v.effortFormat)) throw new Error(t('推理档位格式无效。'));
    result.effortFormat = v.effortFormat as OfficialProtocol | 'unsupported';
  }
  if (v.adaptiveThinking !== undefined) result.adaptiveThinking = asBool(v.adaptiveThinking, 'adaptiveThinking');
  if (v.thinkingBudget !== undefined) {
    const budget = asObject(v.thinkingBudget, 'thinkingBudget');
    if (Object.keys(budget).some(key => key !== 'min' && key !== 'max')) throw new Error(t('协议配置包含未知字段。'));
    const min = asPositiveInt(budget.min, 'minThinkingBudget');
    const max = asPositiveInt(budget.max, 'maxThinkingBudget');
    if (min > max) throw new Error(t('协议配置包含未知字段。'));
    result.thinkingBudget = { min, max };
  }
  if (v.modelOptions !== undefined) {
    const opts = asObject(v.modelOptions, 'modelOptions');
    if (Object.keys(opts).some(key => key !== 'temperature' && key !== 'top_p')) throw new Error(t('协议配置包含未知字段。'));
    const modelOptions: NonNullable<ProtocolProfile['modelOptions']> = {};
    for (const key of ['temperature', 'top_p'] as const) {
      if (!Object.hasOwn(opts, key)) continue;
      const item = opts[key];
      if (item !== null && (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || (key === 'top_p' && item > 1))) {
        throw new Error(t('协议配置包含未知字段。'));
      }
      modelOptions[key] = item;
    }
    if (Object.keys(modelOptions).length) result.modelOptions = modelOptions;
  }
  return result;
}

export function validateProtocols(value: unknown): Partial<Record<ApiType, ProtocolProfile>> {
  const v = asObject(value, t('协议配置'));
  if (Object.keys(v).some(key => !apiTypes.includes(key as ApiType))) throw new Error(t('协议配置包含未知字段。'));
  return Object.fromEntries(Object.entries(v).map(([key, profile]) => [key, validateProtocolProfile(profile)]));
}

export function validateParameters(value: unknown): ModelParameters {
  const v = asObject(value, t('模型参数'));
  const result: ModelParameters = {
    name: asText(v.name ?? '', t('显示名称'), 200, true),
    contextWindow: asPositiveInt(v.contextWindow, 'Context'),
    maxOutputTokens: asPositiveInt(v.maxOutputTokens, 'Output'),
    toolCalling: asBool(v.toolCalling, t('工具调用')),
    vision: asBool(v.vision, t('视觉')),
    thinking: asBool(v.thinking, t('思考')),
    supportsReasoningEffort: asEfforts(v.supportsReasoningEffort ?? [])
  };
  if (v.protocols !== undefined) {
    const protocols = validateProtocols(v.protocols);
    if (Object.keys(protocols).length) result.protocols = protocols;
  }
  if (Object.hasOwn(v, 'releaseDate') && v.releaseDate !== undefined && v.releaseDate !== null) {
    if (!validDate(v.releaseDate)) throw new Error(t('模型目录数据格式无效。'));
    result.releaseDate = v.releaseDate;
  }
  if (result.maxOutputTokens >= result.contextWindow) {
    throw new Error(t('Output 必须小于 Context。'));
  }
  return result;
}

export function validateDatabase(value: unknown): ModelDatabase {
  const v = asObject(value, t('参数库'));
  if (v.schemaVersion !== 1) throw new Error(t('模型目录数据格式无效。'));
  const entries = Object.entries(asObject(v.models, t('参数库')));
  if (entries.length > 100_000) throw new Error(t('模型目录数据格式无效。'));
  return {
    schemaVersion: 1,
    defaults: validateParameters(v.defaults),
    models: Object.fromEntries(entries.map(([id, record]) => [validId(id), validateParameters(record)]))
  };
}

export function validateCatalogSnapshot(value: unknown): CatalogSnapshot {
  const raw = asObject(value);
  const timestamp = raw.updatedAt;
  if (raw.source !== 'models.dev'
    || typeof timestamp !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(t('模型目录数据格式无效。'));
  }
  return { source: 'models.dev', updatedAt: timestamp, database: validateDatabase(raw.database) };
}

export function validateOverrides(value: unknown): ParameterOverrides {
  const v = asObject(value ?? {}, t('模型参数'));
  const result: ParameterOverrides = {};
  for (const key of OVERRIDE_KEYS) {
    if (!Object.hasOwn(v, key)) continue;
    if (key === 'contextWindow' || key === 'maxOutputTokens') result[key] = asPositiveInt(v[key], key);
    else if (key === 'supportsReasoningEffort') result[key] = asEfforts(v[key]);
    else result[key] = asBool(v[key], key);
  }
  return result;
}

export function effectiveParameters(database: ModelDatabase, model: ModelConfig, apiType?: ApiType): ModelParameters {
  const base = baseParametersForProtocol(database, model.id, apiType);
  return validateParameters({ ...base, ...model.overrides });
}

export function validateModel(value: unknown, database: ModelDatabase, apiType?: ApiType): ModelConfig {
  const v = asObject(value, t('模型'));
  const result: ModelConfig = {
    id: validId(v.id),
    name: asText(v.name ?? '', t('显示名称'), 200, true),
    overrides: validateOverrides(v.overrides)
  };
  const parameters = effectiveParameters(database, result, apiType);
  if (parameters.thinking && apiType === 'messages') {
    const profile = lookupPreset(database, result.id).protocols?.messages;
    if (!profile?.adaptiveThinking && profile?.thinkingBudget && parameters.maxOutputTokens <= profile.thinkingBudget.min) {
      throw new Error(t('Output 必须大于该模型的最小思考预算（{0}）。', profile.thinkingBudget.min));
    }
  }
  if (v.reasoningEffort != null && v.reasoningEffort !== '') {
    const effort = asText(v.reasoningEffort, t('推理强度'), 40);
    if (!parameters.thinking || !parameters.supportsReasoningEffort.includes(effort)) {
      throw new Error(t('请选择可用的实际推理档位。'));
    }
    result.reasoningEffort = effort;
  }
  return result;
}

export function compileOfficialModel(
  provider: ProviderConfig,
  database: ModelDatabase,
  model: ModelConfig,
  routing: RoutingConfig = normalizeRouting(provider)
): OfficialModel {
  const route = routeForModel(provider, model.id, routing);
  const apiType = officialProtocol(route.apiType);
  const preset = lookupPreset(database, model.id);
  const parameters = effectiveParameters(database, model, route.apiType);
  const profile = preset.protocols?.[route.apiType];
  const result: OfficialModel = {
    id: model.id,
    name: displayModelName(database, model),
    url: resolveEndpoint(route.url, route.apiType, 'chat'),
    apiType,
    toolCalling: parameters.toolCalling,
    vision: parameters.vision,
    contextWindow: parameters.contextWindow,
    maxOutputTokens: parameters.maxOutputTokens
  };
  if (parameters.thinking) {
    result.thinking = true;
    if (parameters.supportsReasoningEffort.length) {
      result.supportsReasoningEffort = [...parameters.supportsReasoningEffort];
      const format = profile?.effortFormat && profile.effortFormat !== 'unsupported' ? profile.effortFormat : apiType;
      if (format !== apiType) result.reasoningEffortFormat = format;
      if (model.reasoningEffort && parameters.supportsReasoningEffort.includes(model.reasoningEffort)) {
        result.defaultReasoningEffort = model.reasoningEffort;
      }
    }
    if (route.apiType === 'messages') {
      if (profile?.adaptiveThinking) {
        result.adaptiveThinking = true;
      } else if (profile?.thinkingBudget) {
        if (result.maxOutputTokens <= profile.thinkingBudget.min) {
          throw new Error(t('Output 必须大于该模型的最小思考预算（{0}）。', profile.thinkingBudget.min));
        }
        result.minThinkingBudget = profile.thinkingBudget.min;
        result.maxThinkingBudget = Math.min(profile.thinkingBudget.max, result.maxOutputTokens - 1);
      } else if (recommendedProtocol(model.id) === 'messages' || result.maxOutputTokens <= 1024) {
        result.adaptiveThinking = true;
      } else {
        result.minThinkingBudget = 1024;
        result.maxThinkingBudget = Math.min(32000, result.maxOutputTokens - 1);
      }
      if (result.adaptiveThinking && !parameters.supportsReasoningEffort.length) {
        result.supportsReasoningEffort = [];
      }
    }
  }
  if (profile?.modelOptions && Object.keys(profile.modelOptions).length) {
    result.modelOptions = { ...profile.modelOptions };
  }
  return result;
}

export function validateProvider(value: unknown, database: ModelDatabase, discovery = false): ProviderConfig {
  const v = asObject(value, t('供应商'));
  const id = validId(v.id, t('供应商标识'));
  const name = asText(v.name, t('供应商名称'), 200);
  if (!Array.isArray(v.models) || v.models.length > 5000) throw new Error(t('每个供应商最多支持 5000 个模型。'));
  if (v.routingMode !== undefined && v.routingMode !== 'unified' && v.routingMode !== 'split') {
    throw new Error(t('请选择统一协议或区分协议。'));
  }
  if (v.unified !== undefined) {
    const unified = asObject(v.unified, t('统一协议'));
    if (!apiTypes.includes(unified.apiType as ApiType) || typeof unified.url !== 'string') {
      throw new Error(t('协议配置无效。'));
    }
  }
  if (v.endpoints !== undefined) {
    const endpoints = asObject(v.endpoints, t('协议配置'));
    for (const [key, address] of Object.entries(endpoints)) {
      if (!apiTypes.includes(key as ApiType) || typeof address !== 'string') throw new Error(t('协议配置无效。'));
    }
  }
  if (Object.hasOwn(v, 'modelProtocols') && v.modelProtocols !== undefined) {
    for (const [modelId, api] of Object.entries(asObject(v.modelProtocols, t('协议配置')))) {
      validId(modelId);
      if (!apiTypes.includes(api as ApiType)) throw new Error(t('请选择有效的请求协议。'));
    }
  }

  const rawModels = v.models
    .map(m => asObject(m, t('模型')))
    .filter(m => !isExcludedModel(String(m.id ?? '')));
  const preliminaryRouting = normalizeRouting({
    ...(v as Record<string, unknown>),
    models: rawModels.map(m => ({ id: validId(m.id) }))
  });
  const models = rawModels.map(m => {
    const modelId = validId(m.id);
    const route = routeForModel(preliminaryRouting, modelId, preliminaryRouting);
    return validateModel(m, database, route.apiType);
  });
  if (new Set(models.map(m => m.id)).size !== models.length) {
    throw new Error(t('同一供应商内不能重复添加模型 ID。'));
  }

  const routing = normalizeRouting({ ...(v as Record<string, unknown>), models });
  for (const api of apiTypes) {
    routing.endpoints[api] = routing.endpoints[api].trim() ? validateUrl(routing.endpoints[api]) : '';
  }
  routing.unified.url = routing.unified.url.trim() ? validateUrl(routing.unified.url) : '';

  const provider: ProviderConfig = { id, name, ...routing, models };
  if (!discovery) {
    for (const model of models) {
      const route = routeForModel(provider, model.id, routing);
      if (!route.url) {
        const protocolLabel = { responses: 'Responses', chatCompletions: 'Chat Completions', messages: 'Messages' }[route.apiType];
        throw new Error(t('{0} 使用 {1}，请填写对应的基础 URL。', displayModelName(database, model), protocolLabel));
      }
      compileOfficialModel(provider, database, model, routing);
    }
  }
  return provider;
}

export function manualGroupId(name: string): string {
  return `manual-${createHash('sha256').update(name.trim()).digest('hex').slice(0, 12)}`;
}

export function groupIdentity(group: Record<string, unknown>): string | undefined {
  if (group.vendor !== 'customendpoint') return undefined;
  if (typeof group.byokStudioId === 'string' && group.byokStudioId.trim()) {
    return group.byokStudioId.trim();
  }
  if (typeof group.name === 'string' && group.name.trim()) {
    return manualGroupId(group.name);
  }
  return undefined;
}

export function buildMergedOfficialGroup(
  provider: ProviderConfig,
  database: ModelDatabase,
  existing?: Record<string, unknown>,
  secretReference?: string
): Record<string, unknown> {
  const routing = normalizeRouting(provider);
  const compiledModels = provider.models.map(model => compileOfficialModel(provider, database, model, routing));
  const oldModelsById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(existing?.models)) {
    for (const item of existing.models) {
      if (isRecord(item) && typeof item.id === 'string' && item.id.trim()) {
        oldModelsById.set(item.id.trim(), item);
      }
    }
  }

  const mergedModels = compiledModels.map(compiled => {
    const retained: Record<string, unknown> = { ...oldModelsById.get(compiled.id) };
    for (const field of MANAGED_MODEL_FIELDS) delete retained[field];
    return { ...retained, ...compiled };
  });

  const merged: Record<string, unknown> = {
    ...existing,
    name: provider.name,
    vendor: 'customendpoint',
    byokStudioId: provider.id
  };
  delete merged.apiType;
  delete merged.zeroDataRetentionEnabled;
  delete merged.statefulResponses;
  delete merged.byokStudioStageFor;

  if (secretReference) merged.apiKey = secretReference;
  else delete merged.apiKey;

  merged.models = mergedModels;

  const existingSettings = isRecord(existing?.settings) ? structuredClone(existing.settings) as Record<string, unknown> : {};
  const settings: Record<string, Record<string, unknown>> = {};
  const survivingIds = new Set(compiledModels.map(m => m.id));
  for (const [key, val] of Object.entries(existingSettings)) {
    if (survivingIds.has(key) && isRecord(val)) {
      settings[key] = { ...val };
    }
  }
  for (const model of compiledModels) {
    const current = settings[model.id] ? { ...settings[model.id] } : {};
    delete current.zeroDataRetentionEnabled;
    delete current.statefulResponses;
    if (model.defaultReasoningEffort) current.reasoningEffort = model.defaultReasoningEffort;
    else delete current.reasoningEffort;
    if (Object.keys(current).length) settings[model.id] = current;
    else delete settings[model.id];
  }
  if (Object.keys(settings).length) merged.settings = settings;
  else delete merged.settings;

  return merged as OfficialGroup & Record<string, unknown>;
}

export function readOfficialGroup(
  group: Record<string, unknown>,
  database: ModelDatabase,
  hint?: RoutingHint
): ProviderConfig | undefined {
  if (group.vendor !== 'customendpoint' || typeof group.name !== 'string' || !group.name.trim()) {
    return undefined;
  }
  const id = groupIdentity(group);
  if (!id || /\s|[\x00-\x1f\x7f]/.test(id) || UNSAFE_KEYS.has(id)) return undefined;
  const name = group.name.trim().slice(0, 200);
  const rawSettings = isRecord(group.settings) ? group.settings : {};

  const models: ModelConfig[] = [];
  const modelProtocols: Record<string, ApiType> = {};
  const observedUrls: Partial<Record<ApiType, string>> = {};
  const observedRawUrls: Partial<Record<ApiType, Set<string>>> = {};
  const distinctRoutes = new Set<string>();
  const seenIds = new Set<string>();

  for (const entry of Array.isArray(group.models) ? group.models : []) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    const modelId = entry.id.trim();
    if (!modelId || modelId.length > 512 || /\s|[\x00-\x1f\x7f]/.test(modelId) || UNSAFE_KEYS.has(modelId)) continue;
    if (seenIds.has(modelId) || isExcludedModel(modelId)) continue;
    seenIds.add(modelId);

    const apiType = fromOfficialProtocol(entry.apiType, modelId);
    const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : '';
    const baseUrl = rawUrl ? extractBaseUrl(rawUrl) : '';
    modelProtocols[modelId] = apiType;
    if (baseUrl) {
      if (!observedUrls[apiType]) observedUrls[apiType] = baseUrl;
      let normalizedRaw: string | undefined;
      try { normalizedRaw = new URL(rawUrl).toString(); } catch { normalizedRaw = undefined; }
      if (normalizedRaw) {
        let rawSet = observedRawUrls[apiType];
        if (!rawSet) {
          rawSet = new Set<string>();
          observedRawUrls[apiType] = rawSet;
        }
        rawSet.add(normalizedRaw);
      }
    }
    distinctRoutes.add(`${apiType}|${baseUrl}`);

    const base = baseParametersForProtocol(database, modelId, apiType);
    const rawName = typeof entry.name === 'string' ? entry.name.trim().slice(0, 200) : '';
    const defaultName = displayModelName(database, { id: modelId });

    const contextWindow = Number.isSafeInteger(entry.contextWindow) && (entry.contextWindow as number) >= 2 && (entry.contextWindow as number) <= 100_000_000
      ? (entry.contextWindow as number)
      : base.contextWindow;
    const rawOutput = Number.isSafeInteger(entry.maxOutputTokens) && (entry.maxOutputTokens as number) >= 1 && (entry.maxOutputTokens as number) <= 100_000_000
      ? (entry.maxOutputTokens as number)
      : base.maxOutputTokens;
    const maxOutputTokens = Math.min(rawOutput, contextWindow - 1);
    const toolCalling = typeof entry.toolCalling === 'boolean' ? entry.toolCalling : base.toolCalling;
    const vision = typeof entry.vision === 'boolean' ? entry.vision : base.vision;
    const hasExplicitCaps = typeof entry.toolCalling === 'boolean' || typeof entry.thinking === 'boolean';
    const thinking = hasExplicitCaps ? entry.thinking === true : base.thinking;

    let supportsReasoningEffort: string[];
    if (Array.isArray(entry.supportsReasoningEffort)) {
      supportsReasoningEffort = [...new Set(
        entry.supportsReasoningEffort.filter((v): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(v))
      )].slice(0, 32);
    } else if (thinking && hasExplicitCaps) {
      supportsReasoningEffort = [];
    } else {
      supportsReasoningEffort = [...base.supportsReasoningEffort];
    }

    const effective: Record<typeof OVERRIDE_KEYS[number], unknown> = {
      contextWindow,
      maxOutputTokens,
      toolCalling,
      vision,
      thinking,
      supportsReasoningEffort
    };
    const overrides: ParameterOverrides = {};
    for (const key of OVERRIDE_KEYS) {
      if (!isDeepStrictEqual(effective[key], base[key])) {
        (overrides as Record<string, unknown>)[key] = effective[key];
      }
    }

    const settingEntry = isRecord(rawSettings[modelId]) ? rawSettings[modelId] : undefined;
    const rawDefaultEffort = typeof entry.defaultReasoningEffort === 'string' && entry.defaultReasoningEffort
      ? entry.defaultReasoningEffort
      : typeof settingEntry?.reasoningEffort === 'string' ? settingEntry.reasoningEffort : '';
    const reasoningEffort = thinking && rawDefaultEffort && supportsReasoningEffort.includes(rawDefaultEffort)
      ? rawDefaultEffort
      : undefined;

    const autoFormattedName = formatModelName(modelId);

    models.push({
      id: modelId,
      name: rawName && rawName !== defaultName && rawName !== modelId && rawName !== autoFormattedName ? rawName : '',
      overrides,
      ...(reasoningEffort ? { reasoningEffort } : {})
    });
  }

  let routingMode: ProviderConfig['routingMode'];
  let unified: ProviderConfig['unified'];
  let endpoints: ProviderConfig['endpoints'];

  const hintEndpoints: Record<ApiType, string> = {
    responses: hint?.endpoints?.responses ?? '',
    chatCompletions: hint?.endpoints?.chatCompletions ?? '',
    messages: hint?.endpoints?.messages ?? ''
  };
  const hintUnifiedUrl = hint?.unified?.url ?? '';

  const matchHintBaseUrl = (apiType: ApiType, ...candidates: Array<string | undefined>): string | undefined => {
    const rawSet = observedRawUrls[apiType];
    if (!rawSet || rawSet.size !== 1) return undefined;
    for (const candidate of candidates) {
      if (!candidate?.trim()) continue;
      try {
        const clean = validateUrl(candidate);
        if (rawSet.has(resolveEndpoint(clean, apiType, 'chat'))) return clean;
      } catch {
        // Ignore invalid hint URL candidates.
      }
    }
    return undefined;
  };

  if (models.length === 0) {
    routingMode = hint?.routingMode === 'split' ? 'split' : 'unified';
    unified = hint?.unified && apiTypes.includes(hint.unified.apiType)
      ? { apiType: hint.unified.apiType, url: hintUnifiedUrl }
      : { apiType: 'chatCompletions', url: '' };
    endpoints = hintEndpoints;
  } else if (distinctRoutes.size > 1) {
    routingMode = 'split';
    endpoints = {
      responses: matchHintBaseUrl('responses', hintEndpoints.responses, hintUnifiedUrl) ?? observedUrls.responses ?? hintEndpoints.responses,
      chatCompletions: matchHintBaseUrl('chatCompletions', hintEndpoints.chatCompletions, hintUnifiedUrl) ?? observedUrls.chatCompletions ?? hintEndpoints.chatCompletions,
      messages: matchHintBaseUrl('messages', hintEndpoints.messages, hintUnifiedUrl) ?? observedUrls.messages ?? hintEndpoints.messages
    };
    const firstApi = modelProtocols[models[0]!.id]!;
    const firstUrl = endpoints[firstApi] || '';
    unified = {
      apiType: hint?.unified?.apiType && apiTypes.includes(hint.unified.apiType) ? hint.unified.apiType : firstApi,
      url: hintUnifiedUrl || firstUrl
    };
  } else {
    const onlyApi = modelProtocols[models[0]!.id]!;
    if (hint?.routingMode === 'split') {
      routingMode = 'split';
      const onlyUrl = matchHintBaseUrl(onlyApi, hintEndpoints[onlyApi], hintUnifiedUrl) ?? observedUrls[onlyApi] ?? '';
      endpoints = { ...hintEndpoints, [onlyApi]: onlyUrl || hintEndpoints[onlyApi] };
      unified = {
        apiType: hint.unified?.apiType && apiTypes.includes(hint.unified.apiType) ? hint.unified.apiType : onlyApi,
        url: hintUnifiedUrl || endpoints[onlyApi]
      };
    } else {
      routingMode = 'unified';
      const onlyUrl = matchHintBaseUrl(onlyApi, hintUnifiedUrl, hintEndpoints[onlyApi]) ?? observedUrls[onlyApi] ?? '';
      const endpointOnlyUrl = matchHintBaseUrl(onlyApi, hintEndpoints[onlyApi], hintUnifiedUrl) ?? observedUrls[onlyApi] ?? '';
      unified = { apiType: onlyApi, url: onlyUrl || hintUnifiedUrl || '' };
      endpoints = { ...hintEndpoints, [onlyApi]: endpointOnlyUrl || hintEndpoints[onlyApi] || unified.url };
    }
  }

  return { id, name, routingMode, unified, endpoints, modelProtocols, models };
}

export function parseImportData(value: unknown, database: ModelDatabase): ExportedProvider[] {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_IMPORT_BYTES) {
      throw new Error(t('导入内容超过 16 MiB 大小限制。'));
    }
    if (!value.trim()) throw new Error(t('未读取到有效的配置内容。'));
    try { value = JSON.parse(value.replace(/^\uFEFF/, '')); }
    catch { throw new Error(t('导入内容不是有效的 JSON。')); }
  }

  let rawProviders: unknown[];
  if (Array.isArray(value)) {
    rawProviders = value;
  } else {
    const raw = asObject(value, t('导入的配置'));
    if (raw.version !== 1 || !Array.isArray(raw.providers)) {
      throw new Error(t('导入的配置格式或版本不受支持。'));
    }
    rawProviders = raw.providers;
  }

  if (!rawProviders.length || rawProviders.length > 200) {
    throw new Error(t('导入的供应商数量必须在 1–200 之间。'));
  }

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const results: ExportedProvider[] = [];

  for (const entry of rawProviders) {
    const item = asObject(entry, t('供应商'));
    let provider: ProviderConfig;
    if (item.vendor === 'customendpoint' && item.unified === undefined && item.endpoints === undefined) {
      const converted = readOfficialGroup(item, database);
      if (!converted) continue;
      provider = validateProvider({ ...converted, id: item.byokStudioId ?? `provider-${createHash('sha256').update(converted.name).digest('hex').slice(0, 12)}` }, database);
    } else {
      provider = validateProvider(item, database);
    }
    if (seenIds.has(provider.id) || seenNames.has(provider.name)) {
      throw new Error(t('导入的配置包含重复的供应商标识或名称。'));
    }
    seenIds.add(provider.id);
    seenNames.add(provider.name);

    const rawKey = item.apiKey;
    const apiKey = rawKey === undefined || rawKey === null || rawKey === '' || isSecretReference(rawKey)
      ? undefined
      : asText(rawKey, 'API Key', 16000);
    results.push(apiKey === undefined ? provider : { ...provider, apiKey });
  }

  if (!results.length) throw new Error(t('未读取到有效的配置内容。'));
  return results;
}

export function sanitizeError(error: unknown, secrets?: string | readonly string[]): string {
  let message = error instanceof Error ? error.message : t('操作失败，请重试。');
  const values = typeof secrets === 'string' ? [secrets] : secrets ?? [];
  const candidates = [...new Set(values.flatMap(v => [v, v.trim()]))].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of candidates) {
    message = message.split(secret).join('[REDACTED]');
  }
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 2000);
}
