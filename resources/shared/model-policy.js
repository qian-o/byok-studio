(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./i18n.js') : root.ByokI18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ByokModelPolicy = api;
})(globalThis, function (i18n) {
  'use strict';
  const { t } = i18n;
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function releaseDate(model, records) {
    const value = Object.prototype.hasOwnProperty.call(records, model.id) ? records[model.id].releaseDate : undefined;
    return validDate(value) ? value : null;
  }

  function inputCeiling(parameters) {
    return parameters.maxInputTokens === undefined ? Math.max(1, parameters.contextWindow - (parameters.contextWindowMode === 'input' ? 0 : 1)) : parameters.maxInputTokens;
  }
  function pricingNote(parameters) {
    const pricing = parameters.contextPricing;
    if (!pricing || pricing.kind === 'unknown') return t('上下文计费阈值未核实；使用完整上下文，可按服务商资料维护。');
    const scope = pricing.scope === 'copilot' ? t('Copilot 参考') : pricing.scope === 'custom' ? t('自定义渠道') : t('原厂直连 API');
    const base = pricing.kind === 'tiered' ? t('超过输入阈值可能提高整次请求的费率。') : t('未按输入长度分段加价。');
    return t('{0}：{1}', scope, pricing.note || base) + (pricing.scope !== 'custom' ? t(' 代理计费以供应商实际规则为准。') : '');
  }
  const formats = { '["reasoning_effort"]': 'chat-completions', '["reasoning","effort"]': 'responses', '["output_config","effort"]': 'messages' };
  function projectEfforts(parameters, apiType) {
    const profile = parameters.reasoningControls?.protocols?.[apiType];
    const defaultFormat = apiType === 'chatCompletions' ? 'chat-completions' : apiType;
    const format = profile?.effortPath === undefined ? defaultFormat : Array.isArray(profile.effortPath) ? formats[JSON.stringify(profile.effortPath)] : undefined;
    const levels = [], nativeLevels = [], mapping = Object.create(null), rejected = [];
    if (!parameters.thinking) return { levels, nativeLevels, mapping, rejected, format };
    for (const level of parameters.supportsReasoningEffort || []) {
      const mapped = profile?.effortValues && Object.hasOwn(profile.effortValues, level) ? profile.effortValues[level] : level;
      const field = !format ? 'effortPath' : profile?.modePath && profile.disabledEfforts?.includes(level) ? 'disabledEfforts' : mapped === null ? 'effortValues' : profile?.budgetByEffort && Object.hasOwn(profile.budgetByEffort, level) ? 'budgetByEffort' : undefined;
      if (field) { rejected.push({ level, field }); continue; }
      levels.push(level);
      mapping[level] = mapped;
      if (!nativeLevels.includes(mapped)) nativeLevels.push(mapped);
    }
    return { levels, nativeLevels, mapping, rejected, format };
  }
  return { validDate, releaseDate, inputCeiling, pricingNote, projectEfforts };
});
