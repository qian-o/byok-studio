const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validDate}=require('../resources/shared/model-policy.js');
const {validateDatabase,validateProvider}=require('../dist/core/configuration');
const {StudioStore}=require('../dist/core/store');
const parameters={name:'',contextWindow:128000,maxOutputTokens:16000,toolCalling:false,vision:false,thinking:false,supportsReasoningEffort:[],source:'test',verifiedAt:null};
const model=id=>({id,name:'',discoveredName:'',overrides:{}});
const records={old:{...parameters,releaseDate:'2024-01-15'},new:{...parameters,releaseDate:'2026-09-01'},same:{...parameters,releaseDate:'2026-09-01'},unknown:{...parameters,verifiedAt:'2026-11-08'}};
const database=()=>({schemaVersion:1,defaults:{...parameters},models:structuredClone(records)});
const ids=items=>items.map(item=>item.id);
const supplier=()=>({id:'supplier',name:'Gateway',apiType:'responses',url:'https://example.com/v1',enabled:true,zeroDataRetentionEnabled:false,models:['unknown','old','new','same'].map(model)});
test('model lists preserve provider order regardless of names or release dates',()=>{
  const input=supplier();input.models[1].name='Z custom name';
  assert.deepEqual(ids(validateProvider(input,database()).models),['unknown','old','new','same']);
});
test('date validation remains while removed legacy sorting preferences are discarded',()=>{
  assert.equal(validDate('2024-02-29'),true);assert.equal(validDate('2025-02-29'),false);assert.equal(validDate('2026-13-01'),false);
  for(const modelSort of [undefined,'newest','oldest','custom','alphabetical']){
    const old={...supplier(),modelSort};const normalized=validateProvider(old,database());
    assert.equal(Object.hasOwn(normalized,'modelSort'),false);assert.deepEqual(ids(normalized.models),ids(old.models));
  }
  assert.equal(validateDatabase(database()).models.old.releaseDate,'2024-01-15');
  const malformed=database();malformed.models.old.releaseDate='2026-02-30';assert.throws(()=>validateDatabase(malformed));
});
test('legacy sorting is removed on load; saved models and additions retain insertion order',async()=>{
  for(const mode of ['oldest','custom']){
    const old={...supplier(),modelSort:mode};old.models[1].name='Preserved Name';old.models[1].overrides={maxOutputTokens:4096};
    const saved=new Map([['byokStudio.state.v1',{version:1,providers:[old],database:database()}]]);
    const keys={get:async()=> 'existing-key',store:async()=>{throw Error('Must not rewrite secrets');},delete:async()=>{throw Error('Must not delete secrets');}};
    const storage={get:key=>saved.get(key),update:async(key,value)=>saved.set(key,structuredClone(value))};
    const store=new StudioStore(storage,keys,database(),()=>{});
    await store.uiState();
    assert.equal(Object.hasOwn(saved.get('byokStudio.state.v1').providers[0],'modelSort'),false);
    assert.equal(await store.key(old.id),'existing-key');
    const restored=new StudioStore(storage,keys,database(),()=>{});
    const draft=restored.snapshot().providers[0];
    assert.equal(draft.models[1].name,'Preserved Name');assert.equal(draft.models[1].overrides.maxOutputTokens,4096);
    assert.deepEqual(ids(draft.models),['unknown','old','new','same']);
    draft.models.push(model('added'));await restored.saveProvider(draft);
    assert.deepEqual(ids(restored.snapshot().providers[0].models),['unknown','old','new','same','added']);
  }
});
test('release date migration fills absent dates without overwriting edits or restoring removed entries',async()=>{
  const original=database();delete original.models.old.releaseDate;original.models.new.releaseDate=null;original.models.same.releaseDate='2026-01-01';delete original.models.unknown;
  const state={version:1,providers:[{...supplier(),modelSort:'custom'}],database:original};const values=new Map([['byokStudio.state.v1',state]]);
  const storage={get:key=>values.get(key),update:async(key,value)=>values.set(key,structuredClone(value))};
  const secrets={get:async()=>undefined,store:async()=>{},delete:async()=>{}};
  const store=new StudioStore(storage,secrets,database(),()=>{});
  await store.applyReleaseDates('dates',database());
  assert.equal(store.snapshot().database.models.old.releaseDate,'2024-01-15');
  assert.equal(store.snapshot().database.models.new.releaseDate,null);
  assert.equal(store.snapshot().database.models.same.releaseDate,'2026-01-01');
  assert.equal(Object.hasOwn(store.snapshot().database.models,'unknown'),false);
  const changed=store.snapshot().database;changed.models.old.releaseDate=null;await store.saveDatabase(changed);
  const reloaded=new StudioStore(storage,secrets,database(),()=>{});await reloaded.applyReleaseDates('dates',database());
  assert.equal(reloaded.snapshot().database.models.old.releaseDate,null);
});
