(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ByokOfficialEffort = api;
})(globalThis, function () {
  'use strict';
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
  return { projectEfforts };
});
