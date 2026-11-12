(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ByokRouting = api;
})(globalThis, function () {
  'use strict';

  const apiTypes = ['responses', 'chatCompletions', 'messages'];
  const lowerIndexCache = new WeakMap();

  const EXCLUSION_PATTERNS = [
    /^(?:sora|veo|kling|seedance|wan(?:\d|[-.])|grok-imagine-video|doubao-(?:seedance|video))(?:[-.\d]|$)/i,
    /^(?:gpt-image|dall-e|imagen|seedream|grok-imagine(?:-image)?|doubao-(?:seedream|image))(?:[-.\d]|$)/i,
    /^gemini.*(?:-image(?:[-.]|$)|-imagegen(?:[-.]|$))/i,
    /^(?:text-embedding|embedding|whisper|tts|gpt.*-(?:audio|realtime|transcribe|tts))(?:[-.]|$)/i
  ];
  const RESPONSES_PATTERN = /^(?:gpt[-.]|chatgpt[-.]|codex(?:[-.]|$)|o[134](?:[-.]|$))/i;
  const MESSAGES_PATTERN = /^claude(?:[-.]|$)/i;

  function modelLeaf(id) {
    return String(id).split('/').at(-1) || '';
  }

  function isExcludedModel(id) {
    const leaf = modelLeaf(id);
    return EXCLUSION_PATTERNS.some(pattern => pattern.test(leaf));
  }

  function recommendedProtocol(modelId) {
    const leaf = modelLeaf(modelId);
    if (RESPONSES_PATTERN.test(leaf)) return 'responses';
    if (MESSAGES_PATTERN.test(leaf)) return 'messages';
    return 'chatCompletions';
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function getLowerIndex(models) {
    let map = lowerIndexCache.get(models);
    if (!map) {
      map = new Map();
      for (const key of Object.keys(models)) {
        const lower = key.toLowerCase();
        if (!map.has(lower)) map.set(lower, models[key]);
      }
      lowerIndexCache.set(models, map);
    }
    return map;
  }

  function lookupPreset(database, id) {
    const models = database.models;
    if (Object.hasOwn(models, id)) return models[id];
    const lowerMap = getLowerIndex(models);
    const byLower = lowerMap.get(String(id).toLowerCase());
    if (byLower) return byLower;
    const leaf = modelLeaf(id);
    if (leaf && leaf !== id) {
      if (Object.hasOwn(models, leaf)) return models[leaf];
      const byLeafLower = lowerMap.get(leaf.toLowerCase());
      if (byLeafLower) return byLeafLower;
    }
    return database.defaults;
  }

  function defaultEfforts(preset, apiType) {
    const profile = apiType ? preset.protocols?.[apiType] : undefined;
    if (profile?.effortFormat === 'unsupported') return [];
    return [...(preset.supportsReasoningEffort || [])];
  }

  function baseParametersForProtocol(database, id, apiType) {
    const preset = lookupPreset(database, id);
    return {
      ...preset,
      supportsReasoningEffort: defaultEfforts(preset, apiType)
    };
  }

  function displayModelName(database, model) {
    if (model.name) return model.name;
    const preset = lookupPreset(database, model.id);
    return preset.name || model.id;
  }

  function normalizeRouting(provider) {
    const legacyUrl = typeof provider?.url === 'string' ? provider.url : '';
    const endpoints = Object.fromEntries(apiTypes.map(api => [
      api,
      typeof provider?.endpoints?.[api] === 'string' ? provider.endpoints[api] : legacyUrl
    ]));
    const routingMode = provider?.routingMode === 'split' || provider?.routingMode === 'unified'
      ? provider.routingMode
      : provider?.endpoints ? 'split' : 'unified';
    const preferredApi = apiTypes.includes(provider?.unified?.apiType)
      ? provider.unified.apiType
      : apiTypes.includes(provider?.apiType) ? provider.apiType : 'chatCompletions';
    const unified = {
      apiType: preferredApi,
      url: typeof provider?.unified?.url === 'string' ? provider.unified.url : (legacyUrl || endpoints[preferredApi])
    };
    const modelProtocols = Object.fromEntries(
      (provider?.models || [])
        .filter(model => model && !isExcludedModel(model.id))
        .map(model => {
          const supplied = Object.hasOwn(provider?.modelProtocols || {}, model.id) ? provider.modelProtocols[model.id] : undefined;
          return [model.id, apiTypes.includes(supplied) ? supplied : recommendedProtocol(model.id)];
        })
    );
    return { routingMode, unified, endpoints, modelProtocols };
  }

  function routeForModel(provider, modelId, routing = normalizeRouting(provider)) {
    if (routing.routingMode === 'unified') return { ...routing.unified };
    const apiType = Object.hasOwn(routing.modelProtocols, modelId) ? routing.modelProtocols[modelId] : recommendedProtocol(modelId);
    return { apiType, url: routing.endpoints[apiType] };
  }

  function protocolLists(provider) {
    const routing = normalizeRouting(provider);
    return apiTypes.map(apiType => ({
      apiType,
      models: (provider.models || []).filter(model => !isExcludedModel(model.id) && routeForModel(provider, model.id, routing).apiType === apiType)
    }));
  }

  function assignModels(provider, ids, apiType) {
    if (!apiTypes.includes(apiType)) throw new Error('Unsupported protocol.');
    const modelProtocols = normalizeRouting(provider).modelProtocols;
    const selected = new Set(ids);
    for (const model of provider.models || []) {
      if (selected.has(model.id) && !isExcludedModel(model.id)) modelProtocols[model.id] = apiType;
    }
    return modelProtocols;
  }

  function replaceModels(previous, discovered) {
    const existing = new Map(previous.map(model => [model.id, model]));
    const seen = new Set();
    const result = [];
    for (const model of discovered) {
      if (seen.has(model.id) || isExcludedModel(model.id)) continue;
      seen.add(model.id);
      const retained = existing.get(model.id);
      result.push(retained
        ? { id: retained.id, name: retained.name || '', overrides: { ...retained.overrides }, ...(retained.reasoningEffort ? { reasoningEffort: retained.reasoningEffort } : {}) }
        : { id: model.id, name: '', overrides: {} });
    }
    return result;
  }

  return {
    apiTypes,
    isExcludedModel,
    recommendedProtocol,
    validDate,
    lookupPreset,
    defaultEfforts,
    baseParametersForProtocol,
    displayModelName,
    normalizeRouting,
    routeForModel,
    protocolLists,
    assignModels,
    replaceModels
  };
});
