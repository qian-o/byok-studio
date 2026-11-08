const {test}=require('node:test');
const assert=require('node:assert/strict');
const policies=require('../scripts/catalog/pricing.json');
const catalog=require('../resources/catalog/models.json');
const context=require('../resources/shared/model-policy');
const {validateContextPricing}=require('../dist/core/configuration');
const {validate}=require('../scripts/catalog/update.cjs');

test('checked pricing is keyed by exact model ID with independent provenance',()=>{
  assert.equal(Object.keys(policies.models).length,182);
  for(const [id,policy]of Object.entries(policies.models)){
    assert.deepEqual(validateContextPricing(policy),policy,id);
    assert.deepEqual(catalog.models[id].contextPricing,policy,id);
    assert.equal(policy.checkedAt,'2026-11-08');
    assert.equal(policy.scope,'direct-api');
    assert.ok(policy.source.startsWith('https://'));
  }
  assert.equal(catalog.models['codex-auto-review'].contextPricing.kind,'unknown');
  for(const id of ['gpt-6-luna','GLM-5.3','kimi-k3'])assert.ok(catalog.models[id].contextPricing.rates,'Checked price bands for '+id);
  assert.equal(policies.models['gpt-6.1-sol-unpublished'],undefined,'Do not infer policy for unknown request IDs');
});
test('full input capacities and exact price cutoffs remain separate catalog facts',()=>{
  for(const id of ['gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-6-astra','gpt-6-sol','gpt-6.1-sol','gpt-6.1-terra']){
    assert.equal(context.inputCeiling(catalog.models[id]),922000,id);
    assert.deepEqual(catalog.models[id].contextPricing.thresholds,[272000]);
  }
  for(const id of ['grok-4.5','grok-4.6','grok-4.7']){
    assert.equal(context.inputCeiling(catalog.models[id]),499999);
    assert.deepEqual(catalog.models[id].contextPricing.thresholds,[199999]);
  }
  assert.equal(catalog.models['gemini-3.1-flash-lite-preview'].contextPricing.kind,'unknown');
});
test('offline catalog validation detects missing or fabricated pricing metadata without changing capability verification',()=>{
  validate(catalog,'2026-11-08');
  const altered=structuredClone(catalog);altered.models['grok-4.7'].contextPricing.thresholds=[200000];
  assert.throws(()=>validate(altered,'2026-11-08'),/context pricing must match/);
  const missing=structuredClone(catalog);delete missing.models['gemini-4-argon'].contextPricing;
  assert.throws(()=>validate(missing,'2026-11-08'),/context pricing must match/);
  assert.equal(catalog.models['grok-4.7'].verifiedAt,null,'Pricing check does not verify an unpublished output ceiling');
  assert.equal(catalog.models['gpt-5.6-sol'].verifiedAt,'2026-11-08');
});
