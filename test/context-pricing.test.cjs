const { test } = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../resources/shared/model-policy');
const { validateParameters, validateContextPricing } = require('../dist/core/configuration');
const { StudioStore } = require('../dist/core/store');
const { compileOfficialModel } = require('../dist/core/officialConfig');
const base = {name:'Model',contextWindow:1050000,maxOutputTokens:128000,toolCalling:true,vision:true,thinking:true,supportsReasoningEffort:[],source:'test',verifiedAt:null};
const policy = (thresholds=[200000]) => ({kind:'tiered',scope:'direct-api',thresholds,source:'https://example.test/pricing',checkedAt:'2026-11-08',note:'Only requests above the inclusive input threshold use a higher rate.'});

test('maximum input capacity is independent of pricing tiers and preserves separate input semantics',()=>{
  for(const threshold of [128000,200000,272000]){
    const model={...base,contextPricing:policy([threshold])};
    assert.equal(shared.inputCeiling(model),1049999);
    assert.deepEqual(validateParameters(model).contextPricing.thresholds,[threshold]);
  }
  assert.equal(shared.inputCeiling({...base,contextWindowMode:'input'}),1050000);
  assert.equal(shared.inputCeiling({...base,maxInputTokens:922000}),922000);
});
test('official model configuration uses full capacity even with a retired saved budget',()=>{
  const parameters={...base,contextPricing:policy([200000])};
  const database={schemaVersion:1,defaults:base,models:{fixture:parameters}};
  const supplier={id:'fixture',name:'Fixture',apiType:'responses',url:'https://example.test/v1',enabled:true,models:[]};
  const model={id:'fixture',name:'',discoveredName:'',overrides:{}};
  const full=compileOfficialModel(supplier,database,model);
  assert.equal(full.maxInputTokens,922000);
  assert.equal(full.maxInputTokens+full.maxOutputTokens,parameters.contextWindow);
  assert.deepEqual(compileOfficialModel(supplier,database,{...model,contextSize:200000}),full);
  assert.deepEqual(compileOfficialModel(supplier,database,{...model,contextSize:64000}),full);
  assert.equal(compileOfficialModel(supplier,database,{...model,contextSize:1049999}).maxInputTokens,922000,'The native allocation also reserves the configured output budget');
});
test('pricing metadata validates sources, thresholds and complete rate coverage',()=>{
  assert.deepEqual(validateContextPricing(policy([272000,200000])).thresholds,[200000,272000]);
  assert.deepEqual(validateParameters({...base,contextPricing:policy()}).contextPricing,policy());
  for(const invalid of [{...policy(),kind:'fake'},{...policy(),scope:'api'},{...policy(),thresholds:[]},{...policy(),thresholds:[0]},{...policy(),thresholds:[1.5]},{...policy(),thresholds:[200000,200000]},{...policy(),source:''},{...policy(),checkedAt:'2026-02-30'},{...policy(),kind:'flat'}])assert.throws(()=>validateContextPricing(invalid));
  const low={inputUpTo:200000,input:1,output:3},high={inputUpTo:null,input:2,output:5};
  const rates={currency:'USD',perTokens:1000000,bands:[low,high]};
  assert.doesNotThrow(()=>validateContextPricing({...policy(),rates}));
  for(const bands of [[low],[high],[low,low,high],[{...low,outputUpTo:1000},high]])assert.throws(()=>validateContextPricing({...policy(),rates:{...rates,bands}}));
});
test('pricing metadata merges once without overwriting policies and retired budgets are discarded',async()=>{
  const database={schemaVersion:1,defaults:{...base,name:''},models:{model:{...base},custom:{...base,contextPricing:{...policy([]),kind:'flat',scope:'custom'}},removed:{...base}}};
  const provider={id:'gateway',name:'Gateway',apiType:'responses',url:'https://example.test/v1',enabled:true,models:[{id:'model',name:'Named',discoveredName:'',overrides:{maxOutputTokens:4096},contextSize:1049999}]};
  const values=new Map([['byokStudio.state.v1',{version:1,database,providers:[provider]}]]);
  const store=new StudioStore({get:key=>values.get(key),update:async(key,value)=>values.set(key,structuredClone(value))},{get:async()=>undefined,store:async()=>{},delete:async()=>{}},database,()=>{});
  const seed=structuredClone(database);for(const model of Object.values(seed.models))model.contextPricing=policy([200000]);
  const edited=store.snapshot().database;delete edited.models.removed;await store.saveDatabase(edited);
  await store.applyContextPricing('pricing-update',seed);
  assert.equal(store.snapshot().database.models.model.contextPricing.kind,'tiered');
  assert.equal(store.snapshot().database.models.custom.contextPricing.kind,'flat');
  assert.equal(Object.hasOwn(store.snapshot().database.models,'removed'),false);
  assert.equal(Object.hasOwn(store.snapshot().providers[0].models[0],'contextSize'),false);
  assert.equal(store.snapshot().providers[0].models[0].overrides.maxOutputTokens,4096);
  const cleared=store.snapshot().database;cleared.models.model.contextPricing={...policy([]),kind:'unknown',source:'',checkedAt:null};await store.saveDatabase(cleared);
  await store.applyContextPricing('pricing-update',seed);
  assert.equal(store.snapshot().database.models.model.contextPricing.kind,'unknown');
});
