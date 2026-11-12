'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { buildModelCatalog, fetchModelCatalog } = require('../dist/core/modelCatalog');
const { validateDatabase } = require('../dist/core/configuration');
const { checkSnapshot } = require('../scripts/catalog/update.cjs');
const policy = require('../resources/catalog/compatibility.json');
const { setLocale } = require('../resources/shared/i18n');
const TIME = '2026-11-09T11:15:00.000Z';
const [FIRST, SECOND] = policy.providers;
setLocale('zh-CN');

function add(raw, provider, id, changes = {}, canonicalChanges = {}) {
  const canonical = `${policy.providerDefaults[provider].canonicalProviders[0]}/${id}`;
  const model = { id, name: `Original ${id}`, family: policy.providerDefaults[provider].families[0],
    modalities: { input: ['text'], output: ['text'] }, limit: { context: 128000, output: 16000 },
    tool_call: true, reasoning: false, cost: { input: 1, output: 4 }, canonical_model_id: canonical, ...changes };
  raw.providers[provider].models[id] = model;
  if (model.canonical_model_id) {
    raw.models[model.canonical_model_id] = { ...structuredClone(model), id: model.canonical_model_id, ...canonicalChanges };
    delete raw.models[model.canonical_model_id].canonical_model_id;
  }
  return model;
}
function fixture() {
  const raw = { providers: {}, models: {} };
  for (const [index, id] of policy.providers.entries()) {
    raw.providers[id] = { id, name: `Provider ${index}`, doc: `https://docs.example/${id}`, models: {} };
    add(raw, id, `baseline-${index}`);
  }
  return raw;
}
function relay(raw, provider, id, canonical, changes = {}) {
  const source = raw.models[canonical];
  raw.providers[provider] ??= { id: provider, name: provider, models: {} };
  raw.providers[provider].models[id] = { ...structuredClone(source), id, canonical_model_id: canonical, ...changes };
}
function models(raw) { return buildModelCatalog(raw, TIME).database.models; }
function response(raw = fixture()) { return new Response(JSON.stringify(raw), { headers: { 'Content-Type': 'application/json' } }); }

test('selected providers are declared in policy and produce a validated immutable snapshot', () => {
  const raw = fixture(), before = structuredClone(raw), result = buildModelCatalog(raw, TIME);
  assert.equal(result.source, 'models.dev'); assert.equal(result.updatedAt, TIME);
  assert.deepEqual(raw, before); assert.deepEqual(validateDatabase(result.database), result.database);
  assert.equal(Object.keys(result.database.models).length, policy.providers.length);
  assert.equal(result.database.defaults.name, ''); assert.equal(result.database.defaults.contextWindow, 128000);
  assert.equal(result.database.defaults.maxOutputTokens, 16000); assert.equal(result.database.defaults.thinking, false);
  assert.equal(Object.hasOwn(result.database.defaults, 'contextPricing'), false);
  assert.equal(result.database.models['baseline-0'].name, 'Original baseline-0');
  assert.equal(Object.hasOwn(result.database.models['baseline-0'], 'verifiedAt'), false);
  assert.equal(Object.hasOwn(result.database.models['baseline-0'], 'source'), false);
  result.database.models['baseline-0'].name = 'edited';
  assert.equal(models(raw)['baseline-0'].name, 'Original baseline-0');
});

test('missing selected providers and invalid schema reject the entire update', () => {
  for (const mutate of [raw => delete raw.providers[SECOND], raw => raw.providers[SECOND].models = [],
    raw => raw.providers[SECOND].models = {}, raw => raw.providers[FIRST].models['baseline-0'].id = 'wrong',
    raw => raw.providers[FIRST].models['baseline-0'].modalities.input = 'text',
    raw => raw.providers[FIRST].models['baseline-0'].canonical_model_id = 'missing/model',
    raw => raw.providers[FIRST].models['baseline-0'].reasoning_options = [{ type: 'effort', values: ['bad value'] }],
    raw => raw.models = []]) {
    const raw = fixture(); mutate(raw); assert.throws(() => models(raw), /模型目录数据格式无效/);
  }
  for (const time of ['2026-11-09', '2026-02-30T00:00:00Z', '2026-11-09T00:00:00+08:00']) {
    assert.throws(() => buildModelCatalog(fixture(), time), /模型目录数据格式无效/);
  }
});

test('only supported text chat entries survive shared routing and declared families', () => {
  const raw = fixture();
  add(raw, FIRST, 'unsupported-family', { family: 'unknown', canonical_model_id: undefined });
  add(raw, FIRST, 'vector-only', { type: 'embedding' });
  add(raw, FIRST, 'image-output', { modalities: { input: ['text'], output: ['text', 'image'] } });
  add(raw, FIRST, 'no-text-input', { modalities: { input: ['audio'], output: ['text'] } });
  add(raw, FIRST, 'text-embedding-test');
  add(raw, FIRST, 'with-image', { modalities: { input: ['text', 'image/png'], output: ['text'] } });
  const result = models(raw);
  for (const id of ['unsupported-family', 'vector-only', 'image-output', 'no-text-input', 'text-embedding-test']) assert.equal(result[id], undefined, id);
  assert.equal(result['with-image'].vision, true);
});

test('relay conflicts never choose specifications and canonical aliases preserve exact case', () => {
  const raw = fixture();
  add(raw, FIRST, 'native', { limit: { context: 250000, output: 20000 }, cost: { input: 2, output: 5 } });
  const canonical = raw.providers[FIRST].models.native.canonical_model_id;
  relay(raw, 'proxy-first', 'native', canonical, { name: 'Wrong relay', limit: { context: 999, output: 10 }, cost: { input: 99, output: 100 } });
  relay(raw, 'proxy-first', 'MiXeD/Alias', canonical, { limit: { context: 999, output: 10 }, cost: { input: 99, output: 100 } });
  raw.providers = { 'proxy-first': raw.providers['proxy-first'], ...raw.providers };
  const result = models(raw);
  assert.equal(result.native.contextWindow, 250000);
  assert.equal(result['MiXeD/Alias'].aliasOf, 'native'); assert.equal(result['MiXeD/Alias'].contextWindow, 250000);
  assert.equal(result['mixed/alias'], undefined); assert.equal(result.Alias, undefined);
  assert.equal(result['MiXeD/Alias'].maxOutputTokens, result.native.maxOutputTokens);
});

test('ambiguous aliases, unknown mappings, and unsupported relay records are excluded', () => {
  const raw = fixture(); const one = raw.providers[FIRST].models['baseline-0'].canonical_model_id;
  const two = raw.providers[SECOND].models['baseline-1'].canonical_model_id;
  relay(raw, 'relay-a', 'ambiguous', one); relay(raw, 'relay-b', 'ambiguous', two);
  relay(raw, 'relay-a', 'unmapped', one, { canonical_model_id: 'unknown/model' });
  relay(raw, 'relay-a', 'specialized-alias', one, { type: 'embedding' });
  relay(raw, 'relay-a', 'conflicting-shape', one); relay(raw, 'relay-b', 'conflicting-shape', one, { canonical_model_id: undefined });
  const result = models(raw);
  for (const id of ['ambiguous', 'unmapped', 'specialized-alias', 'conflicting-shape']) assert.equal(result[id], undefined);
});

test('canonical-origin providers supply facts while priority resolves unrelated exact-ID collisions', () => {
  const raw = fixture();
  add(raw, FIRST, 'collision', { canonical_model_id: undefined, limit: { context: 90000, output: 5000 } });
  add(raw, SECOND, 'collision', { canonical_model_id: undefined, limit: { context: 180000, output: 50000 } });
  const peers = policy.providers.filter(id => policy.providerDefaults[id].canonicalProviders.some(origin => origin !== id && policy.providers.includes(origin)));
  assert(peers.length);
  const peer = peers[0], origin = policy.providerDefaults[peer].canonicalProviders.find(id => id !== peer && policy.providers.includes(id));
  add(raw, origin, 'canonical-source', { cost: { input: 3, output: 6 }, limit: { context: 320000, output: 80000 } });
  const canonical = raw.providers[origin].models['canonical-source'].canonical_model_id;
  relay(raw, peer, 'canonical-source', canonical, { cost: { input: 30, output: 60 }, limit: { context: 64000, output: 1000 } });
  const result = models(raw);
  assert.equal(result.collision.contextWindow, 90000);
  assert.equal(result['canonical-source'].contextWindow, 320000);
});

test('release presets expose only Context and the selected Output limit', () => {
  const raw = fixture();
  add(raw, SECOND, 'renamed-independent', { limit: { context: 100000, input: 200000, output: 150000 } });
  add(raw, FIRST, 'large-output', { limit: { context: 1048576, input: 1048576, output: 1048576 } }, { limit: { context: 1048576, output: 131072 } });
  add(raw, FIRST, 'missing-output', { limit: { context: 64000 } });
  add(raw, FIRST, 'shared-clamp', { limit: { context: 90000, input: 200000, output: 120000 } });
  const result = models(raw);
  assert.equal(result['renamed-independent'].contextWindow, 100000);
  assert.equal(result['renamed-independent'].maxOutputTokens, 25000);
  assert.equal(result['large-output'].contextWindow, 1048576); assert.equal(result['large-output'].maxOutputTokens, 131072);
  assert.equal(result['shared-clamp'].contextWindow, 90000); assert.equal(result['shared-clamp'].maxOutputTokens, 22500);
  assert.equal(result['missing-output'].maxOutputTokens, 16000);
  for (const record of Object.values(result)) for (const field of ['maxInputTokens', 'defaultOutputTokens', 'contextWindowMode']) assert.equal(Object.hasOwn(record, field), false);
});

test('a full-window upstream output capability becomes one usable Output default', () => {
  const raw = fixture();
  add(raw, FIRST, 'shared-full-output', { limit: { context: 1048576, output: 1048576 } }, { limit: { context: 1048576, output: 131072 } });
  const result = models(raw)['shared-full-output'];
  assert.equal(result.contextWindow, 1048576); assert.equal(result.maxOutputTokens, 131072);
  assert.equal(Object.hasOwn(result, 'defaultOutputTokens'), false); assert.equal(Object.hasOwn(result, 'maxInputTokens'), false);
});

test('effort, toggle, and budget remain distinct and Messages budgets require protocol evidence', () => {
  const raw = fixture(), native = policy.providers.find(id => policy.providerDefaults[id].nativeMessages);
  add(raw, FIRST, 'effort-mode', { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'high'] }, { type: 'toggle' }] });
  add(raw, FIRST, 'toggle-only', { reasoning: true, reasoning_options: [{ type: 'toggle' }] });
  add(raw, FIRST, 'host-budget', { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 8000 }] });
  add(raw, native, 'native-budget', { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 8000 }] });
  add(raw, native, 'missing-bound', { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024 }] });
  add(raw, native, 'no-adaptive-guess', { reasoning: true });
  const result = models(raw);
  assert.deepEqual(result['effort-mode'].supportsReasoningEffort, ['low', 'high']);
  assert.deepEqual(result['toggle-only'].supportsReasoningEffort, []); assert.equal(result['toggle-only'].protocols, undefined);
  assert.equal(result['host-budget'].protocols, undefined);
  assert.deepEqual(result['native-budget'].supportsReasoningEffort, []);
  assert.deepEqual(result['native-budget'].protocols.messages, { effortFormat: 'unsupported', thinkingBudget: { min: 1024, max: 8000 } });
  assert.equal(result['missing-bound'].protocols, undefined); assert.equal(result['no-adaptive-guess'].protocols, undefined);
});

test('pricing and provenance metadata cannot change normalized model capabilities', () => {
  const raw = fixture();
  const baseline = models(raw);
  raw.providers[FIRST].models['baseline-0'].cost = { input: -1, output: 'invalid', tiers: [] };
  raw.providers[FIRST].doc = 'https://untrusted.example/docs';
  assert.deepEqual(models(raw), baseline);
});

test('renamed compatibility data applies sampling parameters without identity branches', () => {
  const moduleId = require.resolve('../dist/core/modelCatalog'), policyId = require.resolve('../resources/catalog/compatibility.json');
  const original = require.cache[policyId].exports, originalModule = require.cache[moduleId];
  const renamed = structuredClone(original);
  const sampling = Object.values(renamed.models).find(patch => renamed.profiles[patch.profile]?.protocols?.chatCompletions?.modelOptions?.top_p === 0.95);
  renamed.models = { 'unrelated-sampling-name': sampling };
  try {
    require.cache[policyId].exports = renamed; delete require.cache[moduleId];
    const converter = require('../dist/core/modelCatalog').buildModelCatalog, raw = fixture();
    add(raw, FIRST, 'unrelated-sampling-name');
    const result = converter(raw, TIME).database.models;
    assert.equal(result['unrelated-sampling-name'].protocols.chatCompletions.modelOptions.top_p, 0.95);
  } finally { require.cache[policyId].exports = original; require.cache[moduleId] = originalModule; }
});

test('offline checker validates cache shape and compatibility at module load', async () => {
  const snapshot = buildModelCatalog(fixture(), TIME);
  assert.deepEqual(checkSnapshot(snapshot), snapshot);
  assert.throws(() => checkSnapshot(snapshot.database));
  assert.throws(() => checkSnapshot({ ...snapshot, source: 'other' }));
  const bad = structuredClone(snapshot); bad.database.models['baseline-0'].contextWindow = 0;
  assert.throws(() => checkSnapshot(bad));
  const promises = require('node:fs/promises'), originalRead = promises.readFile, originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => { throw new Error('Offline check used the network'); };
    promises.readFile = async filename => { assert.equal(filename, require('node:path').resolve(__dirname, '../resources/catalog/models.json')); return JSON.stringify(snapshot); };
    await require('../scripts/catalog/update.cjs').main(['--check']);
  } finally { promises.readFile = originalRead; globalThis.fetch = originalFetch; }
  const moduleId = require.resolve('../dist/core/modelCatalog'), policyId = require.resolve('../resources/catalog/compatibility.json');
  const originalPolicy = require.cache[policyId].exports, originalModule = require.cache[moduleId];
  try {
    require.cache[policyId].exports = { ...originalPolicy, providers: [FIRST, FIRST] }; delete require.cache[moduleId];
    assert.throws(() => require('../dist/core/modelCatalog'), /兼容配置无效/);
  } finally { require.cache[policyId].exports = originalPolicy; require.cache[moduleId] = originalModule; }
});

test('public fetch is fixed GET with no authentication, cookies, redirects, or supplier URL', async () => {
  let calls = 0;
  const result = await fetchModelCatalog(undefined, async (url, options) => {
    calls++; assert.equal(url, 'https://models.dev/catalog.json'); assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { Accept: 'application/json' }); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined); assert(options.signal instanceof AbortSignal);
    return response();
  });
  assert.equal(calls, 1); assert.equal(result.source, 'models.dev'); assert(!Number.isNaN(Date.parse(result.updatedAt)));
});

test('fetch rejects HTTP, redirects, invalid UTF-8/JSON/schema, and hides response or transport details', async () => {
  for (const make of [() => new Response('SECRET body', { status: 403 }), () => new Response('SECRET invalid JSON'),
    () => response({ providers: {}, models: {} }), () => new Response(new Uint8Array([0xff])),
    () => { const r = response(); Object.defineProperty(r, 'redirected', { value: true }); return r; },
    () => { throw new Error('SECRET authorization and transport details'); }]) {
    await assert.rejects(fetchModelCatalog(undefined, async () => make()), error => {
      assert.match(error.message, /模型目录/); assert.doesNotMatch(error.message, /SECRET|authorization|transport details/); return true;
    });
  }
});

test('fetch enforces 16 MiB from header and streamed bytes and cancels the reader', async () => {
  let cancelled = 0;
  const large = 16 * 1024 * 1024;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(large)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; } });
  await assert.rejects(fetchModelCatalog(undefined, async () => new Response(stream, { headers: { 'content-length': '1' } })), /16 MiB/);
  assert.equal(cancelled, 1);
  let pulls = 0;
  const tooLarge = new Response(new ReadableStream({ pull() { pulls++; }, cancel() { cancelled++; } }), { headers: { 'content-length': String(large + 1) } });
  await assert.rejects(fetchModelCatalog(undefined, async () => tooLarge), /16 MiB/);
  assert.equal(cancelled, 2); assert(pulls <= 1);
});

test('abort cancels before fetch and during an unresponsive streamed response', async () => {
  const first = new AbortController(); first.abort(new Error('SECRET cancellation'));
  await assert.rejects(fetchModelCatalog(first.signal, async () => { assert.fail('Already aborted'); }), error => error.name === 'AbortError' && !error.message.includes('SECRET'));
  const controller = new AbortController(); let cancelled = false;
  const pending = fetchModelCatalog(controller.signal, async () => new Response(new ReadableStream({ pull() { controller.abort(new Error('SECRET reason')); }, cancel() { cancelled = true; } })));
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes('SECRET'));
  assert.equal(cancelled, true);
});

test('30-second timeout bounds even an injected transport that ignores AbortSignal', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = fetchModelCatalog(undefined, async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  context.mock.timers.tick(29999); assert.equal(signal.aborted, false);
  context.mock.timers.tick(1); assert.equal(signal.aborted, true);
  await assert.rejects(pending, error => error.name === 'TimeoutError' && /模型目录请求超时/.test(error.message));
});

test('cancelling an unresponsive request also cancels its body if the response arrives later', async () => {
  const controller = new AbortController(); let resolve, cancelled = false;
  const pending = fetchModelCatalog(controller.signal, () => new Promise(done => resolve = done));
  controller.abort(new Error('SECRET cancellation'));
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes('SECRET'));
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(done => setImmediate(done));
  assert.equal(cancelled, true);
});

test('the same timeout also bounds a stalled response stream and releases it', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const pending = fetchModelCatalog(undefined, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; }
  })));
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(30000);
  await assert.rejects(pending, error => error.name === 'TimeoutError');
  assert.equal(cancelled, true);
});

test('downloaded real snapshot preserves representative canonical aliases, budgets, and compatibility', { skip: !process.env.MODELS_DEV_CATALOG_FIXTURE }, () => {
  const raw = JSON.parse(fs.readFileSync(process.env.MODELS_DEV_CATALOG_FIXTURE, 'utf8'));
  const result = models(raw);
  assert.equal(result['kimi-k3'].contextWindow, 1048576); assert.equal(result['kimi-k3'].maxOutputTokens, 131072);
  assert.equal(result['kimi-k3'].protocols.chatCompletions.modelOptions.top_p, 0.95);
  assert.equal(result['gemini-4-argon'].contextWindowMode, undefined);
  assert.equal(result['gemini-3.1-pro-preview'].protocols.chatCompletions.effortFormat, 'unsupported');
  assert(result['GLM-5.3']); assert.equal(result['GLM-5.3'].contextWindow, result['glm-5.3'].contextWindow);
  assert.equal(result['GLM-5.3'].aliasOf, 'glm-5.3');
  assert.equal(result['claude-opus-4-8'].protocols.messages.adaptiveThinking, true);
});
