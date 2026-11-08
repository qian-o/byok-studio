require('../resources/shared/i18n').setLocale('zh-CN');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { compileOfficialGroup, compileOfficialModel, officialProtocol, unsupportedFields } = require('../dist/core/officialConfig');
const { effectiveParameters, requestParametersForApi } = require('../dist/core/configuration');
const { inputCeiling } = require('../resources/shared/model-policy');
const { projectEfforts } = require('../resources/shared/model-policy');
const catalog = require('../resources/catalog/models.json');

const protocols = ['chatCompletions', 'responses', 'messages'];
const nativeProtocols = ['chat-completions', 'responses', 'messages'];
const defaults = { name: '', contextWindow: 128000, maxOutputTokens: 16000, toolCalling: false, vision: false,
  thinking: false, supportsReasoningEffort: [], source: 'test', verifiedAt: null };
const model = (id = 'sample', extra = {}) => ({ id, name: '', discoveredName: 'Untrusted discovery name', overrides: {}, ...extra });
const database = (parameters = {}) => ({ schemaVersion: 1, defaults: { ...defaults }, models: { sample: { ...defaults, ...parameters } } });
const provider = (apiType = 'responses', models = [model()], extra = {}) => ({ id: 'supplier-id', name: 'My supplier',
  routingMode: 'unified', unified: { apiType, url: 'https://gateway.example/v1' },
  endpoints: { chatCompletions: 'https://chat.example/root', responses: 'https://responses.example/api/v2', messages: 'https://messages.example/v1/messages' },
  modelProtocols: {}, enabled: true, zeroDataRetentionEnabled: false, models, ...extra });
const compile = (parameters = {}, item = model(), apiType = 'responses') => compileOfficialModel(provider(apiType, [item]), database(parameters), item);

// Portable subset of the native Custom Endpoint schema; no editor installation is needed.
const string = { type: 'string' }, boolean = { type: 'boolean' }, number = { type: 'number' };
const protocolSchema = { type: 'string', enum: nativeProtocols };
const modelSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: string, name: string, url: { type: 'string', pattern: '^https?://.+' }, apiType: protocolSchema,
    toolCalling: boolean, vision: boolean, maxInputTokens: number, maxOutputTokens: number, contextWindow: number,
    thinking: boolean, adaptiveThinking: boolean, minThinkingBudget: { type: 'integer', minimum: 1 },
    maxThinkingBudget: { type: 'integer', minimum: 1 }, streaming: boolean, zeroDataRetentionEnabled: boolean,
    statefulResponses: boolean, supportsReasoningEffort: { type: 'array', items: string }, reasoningEffortFormat: protocolSchema,
    defaultReasoningEffort: string,
    requestHeaders: { type: 'object', additionalProperties: string },
    modelOptions: { type: 'object', additionalProperties: false, properties: {
      temperature: { type: ['number', 'null'], minimum: 0 }, top_p: { type: ['number', 'null'], minimum: 0, maximum: 1 }
    } }
  },
  required: ['id', 'name', 'url', 'toolCalling', 'vision', 'maxOutputTokens'],
  anyOf: [{ required: ['maxInputTokens'] }, { required: ['contextWindow'] }]
};
const groupSchema = { type: 'object', additionalProperties: false, required: ['name', 'vendor', 'byokStudioId', 'models'],
  properties: { name: string, vendor: { type: 'string', enum: ['customendpoint'] }, byokStudioId: string,
    models: { type: 'array', items: modelSchema } } };
function validateSchema(value, schema, path = '$') {
  const types = [].concat(schema.type ?? []);
  if (types.length) assert.ok(types.some(type => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value)
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type), `${path}: type`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path}: enum`);
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path}: finite`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path}: minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path}: maximum`);
  }
  if (typeof value === 'string' && schema.pattern) assert.match(value, new RegExp(schema.pattern), path);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key}: required`);
    if (schema.anyOf) assert.ok(schema.anyOf.some(option => { try { validateSchema(value, option, path); return true; } catch { return false; } }), `${path}: anyOf`);
    for (const [key, item] of Object.entries(value)) {
      const fieldSchema = schema.properties?.[key];
      if (fieldSchema) validateSchema(item, fieldSchema, `${path}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${path}.${key}: unknown field`);
      else if (typeof schema.additionalProperties === 'object') validateSchema(item, schema.additionalProperties, `${path}.${key}`);
    }
  }
}

function allCatalogGroups() {
  return protocols.map(apiType => compileOfficialGroup(provider(apiType, [...Object.keys(catalog.models), 'unknown-fallback-model'].map(id => model(id))), catalog));
}

test('all catalog entries and fallback compile for every native protocol with valid budgets', () => {
  for (const [index, group] of allCatalogGroups().entries()) {
    validateSchema(group, groupSchema);
    assert.equal(group.models.length, Object.keys(catalog.models).length + 1);
    assert.equal(Object.hasOwn(group, 'apiType'), false);
    for (const native of group.models) {
      const params = requestParametersForApi(effectiveParameters(catalog, model(native.id)), protocols[index]);
      assert.equal(native.apiType, nativeProtocols[index]);
      assert.equal(Object.hasOwn(native, 'reasoningEffortFormat'), false);
      assert.equal(Object.hasOwn(native, 'streaming'), false);
      assert.equal(native.thinking ?? false, params.thinking);
      assert.deepEqual(native.supportsReasoningEffort ?? [], projectEfforts(params, protocols[index]).nativeLevels);
      assert.ok(Number.isInteger(native.maxInputTokens) && native.maxInputTokens > 0, native.id);
      assert.ok(Number.isInteger(native.maxOutputTokens) && native.maxOutputTokens > 0, native.id);
      assert.ok(native.maxInputTokens <= inputCeiling(params), native.id);
      assert.equal(native.maxInputTokens, Math.min(inputCeiling(params), params.contextWindowMode === 'input' ? Infinity : params.contextWindow - native.maxOutputTokens), native.id);
      assert.ok(native.maxOutputTokens <= params.maxOutputTokens, native.id);
      if (params.contextWindowMode !== 'input') assert.ok(native.maxInputTokens + native.maxOutputTokens <= params.contextWindow, native.id);
      assert.equal(Object.hasOwn(native, 'contextWindow'), false);
    }
  }
});

const nativePackagePath = 'D:\\Program Files\\Microsoft VS Code\\c4453f8ea4\\resources\\app\\extensions\\copilot\\package.json';
test('compiled catalog also satisfies the installed official schema when available', { skip: !fs.existsSync(nativePackagePath) }, () => {
  const manifest = JSON.parse(fs.readFileSync(nativePackagePath, 'utf8'));
  const schema = manifest.contributes.languageModelChatProviders.find(item => item.vendor === 'customendpoint').configuration;
  for (const group of allCatalogGroups()) validateSchema(group, schema);
});

test('compilation preserves model order, ownership, names and unknown raw IDs without mutating inputs', () => {
  const db = database({ name: 'Catalog title', toolCalling: true, thinking: true, supportsReasoningEffort: ['low', 'high'] });
  const supplier = provider('responses', [model('unknown'), model('sample', { name: 'User title' }), model('sample-copy')]);
  const before = structuredClone({ supplier, db });
  const group = compileOfficialGroup(supplier, db);
  assert.deepEqual(group.models.map(item => item.id), supplier.models.map(item => item.id));
  assert.deepEqual(group.models.map(item => item.name), ['unknown', 'User title', 'sample-copy']);
  assert.equal(group.name, supplier.name);
  assert.equal(group.byokStudioId, supplier.id);
  assert.equal(group.vendor, 'customendpoint');
  assert.equal(compileOfficialModel(supplier, db, model()).name, 'Catalog title');
  group.models[1].supportsReasoningEffort.push('mutated');
  assert.deepEqual({ supplier, db }, before);
});

test('disabled and empty providers are compiled without making manager filtering decisions', () => {
  assert.equal(compileOfficialGroup(provider('messages', [model()], { enabled: false }), database()).models.length, 1);
  const empty = compileOfficialGroup(provider('messages', []), database());
  assert.deepEqual(empty.models, []);
  assert.equal(Object.hasOwn(empty, 'apiType'), false);
});

test('unified routes override model preferences and split routes retain per-model URLs and protocols', () => {
  const models = protocols.map((api, index) => model(`generic-${index}`));
  const modelProtocols = Object.fromEntries(models.map((item, index) => [item.id, protocols[index]]));
  const supplier = provider('messages', models, { modelProtocols });
  assert.ok(compileOfficialGroup(supplier, database()).models.every(item => item.apiType === 'messages' && item.url === 'https://gateway.example/v1/messages'));
  const split = compileOfficialGroup({ ...supplier, routingMode: 'split' }, database());
  assert.deepEqual(split.models.map(item => item.apiType), nativeProtocols);
  assert.deepEqual(split.models.map(item => item.url), ['https://chat.example/root/v1/chat/completions', 'https://responses.example/api/v2/responses', 'https://messages.example/v1/messages']);
  protocols.forEach((api, index) => assert.equal(officialProtocol(api), nativeProtocols[index]));
});

test('generic endpoint normalization accepts roots, prefixes, versions and full operation paths', () => {
  const paths = [['', '/v1'], ['/proxy', '/proxy/v1'], ['/proxy/v3', '/proxy/v3'], ['/proxy/v1/chat/completions/', '/proxy/v1'],
    ['/proxy/v1/responses', '/proxy/v1'], ['/proxy/v1/messages', '/proxy/v1'], ['/proxy/v1/models', '/proxy/v1']];
  const suffixes = ['chat/completions', 'responses', 'messages'];
  for (const [input, root] of paths) for (const [index, apiType] of protocols.entries()) {
    const supplier = provider(apiType, [model()], { unified: { apiType, url: `https://gateway.example${input}` } });
    assert.equal(compileOfficialGroup(supplier, database()).models[0].url, `https://gateway.example${root}/${suffixes[index]}`);
  }
});

test('output reservations, overrides and explicit input limits form the native configured total', () => {
  assert.deepEqual([compile().maxInputTokens, compile().maxOutputTokens], [112000, 16000]);
  let native = compile({ contextWindow: 100000, maxInputTokens: 90000, maxOutputTokens: 80000, defaultOutputTokens: 10000 },
    model('sample', { contextSize: 95000, overrides: { defaultOutputTokens: 20000, vision: true, toolCalling: true } }));
  assert.equal(native.maxInputTokens, 80000);
  assert.equal(native.maxOutputTokens, 20000);
  assert.equal(native.vision, true);
  assert.equal(native.toolCalling, true);
  native = compile({ contextWindow: 100000, maxOutputTokens: 80000, defaultOutputTokens: 10000 }, model('sample', { contextSize: 50000 }));
  assert.equal(native.maxInputTokens + native.maxOutputTokens, 100000);
  assert.equal(Object.hasOwn(native, 'contextWindow'), false);
  native = compile({ defaultOutputTokens: 1000000 });
  assert.equal(native.maxOutputTokens, 16000);
});

test('equal physical input/output windows reserve a conservative positive output budget', () => {
  for (const [window, output] of [[100000, 16384], [8000, 2000], [2, 1]]) {
    const native = compile({ contextWindow: window, maxInputTokens: window, maxOutputTokens: window });
    assert.equal(native.maxOutputTokens, output);
    assert.equal(native.maxInputTokens + native.maxOutputTokens, window);
  }
  assert.throws(() => compile({ contextWindow: 1, maxInputTokens: 1, maxOutputTokens: 1 }), /至少容纳一个输入 token 和一个输出 token/);
  const independent = compile({ contextWindowMode: 'input', contextWindow: 8000, maxOutputTokens: 20000 });
  assert.equal(independent.maxInputTokens, 8000);
  assert.equal(independent.maxOutputTokens, 20000);
});

test('chat-specific caps apply before choosing output reservations', () => {
  const params = { maxOutputTokens: 64000, defaultOutputTokens: 50000,
    chatCompletionOptions: { maxTokensField: 'max_tokens', maxOutputTokens: 4096, includeUsage: false } };
  assert.equal(compile(params, model(), 'chatCompletions').maxOutputTokens, 4096);
  assert.equal(compile(params, model(), 'responses').maxOutputTokens, 50000);
  assert.equal(compile(params, model(), 'messages').maxOutputTokens, 50000);
});

test('billing tiers and retired per-model budgets never reduce published capacity', () => {
  const params = { contextWindow: 300000, maxOutputTokens: 20000, contextPricing: {
    kind: 'tiered', scope: 'custom', thresholds: [100000, 200000], source: 'test', checkedAt: null, note: '' } };
  const full = compile(params);
  assert.equal(full.maxInputTokens, 280000);
  assert.equal(full.maxInputTokens + full.maxOutputTokens, 300000);
  assert.deepEqual(compile(params, model('sample', { contextSize: 200000 })), full);
  for (const contextPricing of [undefined, { ...params.contextPricing, thresholds: [128000] }, { ...params.contextPricing, kind: 'flat', thresholds: [] }]) {
    assert.deepEqual(compile({ ...params, contextPricing }), full);
  }
});

test('thinking mapping is profile-driven, target-specific and invariant under arbitrary model renames', () => {
  const params = { thinking: true, supportsReasoningEffort: ['low', 'max'], reasoningControls: { note: '', protocols: {
    messages: { modePath: ['thinking', 'type'], enabledValue: 'adaptive', budgetPath: ['thinking', 'budget_tokens'], budget: { min: 1024, max: 63999, default: 1024 } }
  } } };
  const native = compile(params, model('sample', { overrides: { defaultOutputTokens: 512 } }), 'messages');
  assert.equal(native.adaptiveThinking, true);
  assert.equal(native.minThinkingBudget, undefined);
  assert.equal(native.maxThinkingBudget, undefined, 'Adaptive thinking does not also configure a legacy budget');
  const budgetOnly = structuredClone(params); budgetOnly.reasoningControls.protocols.messages.enabledValue = 'enabled';
  assert.throws(()=>compile(budgetOnly,model('sample',{overrides:{defaultOutputTokens:512}}),'messages'),/最小思考预算/);
  assert.equal(compile(budgetOnly,model('sample',{overrides:{defaultOutputTokens:2048}}),'messages').minThinkingBudget,1024);
  const db = database(params); db.models['unrelated-id'] = structuredClone(db.models.sample);
  const renamed = compileOfficialModel(provider('messages'), db, model('unrelated-id', { overrides: { defaultOutputTokens: 512 } }));
  assert.deepEqual({ ...native, id: '', name: '' }, { ...renamed, id: '', name: '' });
  for (const api of ['responses', 'chatCompletions']) {
    const other = compile(params, model(), api);
    assert.equal(Object.hasOwn(other, 'adaptiveThinking'), false);
    assert.equal(Object.hasOwn(other, 'minThinkingBudget'), false);
  }
  assert.equal(Object.hasOwn(compile({ thinking: true }, model(), 'messages'), 'adaptiveThinking'), false);
  assert.equal(Object.hasOwn(compile(params, model('sample', { overrides: { maxOutputTokens: 1 } }), 'messages'), 'minThinkingBudget'), false);
  const defaultMode = structuredClone(params); delete defaultMode.reasoningControls.protocols.messages.enabledValue;
  defaultMode.reasoningControls.protocols.messages.defaultMode = 'adaptive';
  assert.equal(compile(defaultMode, model(), 'messages').adaptiveThinking, true);
});

test('default-valued optional fields are omitted while required capabilities remain explicit', () => {
  const native = compile({}, model(), 'chatCompletions');
  assert.deepEqual(native, {
    id: 'sample', name: 'sample', url: 'https://gateway.example/v1/chat/completions', apiType: 'chat-completions',
    toolCalling: false, vision: false, maxInputTokens: 112000, maxOutputTokens: 16000
  });
  const thinking = compile({ thinking: true, supportsReasoningEffort: ['low', 'high'] }, model(), 'chatCompletions');
  assert.equal(thinking.thinking, true);
  assert.deepEqual(thinking.supportsReasoningEffort, ['low', 'high']);
  assert.equal(Object.hasOwn(thinking, 'reasoningEffortFormat'), false);
});

test('K3 sampling overrides Copilot chat defaults without adding unused settings to other protocols', () => {
  for (const id of ['kimi-k3', 'kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed']) {
    const item = model(id);
    const native = compileOfficialModel(provider('chatCompletions', [item]), catalog, item);
    assert.deepEqual(native.modelOptions, { top_p: 0.95 });
    assert.equal(native.thinking, true, 'The official adapter omits temperature for thinking models');
    for (const apiType of ['responses', 'messages']) {
      assert.equal(Object.hasOwn(compileOfficialModel(provider(apiType, [item]), catalog, item), 'modelOptions'), false);
    }
    const renamed = { ...catalog, models: { arbitrary: catalog.models[id] } };
    assert.deepEqual(compileOfficialModel(provider('chatCompletions'), renamed, model('arbitrary')).modelOptions, native.modelOptions);
  }
});

test('native reasoning choices honor declarative disables, aliases and supported field paths', () => {
  const params = { thinking: true, supportsReasoningEffort: ['none', 'low', 'high', 'max'], reasoningControls: { note: '', protocols: {
    chatCompletions: { modePath: ['thinking', 'type'], enabledValue: 'enabled', disabledValue: 'disabled', disabledEfforts: ['none'], effortValues: { high: 'low', max: 'high' } }
  } } };
  const native = compile(params, model('sample', { reasoningEffort: 'max' }), 'chatCompletions');
  assert.deepEqual(native.supportsReasoningEffort, ['low', 'high']);
  assert.equal(native.defaultReasoningEffort, 'high');
  assert.throws(() => compile(params, model('sample', { reasoningEffort: 'none' }), 'chatCompletions'), /官方配置暂不支持/);
  assert.ok(unsupportedFields(provider('chatCompletions'), database(params)).some(item => item.field.endsWith('.disabledEfforts')));
  for (const [effortPath, format] of [[['reasoning_effort'], undefined], [['reasoning', 'effort'], 'responses'], [['output_config', 'effort'], 'messages']]) {
    const changed = structuredClone(params); changed.reasoningControls.protocols.chatCompletions.effortPath = effortPath;
    assert.equal(compile(changed, model(), 'chatCompletions').reasoningEffortFormat, format);
  }
  for (const effortPath of [null, ['extra_body', 'thinking_level']]) {
    const changed = structuredClone(params); changed.reasoningControls.protocols.chatCompletions.effortPath = effortPath;
    assert.equal(compile(changed, model(), 'chatCompletions').supportsReasoningEffort, undefined);
    assert.throws(() => compile(changed, model('sample', { reasoningEffort: 'high' }), 'chatCompletions'), /官方配置暂不支持/);
  }
  const disabled = compile(params, model('sample', { overrides: { thinking: false } }), 'chatCompletions');
  assert.equal(disabled.thinking, undefined); assert.equal(disabled.supportsReasoningEffort, undefined);
  const standard = compile({ thinking: true, supportsReasoningEffort: ['none', 'minimal', 'high'] }, model(), 'chatCompletions');
  assert.deepEqual(standard.supportsReasoningEffort, ['none', 'minimal', 'high'], 'Names alone never decide representability');
});

test('large provider compilation normalizes routing once', () => {
  const models = Array.from({ length: 5000 }, (_, i) => model(`fixture-${i}`));
  let scans = 0;
  const supplier = provider('responses', models);
  Object.defineProperty(supplier, 'models', { get() { scans++; return models; } });
  assert.equal(compileOfficialGroup(supplier, database()).models.length, 5000);
  assert.ok(scans < 10, `Expected bounded model-list scans, got ${scans}`);
});

test('only explicit valid temperature and top_p reach native modelOptions', () => {
  for (const parameters of [{ temperature: 0, top_p: 1 }, { temperature: null, top_p: null }, { temperature: 2.5, top_p: 0 }]) {
    const params = { reasoningControls: { note: '', protocols: { responses: { parameters }, messages: { parameters: { temperature: 0.3 } } } } };
    assert.deepEqual(compile(params).modelOptions, parameters);
    assert.deepEqual(compile(params, model(), 'messages').modelOptions, { temperature: 0.3 });
    assert.equal(Object.hasOwn(compile(params, model(), 'chatCompletions'), 'modelOptions'), false);
  }
  for (const parameters of [{ temperature: -1, top_p: 1.01 }, { temperature: true, top_p: '0.5' }, { temperature: [1], top_p: { value: 1 } }]) {
    const params = { reasoningControls: { note: '', protocols: { responses: { parameters } } } };
    assert.equal(Object.hasOwn(compile(params), 'modelOptions'), false);
    assert.equal(unsupportedFields(provider(), database(params)).length, 2);
  }
});

test('unmapped request JSON is reported separately and never injected into native models', () => {
  const db = database({ thinking: true, reasoningControls: { note: '', protocols: { responses: { parameters: {
    temperature: 0.5, reasoning: { summary: 'auto' }, extra_body: { enable_thinking: true }, stop: ['end'], top_k: 20
  } } } } });
  const supplier = provider();
  const group = compileOfficialGroup(supplier, db);
  validateSchema(group, groupSchema);
  assert.deepEqual(group.models[0].modelOptions, { temperature: 0.5 });
  assert.deepEqual(unsupportedFields(supplier, db).map(item => item.field.split('.').at(-1)), ['reasoning', 'extra_body', 'stop', 'top_k']);
  const json = JSON.stringify(group);
  for (const field of ['reasoningControls', 'extra_body', 'top_k', 'summary', 'enable_thinking', 'warnings']) assert.equal(json.includes(`"${field}"`), false);
});

test('credentials never get read or emitted, ZDR is per model, and responses remain stateless', () => {
  for (const zeroDataRetentionEnabled of [false, true]) {
    const supplier = provider('responses', [model(), model('unknown')], { zeroDataRetentionEnabled });
    Object.defineProperty(supplier, 'apiKey', { enumerable: true, get() { assert.fail('Compiler read a key'); } });
    const group = compileOfficialGroup(supplier, database());
    assert.ok(group.models.every(item => item.zeroDataRetentionEnabled === zeroDataRetentionEnabled && item.statefulResponses === (zeroDataRetentionEnabled ? undefined : false)));
    for (const apiType of ['messages', 'chatCompletions']) {
      const other = compileOfficialGroup(provider(apiType, supplier.models, { zeroDataRetentionEnabled }), database());
      assert.ok(other.models.every(item => !Object.hasOwn(item, 'zeroDataRetentionEnabled') && !Object.hasOwn(item, 'statefulResponses')));
    }
    assert.equal(JSON.stringify(group).includes('apiKey'), false);
    assert.equal(Object.hasOwn(group, 'settings'), false);
    validateSchema(group, groupSchema);
  }
  const configured = compileOfficialGroup(provider('messages', [model('sample', { reasoningEffort: 'max' })]), database({thinking:true,supportsReasoningEffort:['low','max']}));
  assert.equal(Object.hasOwn(configured, 'settings'), false);
  assert.equal(configured.models[0].defaultReasoningEffort,'max','The official provider reads this optional capability as its default');
});
