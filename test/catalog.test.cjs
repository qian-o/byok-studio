const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {validateDatabase,validateCatalogSnapshot}=require('../dist/core/configuration');
const {StudioStore}=require('../dist/core/store');
const {compileOfficialGroup}=require('../dist/core/officialConfig');
const snapshot=require('../resources/catalog/models.json');
const catalog=snapshot.database;

test('the bundled offline catalog contains compact validated models.dev presets',()=>{
  assert.equal(snapshot.source,'models.dev');
  assert.equal(new Date(snapshot.updatedAt).toISOString(),snapshot.updatedAt);
  assert.equal(Object.keys(catalog.models).length,1612);
  assert.deepEqual(validateDatabase(catalog),catalog);
  for(const [id,model] of Object.entries(catalog.models)){
    assert.ok(model.name,id);
    for(const key of ['source','verifiedAt','contextPricing','reasoningControls','chatCompletionOptions','maxInputTokens','defaultOutputTokens','contextWindowMode'])assert.equal(Object.hasOwn(model,key),false,`${id}: ${key}`);
    assert.ok(model.maxOutputTokens>0&&model.maxOutputTokens<model.contextWindow,id);
  }
});

test('all bundled catalog entries produce valid native allocations for all protocols',()=>{
  const models=Object.keys(catalog.models).map(id=>({id,name:'',discoveredName:'',overrides:{}}));
  for(const apiType of ['responses','chatCompletions','messages']){
    const group=compileOfficialGroup({id:'fixture',name:'Fixture',apiType,url:'https://example.test/v1',enabled:true,models},catalog);
    assert.deepEqual(group.models.map(m=>m.id),models.map(m=>m.id));
    for(const model of group.models){
      assert.ok(model.contextWindow>0&&model.maxOutputTokens>0,model.id);
      for(const key of ['zeroDataRetentionEnabled','statefulResponses'])assert.equal(Object.hasOwn(model,key),false,model.id);
      assert.equal(model.maxOutputTokens,catalog.models[model.id].maxOutputTokens,model.id);
      assert.equal(model.contextWindow,catalog.models[model.id].contextWindow,model.id);
      assert.equal(Object.hasOwn(model,'maxInputTokens'),false,model.id);
    }
  }
});

test('catalog maintenance has one source converter and preserves upstream license attribution',()=>{
  const script=fs.readFileSync(path.join(__dirname,'../scripts/catalog/update.cjs'),'utf8');
  assert.match(script,/modelCatalog/);
  for(const obsolete of ['generation.json','overrides.json','pricing.json','release-dates.json'])assert.equal(fs.existsSync(path.join(__dirname,'../scripts/catalog',obsolete)),false);
  const notice=fs.readFileSync(path.join(__dirname,'../THIRD_PARTY_NOTICES.txt'),'utf8');
  assert.match(notice,/Copyright \(c\) 2025 models.dev/);
  assert.match(notice,/MIT License/);
});

test('reading bundled presets never creates local state or writes keys',async()=>{
  const store=new StudioStore({get:()=>undefined,update:async()=>assert.fail('Reading presets wrote state')},
    {get:async()=>undefined,store:async()=>assert.fail('Key written'),delete:async()=>assert.fail('Key deleted')},catalog,()=>assert.fail('State changed'));
  const ui=await store.uiState();
  assert.deepEqual(ui.database,catalog);assert.equal(ui.revision,0);assert.deepEqual(store.snapshot(),{version:1,providers:[]});
  assert.equal(store.updateCatalog,undefined);
  ui.database.defaults.contextWindow=2;
  assert.deepEqual(store.database(),catalog);
});

test('loading a saved catalog preserves it without replacing it with the newer release snapshot',async()=>{
  const saved={version:1,providers:[],catalog:structuredClone(snapshot)};
  saved.catalog.updatedAt='2026-01-01T00:00:00Z';saved.catalog.database.defaults.contextWindow=256000;
  const before=structuredClone(saved);
  const store=new StudioStore({get:()=>saved,update:async()=>assert.fail('Catalog was replaced')},{get:async()=>undefined},catalog,()=>{});
  assert.equal((await store.uiState()).database.defaults.contextWindow,256000);
  assert.deepEqual(store.snapshot().catalog,before.catalog);assert.deepEqual(saved,before);
});

test('snapshot validation rejects malformed timestamps, sources and unsupported protocol fields',()=>{
  for(const updatedAt of ['2026-02-30T00:00:00Z','2026-01-01','2026-01-01T00:00:00+01:00',null]){
    assert.throws(()=>validateCatalogSnapshot({...snapshot,updatedAt}));
  }
  assert.equal(validateCatalogSnapshot({...snapshot,updatedAt:'2026-01-01T00:00:00Z'}).updatedAt,'2026-01-01T00:00:00Z');
  assert.throws(()=>validateCatalogSnapshot({...snapshot,source:'other'}));
  const bad=structuredClone(snapshot);bad.database.defaults.protocols={responses:{parameters:{headers:{authorization:'secret'}}}};
  assert.throws(()=>validateCatalogSnapshot(bad));
});
