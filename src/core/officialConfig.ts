import { effectiveParameters, modelName } from './configuration';
import { resolveEndpoint } from './endpoints';
import type { ApiType, ModelConfig, ModelDatabase, OfficialProtocol, ProviderConfig } from './types';
import { projectEfforts } from '../../resources/shared/model-policy.js';
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
  contextWindow: number;
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
    contextWindow: parameters.contextWindow,
    maxOutputTokens: parameters.maxOutputTokens
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
      if (result.maxOutputTokens <= profile.thinkingBudget.min) throw new Error(t('Output 必须大于该模型的最小思考预算。'));
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
