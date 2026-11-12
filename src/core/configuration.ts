import type { ApiType, CatalogSnapshot, ModelConfig, ModelDatabase, ModelParameters, OfficialProtocol, ParameterOverrides, ProtocolProfile, ProviderConfig } from './types';
import { t } from '../../resources/shared/i18n.js';
import { validDate } from '../../resources/shared/model-policy.js';
import { apiTypes, vendors, normalizeRouting, routeForModel, excludedKind } from '../../resources/shared/routing.js';

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const parameterKeys = ['contextWindow', 'maxOutputTokens', 'toolCalling', 'vision', 'thinking', 'supportsReasoningEffort'] as const;
const effortFormats = new Set(['chat-completions', 'responses', 'messages', 'unsupported']);

export function object(value: unknown, label = t('配置')): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('{0}必须是对象。', label));
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 512, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(t('{0}不是有效文本。', label));
  return value.trim();
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(t('{0}必须是布尔值。', label));
  return value;
}
function positiveInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100_000_000) throw new Error(t('{0}必须是 1–100000000 的整数。', label));
  return value as number;
}
function efforts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(v))) throw new Error(t('推理档位格式无效。'));
  return [...new Set(value)] as string[];
}
export function validId(value: unknown, label = t('模型 ID')): string {
  const id = text(value, label, 512);
  if (/\s|[\x00-\x1f\x7f]/.test(id) || unsafeKeys.has(id)) throw new Error(t('{0}不能包含空白或控制字符。', label));
  return id;
}

function validateModelOptions(value: unknown): NonNullable<ProtocolProfile['modelOptions']> {
  const v = object(value, t('采样参数'));
  if (Object.keys(v).some(key => key !== 'temperature' && key !== 'top_p')) throw new Error(t('采样参数包含未知字段。'));
  const result: NonNullable<ProtocolProfile['modelOptions']> = {};
  for (const key of ['temperature', 'top_p'] as const) {
    if (!Object.hasOwn(v, key)) continue;
    const item = v[key];
    if (item !== null && (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || (key === 'top_p' && item > 1))) {
      throw new Error(t('采样参数值无效。'));
    }
    result[key] = item;
  }
  return result;
}

function validateProtocolProfile(value: unknown): ProtocolProfile {
  const v = object(value, t('协议配置'));
  const allowed = ['effortFormat', 'effortValues', 'adaptiveThinking', 'thinkingBudget', 'modelOptions'];
  if (Object.keys(v).some(key => !allowed.includes(key))) throw new Error(t('协议配置包含未知字段。'));
  const result: ProtocolProfile = {};
  if (v.effortFormat !== undefined) {
    if (typeof v.effortFormat !== 'string' || !effortFormats.has(v.effortFormat)) throw new Error(t('推理档位格式无效。'));
    result.effortFormat = v.effortFormat as OfficialProtocol | 'unsupported';
  }
  if (v.effortValues !== undefined) {
    const entries = Object.entries(object(v.effortValues, t('推理档位映射')));
    efforts(entries.map(([key]) => key));
    if (entries.some(([key]) => unsafeKeys.has(key))) throw new Error(t('推理档位映射包含保留字段。'));
    result.effortValues = Object.fromEntries(entries.map(([key, item]) => [key, item === null ? null : efforts([item])[0]!]));
  }
  if (v.adaptiveThinking !== undefined) result.adaptiveThinking = bool(v.adaptiveThinking, t('自适应思考'));
  if (v.thinkingBudget !== undefined) {
    const budget = object(v.thinkingBudget, t('思考预算'));
    if (Object.keys(budget).some(key => key !== 'min' && key !== 'max')) throw new Error(t('思考预算包含未知字段。'));
    const min = positiveInt(budget.min, t('思考预算下限'));
    const max = positiveInt(budget.max, t('思考预算上限'));
    if (min > max) throw new Error(t('思考预算上限不能小于下限。'));
    result.thinkingBudget = { min, max };
  }
  if (v.modelOptions !== undefined) {
    const options = validateModelOptions(v.modelOptions);
    if (Object.keys(options).length) result.modelOptions = options;
  }
  return result;
}

export function validateProtocols(value: unknown): Partial<Record<ApiType, ProtocolProfile>> {
  const v = object(value, t('协议配置列表'));
  if (Object.keys(v).some(key => !apiTypes.includes(key as ApiType))) throw new Error(t('协议配置类型无效。'));
  return Object.fromEntries(Object.entries(v).map(([key, profile]) => [key, validateProtocolProfile(profile)]));
}

export function validateParameters(value: unknown): ModelParameters {
  const v = object(value, t('模型参数'));
  const result: ModelParameters = {
    name: text(v.name ?? '', t('显示名称'), 200, true),
    contextWindow: positiveInt(v.contextWindow, 'Context'),
    maxOutputTokens: positiveInt(v.maxOutputTokens, 'Output'),
    toolCalling: bool(v.toolCalling, t('工具调用')),
    vision: bool(v.vision, t('视觉')),
    thinking: bool(v.thinking, t('思考')),
    supportsReasoningEffort: efforts(v.supportsReasoningEffort ?? [])
  };
  // Read earlier presets using their effective output limit; only the two current fields are returned.
  if (v.defaultOutputTokens != null && v.defaultOutputTokens !== '') {
    result.maxOutputTokens = Math.min(result.maxOutputTokens, positiveInt(v.defaultOutputTokens, 'Output'));
  }
  if (v.protocols !== undefined) {
    const protocols = validateProtocols(v.protocols);
    if (Object.keys(protocols).length) result.protocols = protocols;
  }
  if (v.aliasOf !== undefined) result.aliasOf = validId(v.aliasOf, t('参数来源模型 ID'));
  if (Object.hasOwn(v, 'releaseDate') && v.releaseDate !== undefined) {
    if (v.releaseDate !== null && !validDate(v.releaseDate)) throw new Error(t('模型发布日期必须是有效的 YYYY-MM-DD 日期或 null。'));
    if (v.releaseDate !== null) result.releaseDate = v.releaseDate;
  }
  if (result.maxOutputTokens >= result.contextWindow) throw new Error(t('Output 必须小于 Context。'));
  return result;
}
export function validateDatabase(value: unknown): ModelDatabase {
  const v = object(value, t('参数库'));
  if (v.schemaVersion !== 1) throw new Error(t('参数库版本不受支持。'));
  const entries = Object.entries(object(v.models, t('模型条目')));
  if (entries.length > 20_000) throw new Error(t('参数库最多包含 20000 个模型。'));
  return { schemaVersion: 1, defaults: validateParameters(v.defaults), models: Object.fromEntries(entries.map(([id, record]) => [validId(id), validateParameters(record)])) };
}
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
export function validateOverrides(value: unknown): ParameterOverrides {
  const v = object(value ?? {}, t('覆盖参数'));
  const result: ParameterOverrides = {};
  for (const key of parameterKeys) {
    if (!Object.hasOwn(v, key)) continue;
    if (key === 'contextWindow' || key === 'maxOutputTokens') result[key] = positiveInt(v[key], key);
    else if (key === 'supportsReasoningEffort') result[key] = efforts(v[key]);
    else result[key] = bool(v[key], key);
  }
  if (v.defaultOutputTokens != null && v.defaultOutputTokens !== '') {
    const output = positiveInt(v.defaultOutputTokens, 'Output');
    result.maxOutputTokens = Math.min(result.maxOutputTokens ?? output, output);
  }
  return result;
}
export function baseParameters(database: ModelDatabase, id: string): ModelParameters {
  return Object.hasOwn(database.models, id) ? database.models[id]! : database.defaults;
}
export function effectiveParameters(database: ModelDatabase, model: ModelConfig): ModelParameters {
  return validateParameters({ ...baseParameters(database, model.id), ...model.overrides });
}
export function modelName(database: ModelDatabase, model: ModelConfig): string {
  const catalogName = Object.hasOwn(database.models, model.id) ? database.models[model.id]!.name : '';
  return model.name || catalogName || model.id;
}
export function validateModel(value: unknown, database: ModelDatabase): ModelConfig {
  const v = object(value, t('模型'));
  const result: ModelConfig = {
    id: validId(v.id), name: text(v.name ?? '', t('显示名称'), 200, true),
    discoveredName: text(v.discoveredName ?? '', t('服务商名称'), 200, true),
    overrides: validateOverrides(v.overrides)
  };
  const parameters = effectiveParameters(database, result);
  if (v.reasoningEffort != null && v.reasoningEffort !== '') {
    const effort = text(v.reasoningEffort, t('推理强度'), 40);
    if (parameters.thinking && parameters.supportsReasoningEffort.includes(effort)) result.reasoningEffort = effort;
  }
  return result;
}
export function validateUrl(value: unknown): string {
  const raw = text(value, t('API 地址'), 4096);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(t('请填写有效的 API Base URL。')); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) throw new Error(t('API 地址需要是 http(s) 基础地址，不能包含账号、查询参数或片段。'));
  return raw.replace(/\/+$/, '');
}
export function validateProvider(value: unknown, database: ModelDatabase, discovery = false): ProviderConfig {
  const v = object(value, t('供应商'));
  const enabled = bool(v.enabled ?? true, t('启用状态'));
  const id = validId(v.id, t('供应商标识'));
  if (!Array.isArray(v.models) || v.models.length > 5000) throw new Error(t('模型列表无效。'));
  if (v.endpoints !== undefined) {
    const endpoints = object(v.endpoints, t('协议地址'));
    for (const [key, address] of Object.entries(endpoints)) if (!apiTypes.includes(key as ApiType) || typeof address !== 'string') throw new Error(t('协议地址配置无效。'));
  } else if (v.apiType !== undefined && !apiTypes.includes(v.apiType as ApiType)) throw new Error(t('请选择支持的 API 协议。'));
  if (v.vendorProtocols !== undefined) {
    for (const [key, protocol] of Object.entries(object(v.vendorProtocols, t('厂商协议')))) {
      if (!vendors.some(vendor => vendor.id === key) || !apiTypes.includes(protocol as ApiType)) throw new Error(t('厂商协议配置无效。'));
    }
  }
  if (v.routingMode !== undefined && !['unified', 'split'].includes(String(v.routingMode))) throw new Error(t('请选择统一协议或区分协议。'));
  if (v.unified !== undefined) {
    const unified = object(v.unified, t('统一协议'));
    if (!apiTypes.includes(unified.apiType as ApiType) || typeof unified.url !== 'string') throw new Error(t('统一协议配置无效。'));
  }
  if (Object.hasOwn(v, 'modelProtocols')) {
    for (const [modelId, api] of Object.entries(object(v.modelProtocols, t('模型协议分配')))) {
      validId(modelId);
      if (!apiTypes.includes(api as ApiType)) throw new Error(t('模型协议分配无效。'));
    }
  }
  const models = v.models.filter(m => !excludedKind(String(object(m, t('模型')).id))).map(m => validateModel(m, database));
  if (new Set(models.map(m => m.id)).size !== models.length) throw new Error(t('同一供应商内不能重复添加模型 ID。'));
  const routing = normalizeRouting({ ...v, models });
  for (const api of apiTypes) routing.endpoints[api] = routing.endpoints[api].trim() ? validateUrl(routing.endpoints[api]) : '';
  routing.unified.url = routing.unified.url.trim() ? validateUrl(routing.unified.url) : '';
  const provider: ProviderConfig = { id, name: text(v.name, t('供应商名称'), 200), ...routing, enabled, models };
  if (enabled && !discovery) {
    for (const model of models) {
      const route = routeForModel(provider, model.id, routing);
      if (!route.url) throw new Error(provider.routingMode === 'unified' ? t('请填写统一协议的 API 地址。') : t('请填写 {0} 列表使用的协议地址。', route.apiType));
    }
  }
  return provider;
}
export function sanitizeError(error: unknown, secrets?: string | readonly string[]): string {
  let message = error instanceof Error ? error.message : t('操作失败。');
  const values = typeof secrets === 'string' ? [secrets] : secrets ?? [];
  for (const secret of [...new Set(values.flatMap(value => [value, value.trim()]))].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join('[REDACTED]');
  }
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 2000);
}
