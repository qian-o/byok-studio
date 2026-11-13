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
    /^(?:gpt-image|dall-e|imagen|seedream|flux|stable-diffusion|midjourney|grok-imagine(?:-image)?|doubao-(?:seedream|image))(?:[-.\d]|$)/i,
    /^gemini.*(?:-image(?:[-.]|$)|-imagegen(?:[-.]|$))/i,
    /(?:^|[-._])(?:text-embedding|embedding|embeddings|embed|rerank|reranker|whisper|tts|speech|transcribe|transcription|moderation|realtime|live-translate)(?:[-._\d]|$)/i,
    /^gpt.*-(?:audio|realtime|transcribe|tts)(?:[-.]|$)/i
  ];
  const RESPONSES_PATTERN = /^(?:gpt[-.]|chatgpt[-.]|codex(?:[-.]|$)|o[134](?:[-.]|$))/i;
  const MESSAGES_PATTERN = /^claude(?:[-.]|$)/i;
  const VENDOR_SLUG_PREFIX = /^(?:(?:us|eu|ap|au|jp|in|global)[.-])?(?:doubao|openai|anthropic|google|xai|zai|zhipuai?|moonshotai?|deepseek|meta|mistral|alibaba)[.-]/;

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

  function mergeVersionParts(parts) {
    const merged = [];
    for (let i = 0; i < parts.length; i++) {
      const prev = parts[i - 1] || '';
      const next = parts[i + 2] || '';
      if (
        /^\d$/.test(parts[i])
        && i + 1 < parts.length
        && /^\d$/.test(parts[i + 1])
        && !/^\d+$/.test(prev)
        && !/^(?:\d{1,2}|(?:19|20)\d{2})$/.test(next)
      ) {
        merged.push(`${parts[i]}.${parts[i + 1]}`);
        i++;
      } else {
        merged.push(parts[i]);
      }
    }
    return merged;
  }

  function normalizeModelSlug(value) {
    const base = String(value || '').toLowerCase().replace(/[:@].*$/, '');
    const parts = base.split(/[-_\s]+/).filter(Boolean);
    return parts.length ? mergeVersionParts(parts).join('-') : base;
  }

  function getLookupIndex(models) {
    let index = lowerIndexCache.get(models);
    if (!index) {
      const lower = new Map();
      const slug = new Map();
      for (const key of Object.keys(models)) {
        const record = models[key];
        const lowerKey = key.toLowerCase();
        if (!lower.has(lowerKey)) lower.set(lowerKey, record);
        const leafKey = modelLeaf(key);
        const normKey = normalizeModelSlug(leafKey || key);
        if (normKey && !slug.has(normKey)) slug.set(normKey, record);
      }
      index = { lower, slug };
      lowerIndexCache.set(models, index);
    }
    return index;
  }

  function lookupPreset(database, id) {
    const models = database.models;
    if (Object.hasOwn(models, id)) return models[id];
    const raw = String(id || '');
    const { lower, slug } = getLookupIndex(models);
    const byLower = lower.get(raw.toLowerCase());
    if (byLower) return byLower;

    const leaf = modelLeaf(raw);
    if (leaf && leaf !== raw) {
      if (Object.hasOwn(models, leaf)) return models[leaf];
      const byLeafLower = lower.get(leaf.toLowerCase());
      if (byLeafLower) return byLeafLower;
    }

    const strippedLeaf = (leaf || raw).replace(/[:@].*$/, '');
    if (strippedLeaf && strippedLeaf !== leaf) {
      const byStripped = lower.get(strippedLeaf.toLowerCase());
      if (byStripped) return byStripped;
    }

    const norm = normalizeModelSlug(leaf || raw);
    if (norm) {
      const bySlug = slug.get(norm);
      if (bySlug) return bySlug;
      const withoutVendor = norm.replace(VENDOR_SLUG_PREFIX, '');
      if (withoutVendor && withoutVendor !== norm) {
        const byVendorStripped = slug.get(withoutVendor);
        if (byVendorStripped) return byVendorStripped;
      }
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

  const BRAND_WORDS = {
    gpt: 'GPT',
    chatgpt: 'ChatGPT',
    glm: 'GLM',
    chatglm: 'ChatGLM',
    deepseek: 'DeepSeek',
    qwq: 'QwQ',
    qvq: 'QVQ',
    ernie: 'ERNIE',
    minimax: 'MiniMax',
    codellama: 'CodeLlama',
    vl: 'VL',
    moe: 'MoE'
  };

  function formatToken(token) {
    const lower = token.toLowerCase();
    if (Object.hasOwn(BRAND_WORDS, lower)) return BRAND_WORDS[lower];
    if (token !== lower) return token.charAt(0).toUpperCase() + token.slice(1);
    if (/^(?:a\d+[bkm]|\d+v|(?:fp|int|bf)\d+)$/.test(lower)) return lower.toUpperCase();
    if (/^(?:\d+(?:\.\d+)?|\d+x\d+)[bkm]$/.test(lower)) {
      return lower.slice(0, -1) + lower.slice(-1).toUpperCase();
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  function formatModelName(id) {
    const raw = String(id || '').trim();
    const leaf = modelLeaf(raw) || raw;
    const parts = leaf.split(/[-_\s]+/).filter(Boolean);
    if (!parts.length) return raw.slice(0, 200);
    const formatted = mergeVersionParts(parts).map(formatToken).join(' ').slice(0, 200).trim();
    return formatted || raw.slice(0, 200);
  }

  function displayModelName(database, model) {
    if (model.name) return model.name;
    const preset = lookupPreset(database, model.id);
    return preset.name || formatModelName(model.id);
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
    formatModelName,
    displayModelName,
    normalizeRouting,
    routeForModel,
    protocolLists,
    assignModels,
    replaceModels
  };
});
