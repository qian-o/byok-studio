import { effectiveParameters, modelName, requestParametersForApi } from './configuration';
import { resolveEndpoint } from './endpoints';
import type { ApiType, ModelConfig, ModelDatabase, ModelParameters, ProviderConfig } from './types';
import { inputCeiling } from '../../media/context-policy.js';
import { t } from '../../media/i18n.js';
import { normalizeRouting, routeForModel } from '../../media/model-vendors.js';
import { projectEfforts } from '../../media/official-effort.js';

export type OfficialProtocol = 'chat-completions' | 'responses' | 'messages';
export interface OfficialModel {
  id: string;
  name: string;
  url: string;
  apiType: OfficialProtocol;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking?: true;
  adaptiveThinking?: boolean;
  minThinkingBudget?: number;
  maxThinkingBudget?: number;
  zeroDataRetentionEnabled?: boolean;
  statefulResponses?: false;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: OfficialProtocol;
  defaultReasoningEffort?: string;
  modelOptions?: { temperature?: number | null; top_p?: number | null };
}
export interface OfficialGroup {
  name: string;
  vendor: 'customendpoint';
  byokStudioId: string;
  models: OfficialModel[];
}
export interface UnsupportedOfficialField {
  modelId: string;
  apiType: OfficialProtocol;
  field: string;
}

export function officialProtocol(apiType: ApiType): OfficialProtocol {
  return apiType === 'chatCompletions' ? 'chat-completions' : apiType;
}

function validModelOption(key: string, value: unknown): value is number | null {
  return (key === 'temperature' || key === 'top_p') && (value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (key !== 'top_p' || value <= 1)));
}

function tokenBudgets(parameters: ModelParameters): { maxInputTokens: number; maxOutputTokens: number } {
  const shared = parameters.contextWindowMode !== 'input';
  if (shared && parameters.contextWindow < 2) throw new Error(t('共享上下文窗口必须至少容纳一个输入 token 和一个输出 token。'));
  const outputReservation = parameters.defaultOutputTokens ?? (!shared || parameters.maxOutputTokens < parameters.contextWindow
    ? parameters.maxOutputTokens : Math.min(16384, Math.floor(parameters.contextWindow / 4)));
  const maxOutputTokens = Math.max(1, Math.min(outputReservation, parameters.maxOutputTokens, shared ? parameters.contextWindow - 1 : Infinity));
  const maxInputTokens = Math.max(1, Math.min(inputCeiling(parameters), shared ? parameters.contextWindow - maxOutputTokens : Infinity));
  return { maxInputTokens, maxOutputTokens };
}

export function compileOfficialModel(provider: ProviderConfig, database: ModelDatabase, model: ModelConfig, routing = normalizeRouting(provider)): OfficialModel {
  const route = routeForModel(provider, model.id, routing);
  const apiType = officialProtocol(route.apiType);
  const parameters = requestParametersForApi(effectiveParameters(database, model), route.apiType);
  const profile = parameters.reasoningControls?.protocols?.[route.apiType];
  const result: OfficialModel = {
    id: model.id,
    name: modelName(database, model),
    url: resolveEndpoint(route.url, route.apiType, 'chat'),
    apiType,
    toolCalling: parameters.toolCalling,
    vision: parameters.vision,
    ...tokenBudgets(parameters)
  };
  if (parameters.thinking) result.thinking = true;
  const efforts = projectEfforts(parameters, route.apiType);
  if (efforts.nativeLevels.length) {
    result.supportsReasoningEffort = efforts.nativeLevels;
    if (efforts.format !== apiType) result.reasoningEffortFormat = efforts.format;
  }
  if (route.apiType === 'responses') {
    // Explicit false keeps the existing store=true behavior; omission delegates storage to the server.
    result.zeroDataRetentionEnabled = route.zeroDataRetentionEnabled;
    if (!route.zeroDataRetentionEnabled) result.statefulResponses = false;
  }
  if (route.apiType === 'messages' && parameters.thinking) {
    if (profile?.modePath?.join('.') === 'thinking.type' && (profile.defaultMode === 'adaptive' || profile.enabledValue === 'adaptive')) result.adaptiveThinking = true;
    if (!result.adaptiveThinking && profile?.budgetPath?.join('.') === 'thinking.budget_tokens' && profile?.budget) {
      if (result.maxOutputTokens <= profile.budget.min) throw new Error(t('单次输出预算必须大于该模型的最小思考预算。'));
      result.maxThinkingBudget = Math.min(profile.budget.max, result.maxOutputTokens - 1);
      result.minThinkingBudget = profile.budget.min;
    }
  }
  if (model.reasoningEffort && parameters.thinking && parameters.supportsReasoningEffort.includes(model.reasoningEffort)) {
    if (!Object.hasOwn(efforts.mapping, model.reasoningEffort)) throw new Error(t('模型 {0} 的推理档位 {1} 需要官方配置暂不支持的参数。请选择其他档位或恢复默认。', model.id, model.reasoningEffort));
    result.defaultReasoningEffort = efforts.mapping[model.reasoningEffort];
  }
  const options: NonNullable<OfficialModel['modelOptions']> = {};
  for (const [key, value] of Object.entries(profile?.parameters ?? {})) {
    if ((key === 'temperature' || key === 'top_p') && validModelOption(key, value)) options[key] = value;
  }
  if (Object.keys(options).length) result.modelOptions = options;
  return result;
}

/** Credentials are attached by the manager after compilation. */
export function compileOfficialGroup(provider: ProviderConfig, database: ModelDatabase): OfficialGroup {
  const routing = normalizeRouting(provider);
  const models = provider.models.map(model => compileOfficialModel(provider, database, model, routing));
  return {
    name: provider.name,
    vendor: 'customendpoint',
    byokStudioId: provider.id,
    models
  };
}

/** Additional request fields have no native whole-body injection equivalent. */
export function unsupportedFields(provider: ProviderConfig, database: ModelDatabase): UnsupportedOfficialField[] {
  const routing = normalizeRouting(provider);
  return provider.models.flatMap(model => {
    const route = routeForModel(provider, model.id, routing);
    const parameters = effectiveParameters(database, model);
    const profile = parameters.reasoningControls?.protocols?.[route.apiType];
    const fields = Object.entries(profile?.parameters ?? {}).filter(([key, value]) => !validModelOption(key, value)).map(([key]) => `parameters.${key}`);
    for (const rejected of projectEfforts(parameters, route.apiType).rejected) fields.push(rejected.field);
    if (profile?.modePath && (route.apiType !== 'messages' || profile.modePath.join('.') !== 'thinking.type')) fields.push('modePath');
    for (const field of ['allowUnsignedThinking', 'supportsForcedTools', 'toolCallMetadataPaths'] as const) if (profile?.[field] !== undefined) fields.push(field);
    return [...new Set(fields)].map(field => ({ modelId: model.id, apiType: officialProtocol(route.apiType), field: `reasoningControls.protocols.${route.apiType}.${field}` }));
  });
}
