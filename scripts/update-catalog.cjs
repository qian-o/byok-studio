'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const CONTEXT_PRICING = require('../data/context-pricing.json').models;
const DISPLAY_NAMES = require('../data/model-display-names.json');
const REVIEWED_MODELS = require('../data/official-model-overrides.json').models;

const ROOT = path.resolve(__dirname, '..');
const generation = require('../data/catalog-generation.json');
const { API_URL, CHECKED_ON, UPDATED_ON, PROVIDERS, REQUIRED_MODEL_IDS, ALIAS_NOTES, KNOWN_CONFLICTS, DEFAULTS, REQUESTED_MODELS, OFFICIAL_MODELS, OFFICIAL_PROVIDERS, INPUT_SOURCES, EFFORT_SOURCES } = generation;
const ADDITIONAL_ONLY = new Set(generation.ADDITIONAL_ONLY);

function effortProvenance(reference) {
  return `reasoning-effort values only checked ${reference.checkedOn ?? CHECKED_ON}: ${reference.url}`;
}

function inputProvenance(reference) {
  return `input ceiling only checked ${reference.checkedOn}: ${reference.url}; exact context: ${reference.contextUrl}; ${reference.quote}`;
}

function outputFallbackProvenance(context, output) {
  return `; unverified initial output setting: maxOutputTokens=${DEFAULTS.maxOutputTokens} is an editable request default, not the provider maximum; models.dev reports context=${context}, output=${output}, but a separate numeric input ceiling is not verified`;
}

function isCalendarDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value.slice(0, 4) !== '0000' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function releaseDateFrom(model, asOf) {
  return isCalendarDate(model?.release_date) && model.release_date <= asOf ? model.release_date : undefined;
}

function releaseDateProvenance(provider) {
  return `release date only: models.dev community catalog (first-party provider: ${provider}): ${API_URL} (not officially verified)`;
}

function localCalendarDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function validate(database, asOf = localCalendarDate()) {
  assert(isCalendarDate(asOf), 'Invalid release-date cutoff');
  assert.deepEqual(Object.keys(database).sort(), ['defaults', 'models', 'schemaVersion']);
  assert.equal(database.schemaVersion, 1);
  const { releaseDate: defaultReleaseDate, ...defaults } = database.defaults;
  assert(defaultReleaseDate === undefined || defaultReleaseDate === null, 'Defaults must not supply a release date');
  assert.deepEqual(defaults, DEFAULTS);
  assert(database.models && typeof database.models === 'object' && !Array.isArray(database.models));
  assert(Object.keys(database.models).length > 0, 'The model catalog must not be empty');
  for (const id of REQUIRED_MODEL_IDS) assert(Object.hasOwn(database.models, id), `${id}: missing required exact ID`);
  for (const [id, model] of Object.entries(database.models)) {
    assert(id.length > 0 && id === id.trim(), `Invalid exact model ID: ${id}`);
    assert.deepEqual(Object.keys(model).filter(key => !['releaseDate', 'maxInputTokens', 'contextPricing', 'defaultOutputTokens', 'aliasOf', 'reasoningControls', 'chatCompletionOptions', 'contextWindowMode'].includes(key)).sort(), Object.keys(DEFAULTS).sort(), `${id}: parameter keys`);
    assert.deepEqual(model.contextPricing, CONTEXT_PRICING[id], `${id}: context pricing must match the independently checked policy`);
    if (model.contextPricing) {
      assert((model.contextPricing.kind === 'unknown' && model.contextPricing.checkedAt === null) || (isCalendarDate(model.contextPricing.checkedAt) && model.contextPricing.checkedAt <= asOf), `${id}: context pricing check date`);
      assert(['tiered','flat','unknown'].includes(model.contextPricing.kind), `${id}: context pricing kind`);
      assert.equal(model.contextPricing.scope, 'direct-api', `${id}: bundled pricing scope`);
      assert(model.contextPricing.source.startsWith('https://'), `${id}: primary pricing source`);
      assert(model.contextPricing.kind !== 'tiered' || model.contextPricing.thresholds.length > 0, `${id}: missing pricing thresholds`);
      assert(model.contextPricing.kind === 'tiered' || model.contextPricing.thresholds.length === 0, `${id}: unexpected pricing thresholds`);
      assert(model.contextPricing.thresholds.every(value => Number.isSafeInteger(value) && value > 0), `${id}: pricing thresholds`);
    }
    assert(model.releaseDate === undefined || model.releaseDate === null
      || (isCalendarDate(model.releaseDate) && model.releaseDate <= asOf), `${id}: invalid or future release date`);
    assert.equal(typeof model.name, 'string', `${id}: name`);
    assert(model.name.length > 0, `${id}: missing display name`);
    if (Object.hasOwn(DISPLAY_NAMES, id)) assert.equal(model.name, DISPLAY_NAMES[id], `${id}: curated display name`);
    for (const key of ['contextWindow', 'maxOutputTokens']) {
      assert(Number.isSafeInteger(model[key]) && model[key] > 0, `${id}: ${key}`);
    }
    assert(model.contextWindowMode === 'input' || model.maxOutputTokens <= model.contextWindow, `${id}: output exceeds context ceiling`);
    if (model.maxInputTokens !== undefined) {
      assert(Number.isSafeInteger(model.maxInputTokens) && model.maxInputTokens > 0
        && model.maxInputTokens <= model.contextWindow, `${id}: input ceiling`);
      const input = INPUT_SOURCES.find(reference => reference.ids.includes(id));
      const reviewed = REVIEWED_MODELS[id];
      assert(input || reviewed?.maxInputTokens, `${id}: input ceiling requires checked primary metadata`);
      assert.equal(model.maxInputTokens, reviewed?.maxInputTokens ?? input.maxInputTokens, `${id}: checked input ceiling`);
      assert.equal(model.contextWindow, reviewed?.contextWindow ?? input.contextWindow, `${id}: checked input context`);
      if (!reviewed) assert(model.source.includes(inputProvenance(input)), `${id}: missing checked input provenance`);
    }
    assert(model.contextWindowMode === 'input' || model.maxOutputTokens < model.contextWindow || model.maxInputTokens !== undefined,
      `${id}: equal output/context ceilings require checked input metadata`);
    if (model.source.includes('; unverified initial output setting:')) {
      assert.equal(model.maxOutputTokens, DEFAULTS.maxOutputTokens, `${id}: initial output setting`);
      assert(model.source.includes(outputFallbackProvenance(model.contextWindow, model.contextWindow)), `${id}: missing initial-output provenance`);
    }
    for (const key of ['toolCalling', 'vision', 'thinking']) {
      assert.equal(typeof model[key], 'boolean', `${id}: ${key}`);
    }
    assert(Array.isArray(model.supportsReasoningEffort), `${id}: effort list`);
    assert(model.supportsReasoningEffort.every(value => typeof value === 'string' && value.length > 0));
    assert.equal(new Set(model.supportsReasoningEffort).size, model.supportsReasoningEffort.length);
    assert.equal(typeof model.source, 'string', `${id}: source`);
    assert(model.source.length > 0, `${id}: missing provenance`);
    assert(model.verifiedAt === null || (
      typeof model.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(model.verifiedAt)
      && !Number.isNaN(Date.parse(model.verifiedAt))
    ), `${id}: verification date`);
    const reviewed = REVIEWED_MODELS[id];
    if (reviewed) {
      for (const [field, value] of Object.entries(reviewed)) assert.deepEqual(model[field], value, `${id}: reviewed ${field}`);
      assert(model.source.includes('https://'), `${id}: reviewed primary source`);
      if (model.defaultOutputTokens !== undefined) assert(Number.isSafeInteger(model.defaultOutputTokens) && model.defaultOutputTokens > 0 && model.defaultOutputTokens <= model.maxOutputTokens && model.defaultOutputTokens < model.contextWindow, `${id}: output reservation`);
      continue;
    }
    const official = OFFICIAL_MODELS[id];
    const effort = EFFORT_SOURCES.find(reference => reference.ids.includes(id));
    assert.deepEqual(model.supportsReasoningEffort, effort?.values ?? official?.supportsReasoningEffort ?? [],
      `${id}: effort values must come from a checked primary source`);
    assert.equal(model.verifiedAt, official?.verifiedAt ?? null, `${id}: unverified community metadata`);
    if (official) {
      const { releaseDate, contextPricing, ...capabilities } = model;
      const source = official.source + (releaseDate ? `; ${releaseDateProvenance(OFFICIAL_PROVIDERS[id])}` : '');
      assert.deepEqual(capabilities, { ...official, source }, `${id}: primary-source capabilities and release-date provenance`);
    } else if (effort) assert(model.source.includes(effortProvenance(effort)), `${id}: missing checked effort provenance`);
  }
}

function buildCatalog(upstream, asOf) {
  assert(isCalendarDate(asOf), 'Invalid release-date cutoff');
  const models = {};
  const counts = new Map();
  const skipped = new Map();
  const excludedCeilings = [];
  for (const [provider] of PROVIDERS) {
    const entries = upstream[provider]?.models;
    assert(entries && typeof entries === 'object' && !Array.isArray(entries), `Missing provider: ${provider}`);
    let added = 0;
    let excluded = 0;
    let candidates = 0;
    for (const [id, model] of Object.entries(entries)) {
      assert.equal(model.id, id, `${provider}/${id}: source ID mismatch`);
      const eligible = model.modalities?.input?.includes('text')
        && model.modalities?.output?.length === 1 && model.modalities.output[0] === 'text'
        && !new RegExp(generation.excludeIdPattern, 'i').test(id)
        && (!generation.providerFilters[provider] || new RegExp(generation.providerFilters[provider], 'i').test(id))
        && !Object.hasOwn(KNOWN_CONFLICTS, id)
        && Number.isSafeInteger(model.limit?.context) && model.limit.context > 0
        && Number.isSafeInteger(model.limit?.output) && model.limit.output > 0;
      const future = isCalendarDate(model.release_date) && model.release_date > asOf;
      if (!eligible || future || Object.hasOwn(models, id)) {
        excluded += 1;
        continue;
      }
      candidates += 1;
      if (model.limit.output > model.limit.context) {
        excludedCeilings.push({ provider, id, context: model.limit.context, output: model.limit.output });
        excluded += 1;
        continue;
      }
      assert.equal(typeof model.name, 'string', `${provider}/${id}: missing name`);
      const effort = EFFORT_SOURCES.find(reference => reference.ids.includes(id));
      const input = INPUT_SOURCES.find(reference => reference.ids.includes(id));
      if (input) assert.equal(model.limit.context, input.contextWindow, `${id}: review changed input/context metadata`);
      const initialOutput = !input && model.limit.output === model.limit.context;
      if (initialOutput && DEFAULTS.maxOutputTokens >= model.limit.context) {
        excludedCeilings.push({ provider, id, context: model.limit.context, output: model.limit.output,
          reason: 'No checked input ceiling, and the initial output setting does not fit context' });
        excluded += 1;
        continue;
      }
      const releaseDate = releaseDateFrom(model, asOf);
      models[id] = {
        name: model.name,
        contextWindow: model.limit.context,
        maxOutputTokens: initialOutput ? DEFAULTS.maxOutputTokens : model.limit.output,
        ...(input ? { maxInputTokens: input.maxInputTokens } : {}),
        toolCalling: model.tool_call === true,
        vision: model.modalities.input.includes('image'),
        thinking: model.reasoning === true,
        supportsReasoningEffort: effort ? [...effort.values] : [],
        source: `models.dev community catalog (first-party provider: ${provider}): ${API_URL}`
          + (effort ? `; ${effortProvenance(effort)}` : '')
          + (input ? `; ${inputProvenance(input)}` : '')
          + (initialOutput ? outputFallbackProvenance(model.limit.context, model.limit.output) : ''),
        verifiedAt: null,
        ...(releaseDate ? { releaseDate } : {}),
      };
      added += 1;
    }
    assert(candidates > 0 || ADDITIONAL_ONLY.has(provider), `No candidate models for ${provider}; review upstream changes`);
    counts.set(provider, added);
    skipped.set(provider, excluded);
  }
  for (const [id, model] of Object.entries(OFFICIAL_MODELS)) {
    const provider = OFFICIAL_PROVIDERS[id];
    if (!Object.hasOwn(models, id)) counts.set(provider, counts.get(provider) + 1);
    const upstreamModel = upstream[provider].models[id];
    const releaseDate = upstreamModel?.id === id ? releaseDateFrom(upstreamModel, asOf) : undefined;
    models[id] = {
      ...model,
      ...(releaseDate ? { releaseDate, source: `${model.source}; ${releaseDateProvenance(provider)}` } : {}),
    };
  }
  for (const [id, model] of Object.entries(REQUESTED_MODELS)) {
    if (Object.hasOwn(models, id)) continue;
    const effort = EFFORT_SOURCES.find(reference => reference.ids.includes(id));
    models[id] = {
      ...model,
      ...(effort ? {
        thinking: true,
        supportsReasoningEffort: [...effort.values],
        source: `${model.source}; ${effortProvenance(effort)}`,
      } : {}),
    };
  }
  for (const [id, reviewed] of Object.entries(REVIEWED_MODELS)) {
    models[id] = { ...(models[id] ?? {}), ...structuredClone(reviewed) };
  }
  for (const [id, name] of Object.entries(DISPLAY_NAMES)) if (Object.hasOwn(models, id)) models[id].name = name;
  for (const [id, pricing] of Object.entries(CONTEXT_PRICING)) if (Object.hasOwn(models, id)) models[id].contextPricing = structuredClone(pricing);
  const database = {
    schemaVersion: 1,
    defaults: DEFAULTS,
    models: Object.fromEntries(Object.entries(models).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
  };
  validate(database, asOf);
  return { database, counts, skipped, excludedCeilings };
}

function sourceDocument(database, counts, skipped, excludedCeilings, retrievedAt, digest) {
  const entries = Object.entries(database.models);
  const total = entries.length;
  const verified = entries.filter(([, model]) => model.verifiedAt !== null).length;
  const releaseDates = entries.filter(([, model]) => model.releaseDate != null).length;
  const mappedAliases = entries.filter(([, model]) => model.aliasOf !== undefined);
  const reviewedRows = Object.entries(REVIEWED_MODELS).map(([id, model]) => `| \`${id}\` | ${model.contextWindow} | ${model.maxOutputTokens} | ${model.defaultOutputTokens ?? 'bounded by remaining context'} | ${model.supportsReasoningEffort.join(', ') || 'budget / server default; see source'} | ${model.aliasOf ? `preset from \`${model.aliasOf}\`` : model.verifiedAt ? 'official' : 'partially verified; see source'} |`).join('\n');
  const effortRows = EFFORT_SOURCES.map(reference =>
    `| ${reference.ids.map(id => `\`${id}\``).join(', ')} | ${reference.checkedOn ?? CHECKED_ON} | [Primary source](${reference.url}) | ${reference.quote ?? reference.values.join(' / ')} |`).join('\n');
  const rows = PROVIDERS.map(([id, name]) => `| ${name} | \`${id}\` |`).join('\n');
  const conflictRows = Object.entries(KNOWN_CONFLICTS).map(([id, reason]) => `- \`${id}\`: ${reason}.`).join('\n');
  return `# Bundled model catalog sources

This catalog is a metadata snapshot, not a guarantee of availability on a proxy. Request IDs remain exact and unchanged. Display names never identify or route a model.

## Snapshot

- Community snapshot retrieved: ${retrievedAt}; source: ${API_URL}; SHA-256: ${digest}.
- Catalog: ${total} exact IDs; ${verified} records carry a complete verification date; ${mappedAliases.length} explicit alias presets.
- Coverage: **${releaseDates} known release dates**; **${total - releaseDates} unknown dates**. These are not model verification dates. An absent release date is unknown. Its release date is not officially verified solely by catalog retrieval.
- Every exact catalog ID is accounted for in [catalog-audit.json](catalog-audit.json). Read its field evidence, uncertainty and lifecycle together with the model source; partial verification is not a claim of fully verified limits.

## Declarative configuration

[official-model-overrides.json](official-model-overrides.json) holds checked model facts; [model-rules.json](model-rules.json) holds routing recommendations and non-chat exclusions; [catalog-generation.json](catalog-generation.json) holds source-selection and historical evidence. Runtime code interprets protocol configuration without recognizing model IDs or manufacturers.

Physical output capacity is distinct from the default generation budget. Native input and output reservations must fit together, even for models whose independently documented output capacity equals the whole window. Unknown physical limits remain labeled rather than inferred from a model name.

| Request ID | Context | Output ceiling / disclosed starting limit | Default output budget | Effort enum | Provenance |
| --- | ---: | ---: | --- | --- | --- |
${reviewedRows}

## Context pricing

[context-pricing.json](context-pricing.json) contains input ceilings inclusive of the lower price band, optional output-dependent bands, currency, rates per million tokens, sources and dates. Null is an open-ended last band. Service tiers, time-of-day tariffs, promotions, cache duration and region are separate from context-length tiers and are described in each policy. Unknown is never treated as flat. Original API prices need not match a proxy's prices.

## Source selection

Only text-input/text-output models from the configured sources are eligible. Explicit ID filters, exclusions and source precedence are data. Removed or retired IDs can remain as proxy presets with honest lifecycle information. No request ID is rewritten. An absent effort enum may mean budget/toggle control or missing evidence; consult the declared controls.

| Source | Source key |
| --- | --- |
${rows}

Historical required-ID evidence (superseded by a later explicit audit):

| Exact IDs | Checked on | Source | Values / evidence |
| --- | --- | --- | --- |
${effortRows}

Historical source conflicts remain explicit in the generation rules:

${conflictRows}

## Maintenance

Run \`node scripts/update-catalog.cjs --check\` after a catalog change. Generation never changes the user's stored database. Installed upgrades use declarative migration records and preserve manual model settings. Dates are recorded only when explicitly present; unknown/future dates are not invented from IDs.
`;

}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    const database = JSON.parse(await readFile(path.join(ROOT, 'data', 'model-parameters.json'), 'utf8'));
    validate(database);
    console.log(`Validated ${Object.keys(database.models).length} model entries (schemaVersion 1).`);
    return;
  }
  assert.equal(args.length, 0, 'Usage: node scripts/update-catalog.cjs [--check]');
  const response = await fetch(API_URL, { signal: AbortSignal.timeout(30000) });
  assert(response.ok, `models.dev returned HTTP ${response.status}`);
  const raw = await response.text();
  const retrievedAt = new Date().toISOString();
  const { database, counts, skipped, excludedCeilings } = buildCatalog(JSON.parse(raw), localCalendarDate());
  const digest = createHash('sha256').update(raw).digest('hex');
  const sources = sourceDocument(database, counts, skipped, excludedCeilings, retrievedAt, digest);
  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(path.join(ROOT, 'data', 'model-parameters.json'), JSON.stringify(database, null, 2) + '\n', 'utf8');
  await writeFile(path.join(ROOT, 'data', 'SOURCES.md'), sources, 'utf8');
  console.log(`Updated ${Object.keys(database.models).length} models: ${[...counts].map(([id, count]) => `${id}=${count}`).join(', ')}`);
}

module.exports = { buildCatalog, sourceDocument, validate };

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
