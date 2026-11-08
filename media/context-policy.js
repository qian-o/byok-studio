(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./i18n.js') : root.ByokI18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ByokContextPolicy = api;
})(globalThis, function (i18n) {
  'use strict';
  const { t } = i18n;
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
  return { inputCeiling, pricingNote };
});
