require('../media/i18n').setLocale('zh-CN');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDatabase, validateProvider, effectiveParameters, modelName, validateUrl } = require('../dist/core/configuration');
const { StudioStore } = require('../dist/core/store');
const defaults = { name:'',contextWindow:128000,maxOutputTokens:16000,toolCalling:false,vision:false,thinking:false,supportsReasoningEffort:[],source:'test',verifiedAt:null };
const database = () => ({schemaVersion:1,defaults:{...defaults},models:{'request-id':{...defaults,name:'Friendly Name',contextWindow:1000000,maxOutputTokens:128000,toolCalling:true}}});
const model = (id='request-id') => ({id,name:'',discoveredName:'',overrides:{}});
const provider = (id='provider-one') => ({id,name:'Gateway',apiType:'responses',url:'https://gateway.example/v1',enabled:true,zeroDataRetentionEnabled:false,models:[model()]});
const STATE_KEY = 'byokStudio.state.v1';
function savedModel(store,providerId,modelId){const state=store.snapshot();const provider=state.providers.find(p=>p.id===providerId);const model=provider.models.find(m=>m.id===modelId);return {provider,model,parameters:effectiveParameters(state.database,model)};}
function storage(saved) {
  const data = new Map(saved ? [[STATE_KEY, structuredClone(saved)]] : []), keys = new Map();
  let fail=false, changes=0;
  const global = { get:key=>data.get(key), update:async(key,value)=>{if(fail)throw Error('write failed');data.set(key,structuredClone(value));} };
  const secrets = {get:async key=>keys.get(key),store:async(key,value)=>{keys.set(key,value);},delete:async key=>{keys.delete(key);}};
  return {data,keys,global,secrets,get changes(){return changes;},set fail(value){fail=value;},store:new StudioStore(global,secrets,database(),()=>changes++)};
}
test('IDs, display names and initial parameters are independent',()=>{
  const db=validateDatabase(database());
  const item=model(); item.name='Custom Name'; item.overrides={maxOutputTokens:64000};
  assert.equal(modelName(db,item),'Custom Name');
  assert.equal(item.id,'request-id');
  assert.equal(effectiveParameters(db,item).maxOutputTokens,64000);
  assert.equal(effectiveParameters(db,model('request-id-suffix')).contextWindow,128000);
  const unknown=model('unknown'); unknown.discoveredName='Provider Friendly Name';
  assert.equal(modelName(db,unknown),'unknown');
  unknown.name='My Model'; assert.equal(modelName(db,unknown),'My Model');
  assert.equal(modelName(db,model('codex-auto-review')),'codex-auto-review');
});
test('configuration rejects invalid budgets, URLs and duplicate IDs',()=>{
  const db=database();
  assert.throws(()=>validateUrl('https://example.com/v1?key=secret'));
  assert.throws(()=>validateUrl('file:///tmp/models'));
  assert.throws(()=>validateDatabase({...db,defaults:{...defaults,maxOutputTokens:128000}}));
  const p=provider(); p.models.push(model());
  assert.throws(()=>validateProvider(p,db));
  p.models=[model('unknown')]; assert.equal(validateProvider(p,db).models[0].id,'unknown');
});
test('supplier ZDR migration requires unanimous legacy models unless a supplier boolean is explicit',()=>{
  const cases = [
    {label:'all true',flags:[true,true],expected:true},
    {label:'all false',flags:[false,false],expected:false},
    {label:'mixed',flags:[true,false],expected:false},
    {label:'missing model flag',flags:[true,undefined],expected:false},
    {label:'all missing',flags:[undefined,undefined],expected:false},
    {label:'truthy legacy value',flags:[true,'true'],expected:false},
    {label:'empty',flags:[],expected:false},
    {label:'legacy supplier true',flags:[false,false],legacy:true,expected:true},
    {label:'legacy supplier false',flags:[true,true],legacy:false,expected:false},
    {label:'invalid legacy supplier',flags:[false],legacy:'true',expected:false},
    {label:'explicit true',flags:[false,false],legacy:false,current:true,expected:true},
    {label:'explicit false',flags:[true,true],legacy:true,current:false,expected:false}
  ];
  for (const {label,flags,legacy,current,expected} of cases) {
    const input={...provider(),enabled:flags.length>0,zeroDataRetentionEnabled:current,zdr:legacy,models:flags.map((zdr,index)=>({...model(`model-${index}`),...(zdr===undefined?{}:{zdr})}))};
    const normalized=validateProvider(input,database());
    assert.equal(normalized.zeroDataRetentionEnabled,expected,label);
    assert.equal(Object.hasOwn(normalized,'zdr'),false,label);
    assert.ok(normalized.models.every(item=>!Object.hasOwn(item,'zdr')),label);
    assert.deepEqual(validateProvider(normalized,database()),normalized,label);
  }
  for (const invalid of [null,'true',1,{}]) assert.throws(()=>validateProvider({...provider(),zeroDataRetentionEnabled:invalid},database()),/布尔值/);
});
test('legacy state is persisted even when the startup catalog update is already applied',async()=>{
  const db=database();db.models['request-id'].thinking=true;db.models['request-id'].supportsReasoningEffort=['high'];
  const original={...provider(),name:'My Supplier',models:[{...model(),name:'My Model',discoveredName:'Endpoint Name',overrides:{maxOutputTokens:64000},reasoningEffort:'high',zdr:true},{...model('another'),zdr:true}]};
  delete original.zeroDataRetentionEnabled;
  const s=storage({version:1,providers:[original],database:db,appliedCatalogUpdates:['already-applied']});
  s.keys.set('byokStudio.provider.provider-one','existing-secret');
  await s.store.applyCatalogUpdate('already-applied',db,[]);
  const saved=s.data.get(STATE_KEY),normalized=saved.providers[0];
  assert.equal(normalized.zeroDataRetentionEnabled,true);
  assert.deepEqual(normalized.models,original.models.map(({zdr,...item})=>item));
  assert.equal(normalized.name,original.name);
  assert.deepEqual(saved.database,db);
  assert.deepEqual(saved.appliedCatalogUpdates,['already-applied']);
  assert.equal(Object.hasOwn(normalized,'zdr'),false);
  assert.equal(await s.store.key(original.id),'existing-secret');
  assert.ok(!JSON.stringify(saved).includes('existing-secret'));
  assert.equal(s.changes,0);
  s.fail=true;
  const reloaded=new StudioStore(s.global,s.secrets,database(),()=>{});
  assert.equal((await reloaded.uiState()).providers[0].zeroDataRetentionEnabled,true);
  assert.equal((await reloaded.uiState()).providers[0].hasKey,true);
});
test('migration persistence failures preserve saved state and secrets and can be retried',async()=>{
  const legacy={...provider(),zdr:true};delete legacy.zeroDataRetentionEnabled;
  const saved={version:1,providers:[legacy],database:database(),appliedCatalogUpdates:['existing']};
  const s=storage(saved);s.keys.set('byokStudio.provider.provider-one','original-key');s.fail=true;
  await assert.rejects(s.store.uiState(),/write failed/);
  await assert.rejects(s.store.saveProvider({...provider(),name:'Changed'},'replacement'),/write failed/);
  assert.deepEqual(s.data.get(STATE_KEY),saved);
  assert.equal(await s.store.key(legacy.id),'original-key');
  s.fail=false;
  await s.store.uiState();
  assert.equal(s.data.get(STATE_KEY).providers[0].zeroDataRetentionEnabled,true);
  assert.equal(Object.hasOwn(s.data.get(STATE_KEY).providers[0],'zdr'),false);
});
test('a pending migration cannot overwrite a concurrent supplier save',async()=>{
  const legacy={...provider(),models:[{...model(),zdr:true}]};delete legacy.zeroDataRetentionEnabled;
  const s=storage({version:1,providers:[legacy],database:database(),appliedCatalogUpdates:['existing']});
  const update=s.global.update;
  let release,started;
  const waiting=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{started=resolve;});
  let writes=0;
  s.global.update=async(key,value)=>{if(++writes===1){started();await waiting;}await update(key,value);};
  const migration=s.store.uiState();
  await entered;
  const save=s.store.saveProvider({...provider(),name:'Saved after migration'},'replacement');
  release();
  await Promise.all([migration,save]);
  const reloaded=new StudioStore(s.global,s.secrets,database(),()=>{});
  assert.equal(reloaded.snapshot().providers[0].name,'Saved after migration');
  assert.equal(reloaded.snapshot().providers[0].zeroDataRetentionEnabled,false);
  assert.deepEqual(reloaded.snapshot().appliedCatalogUpdates,['existing']);
  assert.equal(await reloaded.key(legacy.id),'replacement');
});
test('ZDR belongs to each supplier across all its models and survives saves and reloads',async()=>{
  const s=storage();
  const first={...provider('first'),zeroDataRetentionEnabled:true,models:[model(),model('other')]};
  const second={...provider('second'),models:[model(),model('other')]};
  await s.store.saveProvider(first);
  await s.store.saveProvider(second);
  for (const [id,expected] of [['first',true],['second',false]]) for (const requestId of ['request-id','other']) {
    const active=savedModel(s.store,id,requestId);
    assert.equal(active.provider.zeroDataRetentionEnabled,expected);
    assert.equal(Object.hasOwn(active.model,'zdr'),false);
  }
  const edited=s.store.snapshot().providers.find(item=>item.id==='first');
  edited.models[0].name='Renamed';edited.models.push(model('new-model'));
  await s.store.saveProvider(edited);
  let reloaded=new StudioStore(s.global,s.secrets,database(),()=>{});
  assert.equal(savedModel(reloaded,'first','new-model').provider.zeroDataRetentionEnabled,true);
  await reloaded.saveProvider({...edited,zeroDataRetentionEnabled:false});
  reloaded=new StudioStore(s.global,s.secrets,database(),()=>{});
  assert.ok(reloaded.snapshot().providers.every(item=>item.zeroDataRetentionEnabled===false));
  assert.ok(reloaded.snapshot().providers.flatMap(item=>item.models).every(item=>!Object.hasOwn(item,'zdr')));
  assert.equal(savedModel(reloaded,'first','request-id').model.name,'Renamed');
});
test('keys stay in secret storage and empty field preserves an existing key',async()=>{
  const s=storage(); await s.store.saveProvider(provider(),'secret-canary');
  assert.equal(await s.store.key('provider-one'),'secret-canary');
  assert.ok(!JSON.stringify([...s.data]).includes('secret-canary'));
  assert.ok(!JSON.stringify(await s.store.uiState()).includes('secret-canary'));
  assert.equal((await s.store.uiState()).providers[0].hasKey,true);
  await s.store.saveProvider({...provider(),name:'Renamed'},'');
  assert.equal(await s.store.key('provider-one'),'secret-canary');
  await s.store.saveProvider(provider(),undefined,true);
  assert.equal(await s.store.key('provider-one'),undefined);
});
test('failed config persistence rolls back key replacement and deletion',async()=>{
  const s=storage(); await s.store.saveProvider(provider(),'original'); s.fail=true;
  await assert.rejects(s.store.saveProvider(provider(),'replacement'));
  assert.equal(await s.store.key('provider-one'),'original');
  await assert.rejects(s.store.deleteProvider('provider-one'));
  assert.equal(await s.store.key('provider-one'),'original');
  assert.equal(s.store.snapshot().providers.length,1);
  assert.equal(s.changes,1);
});
test('concurrent saves are serialized and preserve independent providers',async()=>{
  const s=storage(); await Promise.all([s.store.saveProvider(provider('one'),'key-one'),s.store.saveProvider(provider('two'),'key-two')]);
  assert.equal(s.store.snapshot().providers.length,2);
  const reloaded=new StudioStore(s.global,s.secrets,database(),()=>{});
  assert.equal(savedModel(reloaded,'two','request-id').provider.id,'two');
  await reloaded.deleteProvider('one');
  assert.equal(await reloaded.key('one'),undefined);
  assert.equal(reloaded.snapshot().providers.length,1);
});
test('database changes apply immediately with manual overrides preserved',async()=>{
  const s=storage(),p=provider(); p.models[0].overrides={maxOutputTokens:64000};
  await s.store.saveProvider(p);
  const db=database(); db.models['request-id'].contextWindow=2000000;db.models['request-id'].name='Updated Name';
  await s.store.saveDatabase(db);
  const active=savedModel(s.store,p.id,'request-id');
  assert.equal(active.parameters.contextWindow,2000000);assert.equal(active.parameters.maxOutputTokens,64000);
  assert.equal(modelName(s.store.snapshot().database,active.model),'Updated Name');
  db.models={}; await s.store.saveDatabase(db);
  assert.equal(savedModel(s.store,p.id,'request-id').parameters.contextWindow,128000);
  db.defaults.contextWindow=32000; await assert.rejects(s.store.saveDatabase(db));
  assert.equal(s.store.snapshot().database.defaults.contextWindow,128000);
});
test('database updates clear reasoning selections that no longer apply',async()=>{
  const s=storage(), db=database(); db.models['request-id'].thinking=true;db.models['request-id'].supportsReasoningEffort=['high'];
  await s.store.saveDatabase(db); const p=provider();p.models[0].reasoningEffort='high';await s.store.saveProvider(p);
  db.models['request-id'].thinking=false;await s.store.saveDatabase(db);
  assert.equal(s.store.snapshot().providers[0].models[0].reasoningEffort,undefined);
  assert.doesNotThrow(()=>new StudioStore(s.global,s.secrets,database(),()=>{}));
});
test('catalog additions reach existing installs once without overwriting custom entries',async()=>{
  const s=storage(), bundled=database();
  bundled.models['codex-auto-review']={...defaults,name:'codex-auto-review',source:'requested ID; unverified'};
  await s.store.saveProvider(provider(),'existing-key');
  await s.store.applyCatalogUpdate('review-entry',bundled,['codex-auto-review']);
  assert.equal(s.store.snapshot().database.models['codex-auto-review'].name,'codex-auto-review');
  assert.equal(await s.store.key('provider-one'),'existing-key');
  assert.equal(s.store.snapshot().providers.length,1);
  const customized=s.store.snapshot().database;customized.models['codex-auto-review'].name='My Review';
  await s.store.saveDatabase(customized);
  await s.store.applyCatalogUpdate('second-release',bundled,['codex-auto-review']);
  assert.equal(s.store.snapshot().database.models['codex-auto-review'].name,'My Review');
  const removed=s.store.snapshot().database;delete removed.models['codex-auto-review'];await s.store.saveDatabase(removed);
  const reloaded=new StudioStore(s.global,s.secrets,database(),()=>{});
  await reloaded.applyCatalogUpdate('review-entry',bundled,['codex-auto-review']);
  assert.equal(Object.hasOwn(reloaded.snapshot().database.models,'codex-auto-review'),false);
});
test('catalog additions preserve configurations with incompatible manual overrides',async()=>{
  const s=storage(),db=database();db.defaults.contextWindow=500000;
  await s.store.saveDatabase(db);const p=provider();p.models=[{...model('codex-auto-review'),overrides:{maxOutputTokens:200000}}];await s.store.saveProvider(p);
  const bundled=database();bundled.models['codex-auto-review']={...defaults,name:'codex-auto-review'};
  await s.store.applyCatalogUpdate('review-entry',bundled,['codex-auto-review']);
  assert.equal(savedModel(s.store,p.id,'codex-auto-review').parameters.maxOutputTokens,200000);
  assert.equal(Object.hasOwn(s.store.snapshot().database.models,'codex-auto-review'),false);
});
test('verified catalog updates replace only untouched bundled records',async()=>{
  const s=storage();const before=database().models['request-id'];const after={...before,thinking:true,supportsReasoningEffort:['low','high']};
  await s.store.applyCatalogReplacements('native-effort',[{id:'request-id',before,after}]);
  assert.deepEqual(s.store.snapshot().database.models['request-id'].supportsReasoningEffort,['low','high']);
  const customized=s.store.snapshot().database;customized.models['request-id'].name='User preset';await s.store.saveDatabase(customized);
  await s.store.applyCatalogReplacements('another-update',[{id:'request-id',before:after,after:{...after,name:'Changed upstream'}}]);
  assert.equal(s.store.snapshot().database.models['request-id'].name,'User preset');
  const removed=s.store.snapshot().database;delete removed.models['request-id'];await s.store.saveDatabase(removed);
  const reloaded=new StudioStore(s.global,s.secrets,database(),()=>{});
  await reloaded.applyCatalogReplacements('native-effort',[{id:'request-id',before,after}]);
  assert.equal(Object.hasOwn(reloaded.snapshot().database.models,'request-id'),false);
});
test('retired context budgets are removed from saved state and cannot reappear on save',async()=>{
  for(const contextSize of [272000,2000000,'invalid']){
    const p=provider();p.models[0].contextSize=contextSize;
    const s=storage({version:1,database:database(),providers:[p]});
    assert.equal(Object.hasOwn(s.store.snapshot().providers[0].models[0],'contextSize'),false);
    await s.store.uiState();
    assert.equal(Object.hasOwn(s.data.get(STATE_KEY).providers[0].models[0],'contextSize'),false,'Normalization persists without requiring a supplier edit');
    await s.store.saveProvider(p,'context-key');
    const restored=new StudioStore(s.global,s.secrets,database(),()=>{});
    assert.equal(Object.hasOwn(restored.snapshot().providers[0].models[0],'contextSize'),false);
    assert.equal(await restored.key(p.id),'context-key');
    assert.deepEqual(restored.snapshot().database,database());
  }
});
test('curated display names migrate raw-ID labels without changing requests, capabilities or custom names',async()=>{
  const s=storage();const db=database();db.models['deepseek-v4.1-flash']={...defaults,name:'deepseek-v4.1-flash'};db.models['doubao-seed-2-1-pro']={...defaults,name:'My catalog label'};
  await s.store.saveDatabase(db);
  const p=provider();p.models=[model('deepseek-v4.1-flash'),{...model('doubao-seed-2-1-pro'),name:'My local label'}];await s.store.saveProvider(p,'name-migration-key');
  const before=structuredClone(s.store.snapshot().providers);
  await s.store.applyDisplayNames('friendly-names',{'deepseek-v4.1-flash':'DeepSeek-V4.1-Flash','doubao-seed-2-1-pro':'Doubao-Seed-2.1-Pro','removed-id':'Removed'});
  const after=s.store.snapshot();
  assert.equal(modelName(after.database,after.providers[0].models[0]),'DeepSeek-V4.1-Flash');
  assert.equal(after.providers[0].models[0].id,'deepseek-v4.1-flash');
  assert.equal(after.database.models['deepseek-v4.1-flash'].toolCalling,false,'Display formatting does not assert model capabilities');
  assert.equal(after.database.models['doubao-seed-2-1-pro'].name,'My catalog label');
  assert.equal(modelName(after.database,after.providers[0].models[1]),'My local label');
  assert.equal(Object.hasOwn(after.database.models,'removed-id'),false);
  assert.deepEqual(after.providers,before);assert.equal(await s.store.key(p.id),'name-migration-key');
  const edited=after.database;edited.models['deepseek-v4.1-flash'].name='deepseek-v4.1-flash';await s.store.saveDatabase(edited);
  const reloaded=new StudioStore(s.global,s.secrets,database(),()=>{});await reloaded.applyDisplayNames('friendly-names',{'deepseek-v4.1-flash':'DeepSeek-V4.1-Flash'});
  assert.equal(reloaded.snapshot().database.models['deepseek-v4.1-flash'].name,'deepseek-v4.1-flash','One-time migration does not override later user changes');
});
test('official reasoning controls and full input/output price bands survive validation and export',async()=>{
  const s=storage();const db=database();
  const record=db.models['request-id'];record.defaultOutputTokens=32000;record.aliasOf='official-model-id';
  record.reasoningControls={protocols:{chatCompletions:{modePath:['thinking','type'],enabledValue:'enabled',disabledValue:'disabled',disabledEfforts:['none']},messages:{modePath:['thinking','type'],enabledValue:'enabled',defaultMode:'enabled',allowUnsignedThinking:true}},note:'Official controls'};
  record.contextPricing={kind:'tiered',scope:'direct-api',thresholds:[32000,128000],source:'https://vendor.example/prices',checkedAt:'2026-11-08',note:'Input and output bands',rates:{currency:'CNY',perTokens:1000000,bands:[{inputUpTo:32000,outputUpTo:2000,input:0.5,output:2,cacheRead:0.1},{inputUpTo:32000,outputUpTo:null,input:0.5,output:3},{inputUpTo:128000,input:1,output:4},{inputUpTo:null,input:2,output:8}]}};
  assert.deepEqual(validateDatabase(db),db);await s.store.saveDatabase(db);assert.deepEqual(s.store.snapshot().database,db);
  const wrong=structuredClone(db);wrong.models['request-id'].contextPricing.rates.bands[0].inputUpTo=40000;assert.throws(()=>validateDatabase(wrong),/Context/);
  wrong.models['request-id'].contextPricing.rates.bands[0].inputUpTo=32000;wrong.models['request-id'].contextPricing.rates.bands[0].output=-1;assert.throws(()=>validateDatabase(wrong),/费率/);
});
test('catalog revisions repair stock capabilities while preserving user names, budgets, pricing and secrets',async()=>{
  const s=storage();const db=database();
  const old={...defaults,name:'Old alias',contextWindow:128000,maxOutputTokens:16000};
  const price={kind:'tiered',scope:'direct-api',thresholds:[32000],source:'https://vendor.example/pricing',checkedAt:'2026-11-08',note:'Official input bands'};
  db.models['alias']={...old,name:'User catalog name',releaseDate:null};
  db.models['manual']={...old,contextWindow:64000};
  db.models['priced']={...old,contextPricing:{...price,scope:'custom',thresholds:[16000]}};
  await s.store.saveDatabase(db);
  const p=provider();p.models=[{...model('alias'),name:'User model name',contextSize:32000},model('manual')];await s.store.saveProvider(p,'retained-revision-key');
  const providers=structuredClone(s.store.snapshot().providers);
  const after={...old,name:'Official alias',contextWindow:1048576,maxInputTokens:1048575,maxOutputTokens:1048576,defaultOutputTokens:131072,toolCalling:true,thinking:true,supportsReasoningEffort:['low','high'],contextPricing:price};
  await s.store.applyCatalogRevision('verified-update',['alias','manual','priced'].map(id=>({id,before:old,after})));
  const result=s.store.snapshot();
  assert.equal(result.database.models.alias.toolCalling,true);assert.equal(result.database.models.alias.contextWindow,1048576);
  assert.equal(result.database.models.alias.name,'User catalog name');assert.equal(result.database.models.alias.releaseDate,null);
  assert.equal(result.database.models.alias.defaultOutputTokens,131072);assert.deepEqual(result.database.models.alias.contextPricing,price);
  assert.equal(result.database.models.manual.contextWindow,64000);assert.equal(result.database.models.manual.toolCalling,false);
  assert.deepEqual(result.database.models.manual.contextPricing,price,'Pricing can update independently of custom capabilities');
  assert.deepEqual(result.database.models.priced.contextPricing,db.models.priced.contextPricing);
  assert.deepEqual(result.providers,providers);assert.equal(await s.store.key(p.id),'retained-revision-key');
  result.database.models.alias.toolCalling=false;await s.store.saveDatabase(result.database);
  await s.store.applyCatalogRevision('verified-update',[{id:'alias',before:old,after}]);
  assert.equal(s.store.snapshot().database.models.alias.toolCalling,false,'Migration is one-time');
});
test('field revisions repair untouched capabilities independently and preserve manual values',async()=>{
  const s=storage();const db=database();const before=structuredClone(db.models['request-id']);
  db.models['request-id'].name='Custom label';db.models['request-id'].maxOutputTokens=4096;
  await s.store.saveDatabase(db);const p=provider();p.models[0].contextSize=900000;await s.store.saveProvider(p,'preserved-key');
  const after={...before,contextWindow:800000,maxInputTokens:700000,maxOutputTokens:64000,thinking:true,supportsReasoningEffort:['low','high'],source:'Checked official source'};
  await s.store.applyCatalogFields('fields-update',[{id:'request-id',before,after}]);
  const result=s.store.snapshot();const record=result.database.models['request-id'];
  assert.equal(record.name,'Custom label');assert.equal(record.maxOutputTokens,4096);assert.equal(record.contextWindow,800000);assert.equal(record.thinking,true);
  assert.equal(Object.hasOwn(result.providers[0].models[0],'contextSize'),false,'Retired budgets do not survive catalog revisions');
  assert.equal(await s.store.key(p.id),'preserved-key');
  record.thinking=false;await s.store.saveDatabase(result.database);await s.store.applyCatalogFields('fields-update',[{id:'request-id',before,after}]);
  assert.equal(s.store.snapshot().database.models['request-id'].thinking,false,'Later edits are not overwritten by a repeated migration');
});
test('K3 sampling migration updates saved presets once and preserves user-maintained profiles',async()=>{
  const {replacements}=require('../data/catalog-updates-0.7.1.json');
  for(const customized of [false,true]){
    const s=storage();const db=database();
    for(const {id,before} of replacements){
      db.models[id]=structuredClone(before);
      db.models[id].name='My label';
      if(customized)db.models[id].reasoningControls.protocols.chatCompletions.parameters={top_p:null};
    }
    await s.store.saveDatabase(db);
    await s.store.applyCatalogFields('0.7.1-k3-sampling',replacements);
    for(const {id} of replacements){
      const record=s.store.snapshot().database.models[id];
      assert.equal(record.name,'My label');
      assert.deepEqual(record.reasoningControls.protocols.chatCompletions.parameters,{top_p:customized?null:0.95});
    }
    const saved=s.store.snapshot();
    await s.store.applyCatalogFields('0.7.1-k3-sampling',replacements);
    assert.deepEqual(s.store.snapshot(),saved);
  }
});
test('disabled supplier preference survives storage',async()=>{const s=storage();const p=provider();p.enabled=false;await s.store.saveProvider(p);assert.equal(s.store.snapshot().providers[0].enabled,false);});
