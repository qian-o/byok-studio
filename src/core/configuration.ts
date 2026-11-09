import type { ApiType, ContextPricing, ModelApiProfile, ModelConfig, ModelDatabase, ModelParameters, ParameterOverrides, ParameterValue, ProviderConfig, ReasoningControls } from './types';
import { t } from '../../resources/shared/i18n.js';
import { validDate } from '../../resources/shared/model-policy.js';
import { apiTypes, vendors, normalizeRouting, routeForModel, excludedKind } from '../../resources/shared/routing.js';

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const parameterKeys = ['contextWindow', 'maxInputTokens', 'maxOutputTokens', 'defaultOutputTokens', 'toolCalling', 'vision', 'thinking', 'supportsReasoningEffort'] as const;
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
export function validateContextPricing(value: unknown): ContextPricing {
  const v = object(value, t('Context 计费配置'));
  if (!['tiered', 'flat', 'unknown'].includes(String(v.kind))) throw new Error(t('Context 计费类型无效。'));
  if (!['direct-api', 'copilot', 'custom'].includes(String(v.scope))) throw new Error(t('Context 计费适用渠道无效。'));
  if (!Array.isArray(v.thresholds) || v.thresholds.length > 8) throw new Error(t('Context 计费阈值必须是最多8个整数的列表。'));
  const thresholds = v.thresholds.map(value => positiveInt(value, t('Context 计费阈值')));
  if (new Set(thresholds).size !== thresholds.length) throw new Error(t('Context 计费阈值不能重复。'));
  thresholds.sort((a,b) => a-b);
  if ((v.kind === 'tiered') !== Boolean(thresholds.length)) throw new Error(t('分段计费需要至少一个阈值；未核实或不分段时阈值应为空。'));
  const source = text(v.source ?? '', t('Context 计费来源'), 4000, v.kind === 'unknown');
  const checkedAt = v.checkedAt == null ? null : text(v.checkedAt, t('Context 计费核验日期'), 10);
  if (checkedAt !== null && !validDate(checkedAt)) throw new Error(t('Context 计费核验日期必须是有效的 YYYY-MM-DD 日期。'));
  const result: ContextPricing = { kind: v.kind as ContextPricing['kind'], scope: v.scope as ContextPricing['scope'], thresholds, source, checkedAt, note: text(v.note ?? '', t('Context 计费说明'), 4000, true) };
  if (v.rates !== undefined) {
    const rates = object(v.rates, t('分段费率'));
    if (!['USD', 'CNY'].includes(String(rates.currency)) || rates.perTokens !== 1000000 || !Array.isArray(rates.bands) || !rates.bands.length || rates.bands.length > 32) throw new Error(t('费率必须注明币种、每百万 token 单位和有效分段。'));
    const price = (value: unknown): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(t('分段费率必须为非负数。'));
      return value;
    };
    result.rates = { currency: rates.currency as 'USD' | 'CNY', perTokens: 1000000, bands: rates.bands.map(raw => {
      const band = object(raw, t('计费分段'));
      const inputUpTo = band.inputUpTo === null ? null : positiveInt(band.inputUpTo, t('输入分段上限'));
      if (inputUpTo !== null && !thresholds.includes(inputUpTo)) throw new Error(t('输入费率分段必须与 Context 阈值一致。'));
      return { inputUpTo, input: price(band.input), output: price(band.output),
        ...(band.outputUpTo !== undefined ? { outputUpTo: band.outputUpTo === null ? null : positiveInt(band.outputUpTo, t('输出分段上限')) } : {}),
        ...(band.cacheRead !== undefined ? { cacheRead: price(band.cacheRead) } : {}),
        ...(band.cacheWrite !== undefined ? { cacheWrite: price(band.cacheWrite) } : {}) };
    }) };
    if (result.kind === 'unknown') throw new Error(t('未核实的计费策略不能声明已核实费率。'));
    for (const inputUpTo of [...thresholds, null]) {
      const bands = result.rates.bands.filter(band => band.inputUpTo === inputUpTo);
      if (!bands.length) throw new Error(t('分段费率必须覆盖每个输入区间及最后一段。'));
      if (bands.some(band => band.outputUpTo !== undefined)) {
        if (bands.some(band => band.outputUpTo === undefined) || !bands.some(band => band.outputUpTo === null)) throw new Error(t('输出分段必须完整覆盖到最后一段。'));
        if (new Set(bands.map(band => band.outputUpTo)).size !== bands.length) throw new Error(t('输出计费分段不能重复。'));
      } else if (bands.length !== 1) throw new Error(t('输入计费分段不能重复。'));
    }
  }
  return result;
}
const requestParameterRoots = new Set(['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking', 'output_config', 'extra_body', 'generation_config', 'temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'frequency_penalty', 'repetition_penalty', 'seed', 'stop']);
const reservedProfileKeys = new Set(['model', 'messages', 'input', 'instructions', 'system', 'prompt', 'tools', 'toolchoice', 'functions', 'functioncall', 'stream', 'streamoptions', 'headers', 'header', 'authorization', 'auth', 'apikey', 'xapikey', 'accesstoken', 'bearertoken', 'credentials', 'credential', 'password', 'secret', 'clientsecret', 'cookie', 'cookies', 'url', 'baseurl', 'endpoint', 'method', 'body', 'request', 'store', 'include', 'maxtokens', 'maxoutputtokens', 'maxcompletiontokens']);
function profileKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(key) && !unsafeKeys.has(key) && !reservedProfileKeys.has(key.replace(/[-_]/g, '').toLowerCase());
}
function profilePath(value: unknown, metadata = false): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 8 || value.some(key => typeof key !== 'string' || !profileKey(key))) throw new Error(t('协议参数路径无效或包含保留字段。'));
  if (metadata ? ['index', 'id', 'type', 'function', 'name', 'arguments'].includes(value[0]) : !requestParameterRoots.has(value[0])) throw new Error(t('协议参数路径不在允许范围内。'));
  return [...value];
}
function profileScalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 4096)) return value;
  throw new Error(t('协议参数值必须是有效标量。'));
}
function profileParameters(value: unknown): Record<string, ParameterValue> {
  let nodes = 0;
  const clone = (value: unknown, depth: number): ParameterValue => {
    if (++nodes > 512 || depth > 8) throw new Error(t('协议参数超过复杂度限制。'));
    if (Array.isArray(value)) {
      if (value.length > 32) throw new Error(t('协议参数列表过长。'));
      return value.map(item => clone(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(object(value, t('协议参数')));
      if (entries.length > 32 || entries.some(([key]) => !profileKey(key) || (depth === 0 && !requestParameterRoots.has(key)))) throw new Error(t('协议参数包含不允许的字段。'));
      return Object.fromEntries(entries.map(([key, item]) => [key, clone(item, depth + 1)]));
    }
    return profileScalar(value);
  };
  object(value, t('协议参数'));
  const result = clone(value, 0) as Record<string, ParameterValue>;
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw new Error(t('协议参数过大。'));
  return result;
}
function effortMap<T>(value: unknown, convert: (item: unknown) => T): Record<string, T> {
  const entries = Object.entries(object(value, t('推理档位映射')));
  efforts(entries.map(([key]) => key));
  if (entries.some(([key]) => unsafeKeys.has(key))) throw new Error(t('推理档位映射包含保留字段。'));
  return Object.fromEntries(entries.map(([key, item]) => [key, convert(item)]));
}
function validateApiProfile(value: unknown, apiType: ApiType): ModelApiProfile {
  const v = object(value, t('协议配置'));
  const fields = ['effortPath', 'effortValues', 'modePath', 'enabledValue', 'disabledValue', 'defaultMode', 'disabledEfforts', 'budgetPath', 'budget', 'budgetByEffort', 'supportsForcedTools', 'allowUnsignedThinking', 'toolCallMetadataPaths', 'parameters'];
  if (Object.keys(v).some(key => !fields.includes(key))) throw new Error(t('协议配置包含未知字段。'));
  const result: ModelApiProfile = {};
  if (v.effortPath !== undefined) result.effortPath = v.effortPath === null ? null : profilePath(v.effortPath);
  if (v.effortValues !== undefined) result.effortValues = effortMap(v.effortValues, value => {
    if (value === null) return null;
    return efforts([value])[0]!;
  });
  if (v.modePath !== undefined) result.modePath = profilePath(v.modePath);
  for (const field of ['enabledValue', 'disabledValue', 'defaultMode'] as const) if (v[field] !== undefined) {
    if (!result.modePath) throw new Error(t('思考模式值需要声明模式路径。'));
    result[field] = profileScalar(v[field]);
  }
  if (result.modePath && !['enabledValue', 'disabledValue', 'defaultMode'].some(key => Object.hasOwn(v, key))) throw new Error(t('思考模式路径需要声明模式值。'));
  if (v.disabledEfforts !== undefined) result.disabledEfforts = efforts(v.disabledEfforts);
  if (v.budgetPath !== undefined) result.budgetPath = profilePath(v.budgetPath);
  if ((v.budget === undefined) !== (v.budgetPath === undefined)) throw new Error(t('思考预算和预算路径必须同时声明。'));
  if (v.budget !== undefined) {
    const budget = object(v.budget, t('思考预算'));
    if (Object.keys(budget).some(key => !['min', 'max', 'default'].includes(key))) throw new Error(t('思考预算包含未知字段。'));
    result.budget = { min: positiveInt(budget.min, t('思考预算下限')), max: positiveInt(budget.max, t('思考预算上限')), default: positiveInt(budget.default, t('思考默认预算')) };
    if (result.budget.min > result.budget.default || result.budget.default > result.budget.max) throw new Error(t('思考预算默认值必须在有效范围内。'));
  }
  if (v.budgetByEffort !== undefined) {
    if (!result.budget) throw new Error(t('推理档位预算映射需要声明预算范围。'));
    const budget = result.budget;
    result.budgetByEffort = effortMap(v.budgetByEffort, value => {
      const amount = positiveInt(value, t('推理档位预算'));
      if (amount < budget.min || amount > budget.max) throw new Error(t('推理档位预算必须在声明范围内。'));
      return amount;
    });
  }
  for (const field of ['supportsForcedTools', 'allowUnsignedThinking'] as const) if (v[field] !== undefined) result[field] = bool(v[field], t('协议能力'));
  if (v.toolCallMetadataPaths !== undefined) {
    if (!Array.isArray(v.toolCallMetadataPaths) || v.toolCallMetadataPaths.length > 16) throw new Error(t('工具元数据最多支持16个路径。'));
    result.toolCallMetadataPaths = v.toolCallMetadataPaths.map(path => profilePath(path, true));
  }
  const standardEffortPath = apiType === 'chatCompletions' ? ['reasoning_effort'] : [apiType === 'responses' ? 'reasoning' : 'output_config', 'effort'];
  const paths = [result.effortPath === undefined ? standardEffortPath : result.effortPath, result.modePath, result.budgetPath].filter((path): path is string[] => Array.isArray(path));
  for (const collection of [paths, result.toolCallMetadataPaths ?? []]) {
    for (let i = 0; i < collection.length; i++) for (let j = i + 1; j < collection.length; j++) {
      const a = collection[i]!, b = collection[j]!;
      if (a.slice(0, Math.min(a.length, b.length)).every((key, offset) => key === b[offset])) throw new Error(t('协议参数路径不能相互覆盖。'));
    }
  }
  if (v.parameters !== undefined) result.parameters = profileParameters(v.parameters);
  return result;
}
export function validateReasoningControls(value: unknown): ReasoningControls {
  const v = object(value, t('思考控制'));
  const legacyTypes = apiTypes.filter(api => Object.hasOwn(v, api));
  if (Object.keys(v).some(key => !['protocols', 'note', ...(legacyTypes.length ? [...apiTypes, 'budget', 'disabledEfforts'] : [])].includes(key))) throw new Error(t('思考控制包含未知字段。'));
  const result: ReasoningControls = { note: text(v.note ?? '', t('思考控制说明'), 4000, true) };
  const protocols = v.protocols === undefined ? {} : { ...object(v.protocols, t('协议配置列表')) };
  if (Object.keys(protocols).some(key => !apiTypes.includes(key as ApiType))) throw new Error(t('协议配置类型无效。'));
  if (legacyTypes.length) {
    const legacyProfiles = require('../../resources/catalog/migrations.json').legacyProfiles as Partial<Record<ApiType, Record<string, unknown>>>;
    for (const api of legacyTypes) {
      const profiles = legacyProfiles[api], name = v[api];
      if (Object.hasOwn(protocols, api) || typeof name !== 'string' || !profiles || !Object.hasOwn(profiles, name)) throw new Error(t('旧思考控制缺少已声明的迁移配置。'));
      const profile = { ...object(profiles[name], t('思考控制迁移配置')) };
      if (v.budget !== undefined && profile.budgetPath !== undefined) profile.budget = v.budget;
      if (v.disabledEfforts !== undefined) profile.disabledEfforts = v.disabledEfforts;
      protocols[api] = profile;
    }
  }
  if (v.protocols !== undefined || legacyTypes.length) result.protocols = Object.fromEntries(Object.entries(protocols).map(([key, profile]) => [key, validateApiProfile(profile, key as ApiType)]));
  return result;
}
export function validateParameters(value: unknown): ModelParameters {
  const v = object(value, t('模型参数'));
  const result: ModelParameters = {
    name: text(v.name ?? '', t('显示名称'), 200, true),
    contextWindow: positiveInt(v.contextWindow, t('上下文窗口')),
    maxOutputTokens: positiveInt(v.maxOutputTokens, t('最大输出')),
    toolCalling: bool(v.toolCalling, t('工具调用')),
    vision: bool(v.vision, t('视觉')),
    thinking: bool(v.thinking, t('思考')),
    supportsReasoningEffort: efforts(v.supportsReasoningEffort),
    source: text(v.source ?? '', t('来源'), 4000, true),
    verifiedAt: v.verifiedAt == null ? null : text(v.verifiedAt, t('核验日期'), 10)
  };
  if (v.contextWindowMode !== undefined) {
    if (!['shared', 'input'].includes(String(v.contextWindowMode))) throw new Error(t('上下文窗口语义无效。'));
    result.contextWindowMode = v.contextWindowMode as 'shared' | 'input';
  }
  if (v.contextPricing !== undefined) result.contextPricing = validateContextPricing(v.contextPricing);
  if (v.reasoningControls !== undefined) result.reasoningControls = validateReasoningControls(v.reasoningControls);
  if (v.aliasOf !== undefined) result.aliasOf = validId(v.aliasOf, t('参数来源模型 ID'));
  if (v.chatCompletionOptions !== undefined) {
    const options = object(v.chatCompletionOptions, t('Chat Completions 参数'));
    if (!['max_tokens', 'max_completion_tokens'].includes(String(options.maxTokensField))) throw new Error(t('输出 token 字段无效。'));
    result.chatCompletionOptions = { maxTokensField: options.maxTokensField as 'max_tokens' | 'max_completion_tokens', includeUsage: bool(options.includeUsage, t('流式用量')) };
    if (options.store !== undefined) result.chatCompletionOptions.store = bool(options.store, 'store');
    if (options.maxOutputTokens !== undefined) result.chatCompletionOptions.maxOutputTokens = positiveInt(options.maxOutputTokens, t('协议输出上限'));
  }
  if (Object.hasOwn(v, 'releaseDate')) {
    if (v.releaseDate !== null && !validDate(v.releaseDate)) throw new Error(t('模型发布日期必须是有效的 YYYY-MM-DD 日期或 null。'));
    result.releaseDate = v.releaseDate as string | null;
  }
  if (v.maxInputTokens !== undefined && v.maxInputTokens !== null && v.maxInputTokens !== '') result.maxInputTokens = positiveInt(v.maxInputTokens, t('最大输入'));
  if (v.defaultOutputTokens !== undefined && v.defaultOutputTokens !== null && v.defaultOutputTokens !== '') result.defaultOutputTokens = positiveInt(v.defaultOutputTokens, t('默认输出预算'));
  if ((result.contextWindowMode !== 'input' && result.maxOutputTokens > result.contextWindow) || (result.maxInputTokens !== undefined && result.maxInputTokens > result.contextWindow)) throw new Error(t('输入或输出上限不能超过上下文窗口。'));
  if (result.contextWindowMode !== 'input' && result.maxInputTokens === undefined && result.maxOutputTokens >= result.contextWindow
    && !(result.defaultOutputTokens !== undefined && result.defaultOutputTokens < result.contextWindow)) throw new Error(t('最大输出必须小于上下文窗口，或设置较小的单次输出预算或有效输入上限。'));
  if (result.verifiedAt && !/^\d{4}-\d{2}-\d{2}$/.test(result.verifiedAt)) throw new Error(t('核验日期格式应为 YYYY-MM-DD。'));
  return result;
}
export function validateDatabase(value: unknown): ModelDatabase {
  const v = object(value, t('参数库'));
  if (v.schemaVersion !== 1) throw new Error(t('参数库版本不受支持。'));
  const entries = Object.entries(object(v.models, t('模型条目')));
  if (entries.length > 20_000) throw new Error(t('参数库最多包含 20000 个模型。'));
  return { schemaVersion: 1, defaults: validateParameters(v.defaults), models: Object.fromEntries(entries.map(([id, record]) => [validId(id), validateParameters(record)])) };
}
export function validateOverrides(value: unknown): ParameterOverrides {
  const v = object(value ?? {}, t('覆盖参数'));
  const result: ParameterOverrides = {};
  for (const key of parameterKeys) {
    if (!Object.hasOwn(v, key)) continue;
    if ((key === 'maxInputTokens' || key === 'defaultOutputTokens') && (v[key] == null || v[key] === '')) continue;
    if (key === 'contextWindow' || key === 'maxOutputTokens' || key === 'maxInputTokens' || key === 'defaultOutputTokens') result[key] = positiveInt(v[key], key);
    else if (key === 'supportsReasoningEffort') result[key] = efforts(v[key]);
    else result[key] = bool(v[key], key);
  }
  return result;
}
export function baseParameters(database: ModelDatabase, id: string): ModelParameters {
  return Object.hasOwn(database.models, id) ? database.models[id]! : database.defaults;
}
export function effectiveParameters(database: ModelDatabase, model: ModelConfig): ModelParameters {
  return validateParameters({ ...baseParameters(database, model.id), ...model.overrides });
}
export function requestParametersForApi(parameters: ModelParameters, apiType: ApiType): ModelParameters {
  const maximum = apiType === 'chatCompletions' ? parameters.chatCompletionOptions?.maxOutputTokens : undefined;
  return maximum === undefined ? parameters : { ...parameters, maxOutputTokens: Math.min(parameters.maxOutputTokens, maximum) };
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
  if (v.modelProtocols !== undefined) {
    for (const [modelId, api] of Object.entries(object(v.modelProtocols, t('模型协议分配')))) {
      validId(modelId);
      if (!apiTypes.includes(api as ApiType)) throw new Error(t('模型协议分配无效。'));
    }
  }
  const routing = normalizeRouting(v);
  for (const api of apiTypes) routing.endpoints[api] = routing.endpoints[api].trim() ? validateUrl(routing.endpoints[api]) : '';
  routing.unified.url = routing.unified.url.trim() ? validateUrl(routing.unified.url) : '';
  const models = v.models.filter(m => !excludedKind(String(object(m, t('模型')).id))).map(m => validateModel(m, database));
  const zeroDataRetentionEnabled = v.zeroDataRetentionEnabled !== undefined
    ? bool(v.zeroDataRetentionEnabled, t('零数据保留'))
    : typeof v.zdr === 'boolean' ? v.zdr : v.models.length > 0 && v.models.every(m => m.zdr === true);
  if (new Set(models.map(m => m.id)).size !== models.length) throw new Error(t('同一供应商内不能重复添加模型 ID。'));
  const provider: ProviderConfig = { id, name: text(v.name, t('供应商名称'), 200), ...routing, enabled, zeroDataRetentionEnabled, models };
  if (enabled && !discovery) {
    for (const model of models) {
      const route = routeForModel(provider, model.id, routing);
      if (!route.url) throw new Error(provider.routingMode === 'unified' ? t('请填写统一协议的 API 地址。') : t('请填写 {0} 列表使用的协议地址。', route.apiType));
    }
  }
  return provider;
}
export function sanitizeError(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : t('操作失败。');
  if (secret) message = message.split(secret).join('[REDACTED]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 2000);
}
