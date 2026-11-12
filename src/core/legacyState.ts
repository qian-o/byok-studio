import { isDeepStrictEqual } from 'node:util';
import { baseParameters, effectiveParameters, object, validateDatabase, validateProvider } from './configuration';
import type { ApiType, ModelDatabase, ProtocolProfile, ProviderConfig } from './types';
import { t } from '../../resources/shared/i18n.js';
import { normalizeRouting, routeForModel } from '../../resources/shared/routing.js';

const formats = new Map<string, ProtocolProfile['effortFormat']>([
  ['reasoning_effort', 'chat-completions'], ['reasoning.effort', 'responses'], ['output_config.effort', 'messages']
]);
const overrideKeys = ['contextWindow', 'maxOutputTokens', 'toolCalling', 'vision', 'thinking', 'supportsReasoningEffort'] as const;

/** Only translate behavior the native compiler previously supported; never restore request injection. */
export function upgradeDatabase(value: unknown): ModelDatabase {
  const database = object(value);
  const parameters = (value: unknown) => {
    const raw = object(value);
    if (raw.reasoningControls === undefined) return raw;
    const controls = object(raw.reasoningControls);
    const protocols: Partial<Record<ApiType, ProtocolProfile>> = {};
    for (const [api, value] of Object.entries(object(controls.protocols ?? {}))) {
      if (!['responses', 'chatCompletions', 'messages'].includes(api)) throw new Error(t('协议配置类型无效。'));
      const old = object(value), profile: ProtocolProfile = {};
      if (old.effortPath !== undefined) {
        if (old.effortPath !== null && (!Array.isArray(old.effortPath) || old.effortPath.some(part => typeof part !== 'string' || part.includes('.')))) throw new Error(t('推理档位格式无效。'));
        profile.effortFormat = Array.isArray(old.effortPath) ? formats.get(old.effortPath.join('.')) ?? 'unsupported' : 'unsupported';
      }
      if (old.effortValues !== undefined) profile.effortValues = { ...object(old.effortValues) } as ProtocolProfile['effortValues'];
      const disabled = old.modePath === undefined ? [] : old.disabledEfforts ?? [];
      if (!Array.isArray(disabled) || disabled.some(level => typeof level !== 'string')) throw new Error(t('推理档位格式无效。'));
      const budgetLevels = Object.keys(object(old.budgetByEffort ?? {}));
      for (const level of [...disabled, ...budgetLevels]) {
        profile.effortValues ??= {};
        Object.defineProperty(profile.effortValues, level, { value: null, enumerable: true, configurable: true, writable: true });
      }
      if (api === 'messages') {
        if (Array.isArray(old.modePath) && old.modePath.join('.') === 'thinking.type' && (old.defaultMode === 'adaptive' || old.enabledValue === 'adaptive')) profile.adaptiveThinking = true;
        if (Array.isArray(old.budgetPath) && old.budgetPath.join('.') === 'thinking.budget_tokens' && old.budget !== undefined) {
          const budget = object(old.budget);
          profile.thinkingBudget = { min: budget.min as number, max: budget.max as number };
        }
      }
      if (old.parameters !== undefined) {
        const options = object(old.parameters);
        const supported = Object.entries(options).filter(([key, value]) => ['temperature', 'top_p'].includes(key)
          && (value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (key !== 'top_p' || value <= 1))));
        if (supported.length) profile.modelOptions = Object.fromEntries(supported);
      }
      if (Object.keys(profile).length) protocols[api as ApiType] = profile;
    }
    if (raw.protocols !== undefined && !isDeepStrictEqual(raw.protocols, protocols)) throw new Error(t('保存的模型协议配置无法自动转换；原始数据未修改。'));
    return { ...raw, protocols };
  };
  return validateDatabase({ ...database, defaults: parameters(database.defaults), models: Object.fromEntries(Object.entries(object(database.models)).map(([id, value]) => [id, parameters(value)])) });
}

/** Move the old editable preset values used by a provider into its supported overrides. */
export function upgradeProvider(value: unknown, previous: ModelDatabase, current: ModelDatabase, legacy: unknown): ProviderConfig {
  const provider = validateProvider(value, previous);
  const routing = normalizeRouting(provider), raw = object(legacy), records = object(raw.models);
  for (const model of provider.models) {
    const before = effectiveParameters(previous, model), base = baseParameters(current, model.id);
    const old = object(Object.hasOwn(records, model.id) ? records[model.id] : raw.defaults);
    if (routeForModel(provider, model.id, routing).apiType === 'chatCompletions' && old.chatCompletionOptions !== undefined) {
      const cap = object(old.chatCompletionOptions).maxOutputTokens;
      if (cap !== undefined) {
        if (!Number.isSafeInteger(cap) || (cap as number) < 1) throw new Error(t('保存的模型协议配置无法自动转换；原始数据未修改。'));
        before.maxOutputTokens = Math.min(before.maxOutputTokens, cap as number);
        model.overrides.maxOutputTokens = before.maxOutputTokens;
      }
    }
    for (const key of overrideKeys) {
      if (!Object.hasOwn(model.overrides, key) && before[key] !== undefined && !isDeepStrictEqual(before[key], base[key])) {
        Object.assign(model.overrides, { [key]: structuredClone(before[key]) });
      }
    }
    if (!model.name && before.name && before.name !== base.name) model.name = before.name;
    const after = effectiveParameters(current, model);
    if (!isDeepStrictEqual(before.protocols, after.protocols)) throw new Error(t('模型 {0} 的旧预设无法转换为供应商覆盖参数；原始数据未修改。', model.id));
  }
  return validateProvider(provider, current);
}
