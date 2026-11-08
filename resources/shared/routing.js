(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../catalog/rules.json') : undefined);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ByokModelVendors = api;
})(globalThis, function (initialRules) {
  'use strict';
  const apiTypes = ['responses', 'chatCompletions', 'messages'];
  const vendors = [];
  let rules = { schemaVersion: 1, fallback: 'other', vendors: [{ id: 'other', name: '其他', protocol: 'chatCompletions' }], exclusions: [], models: {} };
  let classifications = [], exclusions = [];
  function configure(value) {
    if (!value) return;
    if (value.schemaVersion !== 1 || !Array.isArray(value.vendors) || !Array.isArray(value.exclusions)
      || !value.vendors.some(item => item.id === value.fallback)) throw new Error('Invalid model routing rules.');
    const next = JSON.parse(JSON.stringify(value));
    const compiled = next.vendors.map(item => {
      if (!apiTypes.includes(item.protocol) || typeof item.id !== 'string' || typeof item.name !== 'string') throw new Error('Invalid model route.');
      return { ...item, expression: item.pattern ? new RegExp(item.pattern, 'i') : undefined };
    });
    const excluded = next.exclusions.map(item => ({ ...item, expression: new RegExp(item.pattern, 'i') }));
    rules = next; classifications = compiled; exclusions = excluded;
    vendors.splice(0, vendors.length, ...next.vendors.map(({ id, name, protocol }) => ({ id, name, protocol })));
  }
  configure(initialRules || rules);
  function modelRules() { return JSON.parse(JSON.stringify(rules)); }
  function modelLeaf(id) { return String(id).split('/').at(-1); }
  function vendorOf(id) {
    return rules.models?.[id]?.vendor || classifications.find(item => item.expression?.test(modelLeaf(id)))?.id || rules.fallback;
  }
  function excludedKind(id) {
    return rules.models?.[id]?.excludedKind || exclusions.find(item => item.expression.test(modelLeaf(id)))?.kind || null;
  }
  function defaultProtocols() { return Object.fromEntries(vendors.map(vendor => [vendor.id, vendor.protocol])); }
  function recommendedProtocol(modelId) {
    return rules.models?.[modelId]?.protocol || vendors.find(vendor => vendor.id === vendorOf(modelId))?.protocol || 'chatCompletions';
  }
  function normalizeRouting(provider) {
    const legacy = typeof provider.url === 'string' ? provider.url : '';
    const endpoints = Object.fromEntries(apiTypes.map(api => [api, typeof provider.endpoints?.[api] === 'string' ? provider.endpoints[api] : legacy]));
    const routingMode = ['unified', 'split'].includes(provider.routingMode) ? provider.routingMode : provider.endpoints ? 'split' : 'unified';
    const preferredApi = apiTypes.includes(provider.unified?.apiType) ? provider.unified.apiType
      : apiTypes.includes(provider.apiType) ? provider.apiType : endpoints.chatCompletions ? 'chatCompletions' : apiTypes.find(api => endpoints[api]) || 'chatCompletions';
    const unified = { apiType: preferredApi, url: typeof provider.unified?.url === 'string' ? provider.unified.url : legacy || endpoints[preferredApi] };
    const modelProtocols = Object.fromEntries((provider.models || []).filter(model => !excludedKind(model.id)).map(model => {
      const supplied = Object.prototype.hasOwnProperty.call(provider.modelProtocols || {}, model.id) ? provider.modelProtocols[model.id] : undefined;
      const oldGroup = provider.vendorProtocols?.[vendorOf(model.id)];
      return [model.id, apiTypes.includes(supplied) ? supplied : apiTypes.includes(oldGroup) ? oldGroup : recommendedProtocol(model.id)];
    }));
    return { routingMode, unified, endpoints, modelProtocols };
  }
  function routeForModel(provider, modelId, routing = normalizeRouting(provider)) {
    if (routing.routingMode === 'unified') return { ...routing.unified, zeroDataRetentionEnabled: provider.zeroDataRetentionEnabled === true };
    const apiType = routing.modelProtocols[modelId] || recommendedProtocol(modelId);
    return { apiType, url: routing.endpoints[apiType], zeroDataRetentionEnabled: provider.zeroDataRetentionEnabled === true };
  }
  function protocolLists(provider) {
    const routing = normalizeRouting(provider);
    return apiTypes.map(apiType => ({ apiType, models: (provider.models || []).filter(model => !excludedKind(model.id) && routing.modelProtocols[model.id] === apiType) }));
  }
  function assignModels(provider, ids, apiType) {
    if (!apiTypes.includes(apiType)) throw new Error('Unsupported protocol.');
    const modelProtocols = normalizeRouting(provider).modelProtocols;
    const selected = new Set(ids);
    for (const model of provider.models || []) if (selected.has(model.id) && !excludedKind(model.id)) modelProtocols[model.id] = apiType;
    return modelProtocols;
  }
  function groups(models) { return vendors.map(vendor => ({ ...vendor, models: models.filter(model => vendorOf(model.id) === vendor.id && !excludedKind(model.id)) })).filter(group => group.models.length); }
  function replaceModels(previous, discovered) {
    const existing = new Map(previous.map(model => [model.id, model]));
    const seen = new Set();
    const result = [];
    for (const model of discovered) {
      if (seen.has(model.id) || excludedKind(model.id)) continue;
      seen.add(model.id);
      const retained = existing.get(model.id);
      result.push(retained ? { ...retained, discoveredName: (model.name || model.id).slice(0, 200) } : { id: model.id, name: '', discoveredName: (model.name || model.id).slice(0, 200), overrides: {} });
    }
    return result;
  }
  return { apiTypes, vendors, configure, modelRules, vendorOf, excludedKind, defaultProtocols, recommendedProtocol, normalizeRouting, routeForModel, protocolLists, assignModels, groups, replaceModels };
});
