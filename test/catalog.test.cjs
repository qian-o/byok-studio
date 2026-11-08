const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDatabase } = require('../dist/core/configuration');
const { buildCatalog, sourceDocument, validate } = require('../scripts/update-catalog.cjs');
const catalog = require('../data/model-parameters.json');
const displayNames = require('../data/model-display-names.json');
const reviewed = require('../data/official-model-overrides.json').models;
const releaseDates = require('../data/catalog-release-dates-0.1.4.json');
const asOf = '2026-11-08';
const officialSource = reviewed['gpt-6-astra'].source;
const communityReleaseSource = 'release date only: models.dev community catalog (first-party provider: openai): https://models.dev/api.json (not officially verified)';
const geminiOfficialSource = reviewed['gemini-4-argon'].source;
const requestedIds = [
  'codex-auto-review', 'claude-fable-5', 'claude-haiku-4-5-20251001',
  'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6',
  'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-5-5',
  'claude-fable-5-1', 'claude-haiku-5-5', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra',
  'grok-4.5', 'grok-4.6', 'grok-4.7', 'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview', 'gemini-3.1-pro-preview', 'gemini-3.8-flash',
  'gemini-4-argon', 'kimi-k3', 'kimi-k3.1-pro', 'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-1017', 'GLM-5.3', 'GLM-5.3-Flash',
  'doubao-seed-2-1-pro', 'doubao-seed-2-1-turbo',
];
const unverifiedAliases = [
  'codex-auto-review', 'GLM-5.3', 'GLM-5.3-Flash',
  'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017',
  'doubao-seed-2-1-pro', 'doubao-seed-2-1-turbo',
];

const checkedEfforts = {
  'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};
test('codex-auto-review is selectable without inventing model capabilities',()=>{
  const model=catalog.models['codex-auto-review'];
  assert.ok(model);
  assert.equal(model.name,'Codex Auto Review');
  assert.equal(model.verifiedAt,null);
  for(const key of ['contextWindow','maxOutputTokens','toolCalling','vision','thinking','supportsReasoningEffort']) assert.deepEqual(model[key],catalog.defaults[key]);
});
test('bundled model catalog is valid and identifies the provenance of each entry',()=>{
  const data=validateDatabase(catalog);
  assert.ok(Object.keys(data.models).length>=181);
  assert.ok(!Object.keys(data.models).some(id=>id.startsWith('demo-')));
  for(const [id,record] of Object.entries(data.models)){
    assert.ok(record.name,id+' needs a display name');
    assert.ok(record.source,id+' needs a source');
    assert.ok(record.maxOutputTokens<=record.contextWindow,id+' output must not exceed context');
    if(record.maxInputTokens!==undefined) assert.ok(record.maxInputTokens>0&&record.maxInputTokens<=record.contextWindow,id+' input ceiling');
    assert.equal(Object.hasOwn(record,'zeroDataRetentionEnabled'),false);
  }
});

for (const [id, values] of Object.entries(checkedEfforts)) {
  test(`${id} has its independently documented reasoning efforts`, () => {
    const model = catalog.models[id];
    assert.deepEqual(model.supportsReasoningEffort, values);
    const url = `https://developers.openai.com/api/docs/models/${id}`;
    assert.ok(model.source.includes(url));
    assert.equal(model.verifiedAt, reviewed[id].verifiedAt);
    assert.equal(model.maxInputTokens, 922000, 'Independent published input limit');
    assert.equal(model.contextWindow, 1050000);
    assert.equal(model.maxOutputTokens, 128000);
    for (const key of ['toolCalling', 'vision', 'thinking']) assert.equal(model[key], true);
  });
}

test('unverified neighboring model efforts remain unknown', () => {
  assert.deepEqual(catalog.models['gpt-5.3-codex-spark'].supportsReasoningEffort, []);
  assert.equal(catalog.models['gpt-5.3-codex-spark'].verifiedAt, null);
});

const unknownIds = ['unverified-model-fixture', 'unverified-gpt-fixture', 'gpt-6.1-sol-2026-11-07'];
function upstreamFixture() {
  const upstream = {};
  const idsByProvider = {
    openai: [...Object.keys(checkedEfforts), ...unknownIds],
    anthropic: ['anthropic-fixture'],
    xai: ['xai-fixture'],
    volcengine: ['doubao-fixture'],
    deepseek: ['deepseek-fixture'],
    google: ['google-fixture'],
    alibaba: ['qwen-fixture'],
    'alibaba-cn': [],
    moonshotai: ['moonshot-fixture'],
    zai: ['zai-fixture'],
    zhipuai: [],
  };
  for (const [provider, ids] of Object.entries(idsByProvider)) {
    upstream[provider] = { models: Object.fromEntries(ids.map(id => [id, {
      id,
      name: id,
      limit: { context: 64000, output: 4000 },
      modalities: { input: ['text'], output: ['text'] },
      tool_call: false,
      reasoning: true,
      reasoning_options: ['invented-effort'],
      release_date: '2026-11-07',
    }])) };
  }
  return upstream;
}

test('updater preserves checked efforts, provenance and dates without family inference', () => {
  const { database, counts, skipped, excludedCeilings } = buildCatalog(upstreamFixture(), asOf);
  for (const [id, values] of Object.entries(checkedEfforts)) {
    const model = database.models[id];
    assert.deepEqual(model.supportsReasoningEffort, values, id);
    assert.equal(model.source, catalog.models[id].source, id);
    assert.equal(model.verifiedAt, catalog.models[id].verifiedAt, id);
    assert.equal(model.releaseDate, '2026-11-07', id);
    assert.equal(model.contextWindow, 1050000);
    assert.equal(model.maxInputTokens, 922000);
    assert.equal(model.maxOutputTokens, 128000);
    assert.equal(model.toolCalling, true);
    assert.equal(model.vision, true);
  }
  for (const id of unknownIds) {
    assert.deepEqual(database.models[id].supportsReasoningEffort, [], id);
    assert.equal(database.models[id].verifiedAt, null, id);
    assert.equal(database.models[id].source.includes('reasoning-effort'), false, id);
  }
  assert.deepEqual(database.models['codex-auto-review'], catalog.models['codex-auto-review']);
  const sources = sourceDocument(database, counts, skipped, excludedCeilings, '2026-11-08T00:00:00.000Z', 'fixture-digest');
  for (const id of Object.keys(checkedEfforts)) {
    assert.ok(sources.includes(`| \`${id}\` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/${id}) |`), id);
  }
  assert.ok(sources.includes('Reasoning.effort supports: none, low, medium (default), high, xhigh, and max.'));
  assert.ok(sources.includes('`reasoning.effort` supports `low`, `medium` (default), `high`, `xhigh`, and `max`.'));
  const knownDates = Object.values(database.models).filter(model => model.releaseDate).length;
  assert.equal(knownDates, 18);
  assert.ok(sources.includes(`**18 known release dates**; **${Object.keys(database.models).length - knownDates} unknown dates**`));
  assert.ok(sources.includes('Its release date is not officially verified'));
  assert.ok(sources.includes('not model verification dates'));
});

test('offline validation rejects altered official facts and unverified whole-record overclaims', () => {
  for(const [field,value] of [['supportsReasoningEffort',['invented']],['source','No primary source'],['verifiedAt','2026-11-07']]) {
    const bad=structuredClone(catalog);bad.models['gpt-6.1-sol'][field]=value;
    assert.throws(()=>validate(bad,asOf),/gpt-6\.1-sol: reviewed/);
  }
  const bad=structuredClone(catalog);bad.models['gpt-5.6'].verifiedAt='2026-11-08';
  assert.throws(()=>validate(bad,asOf),/reviewed verifiedAt/);
});

test('bundled release-date seed contains only known dates for existing exact IDs', () => {
  validate(catalog, asOf);
  const known = Object.entries(catalog.models).filter(([, model]) => model.releaseDate != null);
  assert.equal(known.length, 158);
  assert.ok(Object.keys(catalog.models).length - known.length >= 23);
  assert.equal(Object.keys(releaseDates).length, 134, 'The historical migration seed is unchanged');
  for (const [id, date] of Object.entries(releaseDates)) assert.equal(catalog.models[id].releaseDate, date, id);
  assert.equal(catalog.defaults.releaseDate, undefined);
  assert.equal(catalog.models['codex-auto-review'].releaseDate, undefined);
  assert.equal(catalog.models['qwen3-32b'].releaseDate, undefined, 'A month-only source must not become a guessed day');
});

test('updater leaves unknown dates absent without ID, family or update-date inference', () => {
  const upstream = upstreamFixture();
  for (const id of unknownIds) {
    delete upstream.openai.models[id].release_date;
    upstream.openai.models[id].last_updated = '2026-11-07';
  }
  const { database } = buildCatalog(upstream, asOf);
  assert.equal(database.models['gpt-6.1-sol'].releaseDate, '2026-11-07');
  for (const id of [...unknownIds, 'codex-auto-review']) {
    assert.equal(Object.hasOwn(database.models[id], 'releaseDate'), false, id);
    assert.equal(database.models[id].verifiedAt, null, id);
  }
  assert.equal(Object.hasOwn(database.defaults, 'releaseDate'), false);
});

test('updater never substitutes another provider or regional duplicate for a missing date', () => {
  const upstream = upstreamFixture();
  const openai = upstream.openai.models['unverified-model-fixture'];
  delete openai.release_date;
  upstream.anthropic.models[openai.id] = { ...openai, release_date: '2026-11-01' };
  upstream.openrouter = { models: { 'gpt-6-astra': { ...upstream.openai.models['gpt-6-astra'] } } };
  delete upstream.openai.models['gpt-6-astra'];
  const qwen = upstream.alibaba.models['qwen-fixture'];
  delete qwen.release_date;
  upstream['alibaba-cn'].models[qwen.id] = { ...qwen, release_date: '2026-11-01' };
  upstream['alibaba-cn'].models['qwen-regional-fixture'] = {
    ...qwen, id: 'qwen-regional-fixture', release_date: '2024-02-29',
  };
  const { database } = buildCatalog(upstream, asOf);
  for (const id of ['unverified-model-fixture', 'gpt-6-astra', 'qwen-fixture']) {
    assert.equal(database.models[id].releaseDate, undefined, id);
  }
  assert.equal(database.models['gpt-6-astra'].source, officialSource);
  assert.equal(database.models['gpt-6-astra'].verifiedAt, reviewed['gpt-6-astra'].verifiedAt);
  assert.equal(database.models['qwen-regional-fixture'].releaseDate, '2024-02-29');
  assert.match(database.models['qwen-regional-fixture'].source, /first-party provider: alibaba-cn/);
});

test('updater ignores incomplete or impossible dates and keeps valid leap days', () => {
  const upstream = upstreamFixture();
  const invalidDates = [null, '', '2026-11', '2025-02-29', '2026-04-31', '2026-13-01',
    '2026-00-10', '2026-01-00', '0000-01-01', '2026-11-01T00:00:00Z', 20261101, false];
  for (const [index, release_date] of invalidDates.entries()) {
    const id = `invalid-date-fixture-${index}`;
    upstream.openai.models[id] = { ...upstream.openai.models['unverified-model-fixture'], id, release_date };
  }
  upstream.openai.models['unverified-model-fixture'].release_date = '2024-02-29';
  const { database } = buildCatalog(upstream, asOf);
  for (const index of invalidDates.keys()) {
    const id = `invalid-date-fixture-${index}`;
    assert.ok(database.models[id], id);
    assert.equal(Object.hasOwn(database.models[id], 'releaseDate'), false, id);
  }
  assert.equal(database.models['unverified-model-fixture'].releaseDate, '2024-02-29');
});

test('updater excludes future community models without assigning future dates to official capabilities', () => {
  const upstream = upstreamFixture();
  upstream.openai.models['unverified-model-fixture'].release_date = '2026-11-09';
  upstream.openai.models['gpt-6-astra'].release_date = '2026-11-09';
  upstream.openai.models['gpt-6-sol'].release_date = asOf;
  const { database } = buildCatalog(upstream, asOf);
  assert.equal(database.models['unverified-model-fixture'], undefined);
  assert.equal(database.models['gpt-6-astra'].releaseDate, undefined);
  assert.equal(database.models['gpt-6-astra'].source, officialSource);
  assert.equal(database.models['gpt-6-astra'].contextWindow, 1050000);
  assert.equal(database.models['gpt-6-astra'].verifiedAt, reviewed['gpt-6-astra'].verifiedAt);
  assert.equal(database.models['gpt-6-sol'].releaseDate, asOf);
});

test('offline validation accepts optional dates and rejects invalid, future or default dates', () => {
  const legacy = structuredClone(catalog);
  for (const record of Object.values(legacy.models)) delete record.releaseDate;
  legacy.models['gpt-6-astra'].source = officialSource;
  legacy.models['gemini-4-argon'].source = geminiOfficialSource;
  assert.doesNotThrow(() => validate(legacy, asOf));
  legacy.defaults.releaseDate = null;
  for (const record of Object.values(legacy.models)) record.releaseDate = null;
  assert.doesNotThrow(() => validate(legacy, asOf));
  legacy.models['gpt-5.6'].releaseDate = '2024-02-29';
  assert.doesNotThrow(() => validate(legacy, asOf));

  for (const releaseDate of ['2026-11-09', '9999-12-31', '2025-02-29', '2026-04-31',
    '2026-13-01', '2026-00-10', '2026-01-00', '0000-01-01', '2026-11', '2026-1-01',
    '2026-11-01T00:00:00Z', '', false, 20261101, [], {}]) {
    legacy.models['gpt-5.6'].releaseDate = releaseDate;
    assert.throws(() => validate(legacy, asOf), /gpt-5.6: invalid or future release date/, JSON.stringify(releaseDate));
  }
  legacy.models['gpt-5.6'].releaseDate = null;
  legacy.defaults.releaseDate = '2026-11-07';
  assert.throws(() => validate(legacy, asOf), /Defaults must not supply a release date/);
});

test('official capabilities remain checked separately from community release dates', () => {
  const missing=structuredClone(catalog);missing.models['gpt-6-astra'].source='No source';
  assert.throws(()=>validate(missing,asOf),/gpt-6-astra: reviewed source/);
  const changed=structuredClone(catalog);changed.models['gpt-6-astra'].contextWindow=1000000;
  assert.throws(()=>validate(changed,asOf),/gpt-6-astra: checked input context|gpt-6-astra: reviewed contextWindow/);
});

test('all 36 saved IDs stay intact and six aliases use explicit capable presets', () => {
  assert.equal(requestedIds.length,36);
  for(const id of requestedIds) assert.ok(catalog.models[id],id);
  for(const id of unverifiedAliases.filter(id=>id!=='codex-auto-review')) {
    const m=catalog.models[id];assert.equal(m.name,displayNames[id]||id);
    assert.ok(m.aliasOf,id+' explicit mapping');assert.equal(m.toolCalling,true,id);
    assert.equal(m.thinking,true,id);assert.ok(m.contextWindow>128000,id);
    assert.ok(m.supportsReasoningEffort.length>0,id+' documented levels');
    assert.equal(m.verifiedAt,null,'Alias identity is not a verified proxy deployment');
  }
  assert.deepEqual(catalog.models['codex-auto-review'].supportsReasoningEffort,[]);
  assert.equal(catalog.models['codex-auto-review'].contextPricing.kind,'unknown');
});

test('Gemini presets retain supported wire effort levels and synchronous output ceilings', () => {
  for(const id of ['gemini-4-argon','gemini-3-flash-preview','gemini-3.1-flash-lite-preview','gemini-3.1-pro-preview','gemini-3.8-flash']) {
    const m=catalog.models[id];assert.equal(m.contextWindow,1048576,id);
    assert.equal(m.maxOutputTokens,65536,id);assert.ok(m.supportsReasoningEffort.includes('high'),id);
    assert.equal(m.supportsReasoningEffort.includes('max'),false,id);
    assert.ok(m.reasoningControls.note,id);assert.ok(m.contextPricing,id);
  }
  const bad=structuredClone(catalog);bad.models['gemini-4-argon'].supportsReasoningEffort.push('max');
  assert.throws(()=>validate(bad,asOf),/gemini-4-argon: reviewed supportsReasoningEffort/);
});

test('Kimi separates full documented output capabilities from safe default reservation', () => {
  for(const id of ['kimi-k3','kimi-k3.1-pro']) {
    const m=catalog.models[id];assert.equal(m.contextWindow,1048576);
    assert.equal(m.maxOutputTokens,1048576);assert.equal(m.maxInputTokens,1048575);
    assert.equal(m.defaultOutputTokens,131072);assert.deepEqual(m.supportsReasoningEffort,['low','high','max']);
    assert.ok(m.contextPricing);assert.ok(m.source.includes('platform.kimi.ai'));
  }
});

test('Grok keeps undisclosed output ceilings explicit while reviewed vendors expose actual reasoning controls', () => {
  for(const id of ['grok-4.5','grok-4.6','grok-4.7']) {
    const m=catalog.models[id];assert.equal(m.contextWindow,500000);assert.equal(m.maxOutputTokens,16000);
    assert.equal(m.verifiedAt,null);assert.match(m.source,/未公布|unverified|not.*maximum/);
    assert.deepEqual(m.contextPricing.thresholds,[199999]);assert.equal(m.contextPricing.rates.bands.length,2);
  }
  for(const id of ['GLM-5.3','GLM-5.3-Flash','doubao-seed-2-1-pro','doubao-seed-2-1-turbo','deepseek-v4.1-flash','deepseek-v4.1-flash-1017']) {
    assert.ok(catalog.models[id].reasoningControls,id);assert.ok(catalog.models[id].contextPricing,id);
  }
  assert.equal(catalog.models['gpt-4'],undefined);
});

test('updating after upstream removals retains every requested exact ID with honest provenance', () => {
  const upstream = upstreamFixture();
  for (const provider of Object.values(upstream)) {
    for (const id of requestedIds) delete provider.models[id];
  }
  upstream.openrouter = { models: {
    'GLM-5.3': { ...upstream.zai.models['zai-fixture'], id: 'GLM-5.3', limit: { context: 1000000, output: 131072 } },
  } };
  const { database } = buildCatalog(upstream, asOf);
  for (const id of requestedIds) assert.ok(database.models[id], id);
  assert.equal(database.models['GLM-5.3'].contextWindow,catalog.models['GLM-5.3'].contextWindow);
  assert.deepEqual(database.models['GLM-5.3'].supportsReasoningEffort,catalog.models['GLM-5.3'].supportsReasoningEffort);
  assert.equal(database.models['gpt-5.6-sol'].contextWindow,1050000);
  assert.ok(database.models['gpt-5.6-sol'].source.includes('developers.openai.com'));
  assert.deepEqual(database.models['gpt-5.6-sol'].supportsReasoningEffort, checkedEfforts['gpt-5.6-sol']);
  assert.equal(database.models['gemini-4-argon'].maxOutputTokens, 65536, 'Verified capabilities persist independently');
  const missing = structuredClone(database);
  delete missing.models['GLM-5.3'];
  assert.throws(() => validate(missing, asOf), /GLM-5\.3: missing required exact ID/);
});

test('generator selects only first-party chat models and rejects known conflicting metadata', () => {
  const upstream = upstreamFixture();
  const seed = upstream.volcengine.models['doubao-fixture'];
  upstream.volcengine.models['glm-hosted-fixture'] = { ...seed, id: 'glm-hosted-fixture' };
  upstream.volcengine.models['doubao-seed-evolving'] = { ...seed, id: 'doubao-seed-evolving' };
  upstream.volcengine.models['doubao-seed-character-260628'] = { ...seed, id: 'doubao-seed-character-260628' };
  upstream.xai.models['grok-image-fixture'] = { ...seed, id: 'grok-image-fixture', modalities: { input: ['text'], output: ['image'] } };
  upstream.xai.models['grok-video-fixture'] = { ...seed, id: 'grok-video-fixture', modalities: { input: ['text'], output: ['video'] } };
  upstream.google.models['gemini-audio-fixture'] = { ...seed, id: 'gemini-audio-fixture', modalities: { input: ['text'], output: ['audio', 'text'] } };
  upstream.alibaba.models['other-vendor-fixture'] = { ...seed, id: 'other-vendor-fixture' };
  const { database } = buildCatalog(upstream, asOf);
  for (const id of ['glm-hosted-fixture', 'doubao-seed-evolving', 'doubao-seed-character-260628',
    'grok-image-fixture', 'grok-video-fixture', 'gemini-audio-fixture', 'other-vendor-fixture']) {
    if(reviewed[id]) assert.equal(database.models[id].source,reviewed[id].source);
    else assert.equal(database.models[id], undefined, id);
  }
  assert.ok(database.models['doubao-fixture']);
  assert.ok(database.models['qwen-fixture']);
  assert.ok(database.models['xai-fixture']);
});

test('equal source ceilings need verified input metadata or a disclosed initial output setting', () => {
  const upstream = upstreamFixture();
  const seed = upstream.openai.models['unverified-model-fixture'];
  upstream.moonshotai.models['kimi-k3'] = { ...seed, id: 'kimi-k3', limit: { context: 1048576, output: 1048576, input: 1234 } };
  upstream.xai.models['grok-4.7'] = { ...seed, id: 'grok-4.7', limit: { context: 500000, output: 500000, input: 500000 } };
  upstream.openai.models['small-ceiling-fixture'] = { ...seed, id: 'small-ceiling-fixture', limit: { context: 8192, output: 8192 } };
  upstream.openai.models['excess-output-fixture'] = { ...seed, id: 'excess-output-fixture', limit: { context: 64000, output: 64001 } };
  const { database, excludedCeilings } = buildCatalog(upstream, asOf);
  assert.equal(database.models['kimi-k3'].maxInputTokens, 1048575, 'Unchecked community input must not override the primary rule');
  assert.equal(database.models['kimi-k3'].maxOutputTokens, 1048576);
  assert.equal(database.models['grok-4.7'].maxInputTokens, undefined, 'Unchecked community input is not silently trusted');
  assert.equal(database.models['grok-4.7'].maxOutputTokens, 16000);
  assert.match(database.models['grok-4.7'].source, /未公布|unverified|not.*maximum/);
  assert.deepEqual(excludedCeilings.map(item => item.id).sort(), ['excess-output-fixture', 'small-ceiling-fixture']);
  assert.doesNotThrow(() => validateDatabase(database));
});

test('offline checks reject invented input ceilings and invalid equal-ceiling presets', () => {
  const invented = structuredClone(catalog);
  invented.models['grok-4.7'].maxInputTokens = 500000;
  assert.throws(() => validate(invented, asOf), /grok-4\.7: input ceiling requires checked primary metadata/);
  const badKimi = structuredClone(catalog);
  badKimi.models['kimi-k3'].maxInputTokens = 1048576;
  assert.throws(() => validate(badKimi, asOf), /kimi-k3: checked input ceiling/);
  const missingInput = structuredClone(catalog);
  delete missingInput.models['kimi-k3'].maxInputTokens;
  assert.throws(() => validate(missingInput, asOf), /kimi-k3: equal output\/context ceilings require checked input metadata/);
  const missingSource = structuredClone(catalog);
  missingSource.models['kimi-k3'].source = 'models.dev community catalog';
  assert.throws(() => validate(missingSource, asOf), /kimi-k3: reviewed source/);
  const overclaim = structuredClone(catalog);
  overclaim.models['kimi-k3'].verifiedAt = '2026-11-06';
  assert.throws(() => validate(overclaim, asOf), /kimi-k3: reviewed verifiedAt/);
});
