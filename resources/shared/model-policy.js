(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ByokModelPolicy = api;
})(globalThis, function () {
  'use strict';
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function projectEfforts(parameters, apiType) {
    const profile = parameters.protocols?.[apiType];
    const defaultFormat = apiType === 'chatCompletions' ? 'chat-completions' : apiType;
    const format = profile?.effortFormat === undefined ? defaultFormat : profile.effortFormat === 'unsupported' ? undefined : profile.effortFormat;
    const levels = [], nativeLevels = [], mapping = Object.create(null), rejected = [];
    if (!parameters.thinking) return { levels, nativeLevels, mapping, rejected, format };
    for (const level of parameters.supportsReasoningEffort || []) {
      const mapped = profile?.effortValues && Object.hasOwn(profile.effortValues, level) ? profile.effortValues[level] : level;
      const field = !format ? 'effortFormat' : mapped === null ? 'effortValues' : undefined;
      if (field) { rejected.push({ level, field }); continue; }
      levels.push(level);
      mapping[level] = mapped;
      if (!nativeLevels.includes(mapped)) nativeLevels.push(mapped);
    }
    return { levels, nativeLevels, mapping, rejected, format };
  }

  return { validDate, projectEfforts };
});
