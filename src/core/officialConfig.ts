import { effectiveParameters, modelName } from './configuration';
import { resolveEndpoint } from './endpoints';
import type { ApiType, ModelConfig, ModelDatabase, ModelParameters, OfficialProtocol, ProviderConfig } from './types';
import { inputCeiling, projectEfforts } from '../../resources/shared/model-policy.js';
import { t } from '../../resources/shared/i18n.js';
import { normalizeRouting, routeForModel } from '../../resources/shared/routing.js';

export type { OfficialProtocol };
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

export function officialProtocol(apiType: ApiType): OfficialProtocol {
  return apiType === 'chatCompletions' ? 'chat-completions' : apiType;
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
  const parameters = effectiveParameters(database, model);
  const profile = parameters.protocols?.[route.apiType];
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
  if (route.apiType === 'messages' && parameters.thinking) {
    if (profile?.adaptiveThinking) result.adaptiveThinking = true;
    else if (profile?.thinkingBudget) {
      if (result.maxOutputTokens <= profile.thinkingBudget.min) throw new Error(t('单次输出预算必须大于该模型的最小思考预算。'));
      result.maxThinkingBudget = Math.min(profile.thinkingBudget.max, result.maxOutputTokens - 1);
      result.minThinkingBudget = profile.thinkingBudget.min;
    }
  }
  if (model.reasoningEffort && parameters.thinking && parameters.supportsReasoningEffort.includes(model.reasoningEffort)) {
    if (!Object.hasOwn(efforts.mapping, model.reasoningEffort)) throw new Error(t('模型 {0} 的推理档位 {1} 需要官方配置暂不支持的参数。请选择其他档位或恢复默认。', model.id, model.reasoningEffort));
    result.defaultReasoningEffort = efforts.mapping[model.reasoningEffort];
  }
  if (profile?.modelOptions && Object.keys(profile.modelOptions).length) {
    result.modelOptions = { ...profile.modelOptions };
  }
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
