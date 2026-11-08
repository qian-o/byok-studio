require('../media/i18n').setLocale('zh-CN');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vendors=require('../media/model-vendors');
const {validateProvider}=require('../dist/core/configuration');
const {StudioStore}=require('../dist/core/store');
const database={schemaVersion:1,defaults:{name:'',contextWindow:128000,maxOutputTokens:16000,toolCalling:false,vision:false,thinking:false,supportsReasoningEffort:[],source:'test',verifiedAt:null},models:{}};
const model=id=>({id,name:'',discoveredName:'',overrides:{}});
function supplier(){const models=['gpt-test','claude-test','gemini-test','private-model'].map(model);return {id:'routing-test',name:'Gateway',enabled:true,zeroDataRetentionEnabled:false,...vendors.normalizeRouting({routingMode:'split',endpoints:{responses:'https://example.com/oai/v1',chatCompletions:'https://example.com/chat/v1',messages:'https://example.com/claude/v1'},models}),models};}
test('split mode initially assigns every model to exactly one recommended protocol',()=>{
  const p=supplier();const lists=vendors.protocolLists(p);
  assert.deepEqual(lists.map(list=>[list.apiType,list.models.map(m=>m.id)]),[['responses',['gpt-test']],['chatCompletions',['gemini-test','private-model']],['messages',['claude-test']]]);
  assert.equal(new Set(lists.flatMap(list=>list.models.map(m=>m.id))).size,4);
});
test('transfer moves only selected model IDs and preserves their data and the other assignments',()=>{
  const p=supplier();p.models[0].name='Custom GPT';p.models[0].overrides.maxOutputTokens=4096;
  p.modelProtocols=vendors.assignModels(p,['gpt-test','gemini-test'],'messages');
  assert.equal(vendors.routeForModel(p,'gpt-test').apiType,'messages');assert.equal(vendors.routeForModel(p,'private-model').apiType,'chatCompletions');
  assert.equal(p.models[0].name,'Custom GPT');assert.equal(p.models[0].overrides.maxOutputTokens,4096);
  const ids=vendors.protocolLists(p).flatMap(list=>list.models.map(m=>m.id));assert.equal(ids.length,new Set(ids).size);
  assert.throws(()=>vendors.assignModels(p,['gpt-test'],'invalid'));
});
test('unified mode routes all models through one URL and switching back restores split assignments',()=>{
  const p=supplier();p.modelProtocols=vendors.assignModels(p,['gpt-test'],'messages');const preserved=structuredClone(p.modelProtocols);
  p.routingMode='unified';p.unified={apiType:'chatCompletions',url:'https://example.com/unified/v1'};
  for(const m of p.models)assert.deepEqual(vendors.routeForModel(p,m.id),{apiType:'chatCompletions',url:p.unified.url,zeroDataRetentionEnabled:false});
  p.routingMode='split';assert.deepEqual(p.modelProtocols,preserved);assert.equal(vendors.routeForModel(p,'gpt-test').url,p.endpoints.messages);
});
test('v0.2 group choices migrate to per-model assignments and survive roundtrip storage',async()=>{
  const legacy={id:'old',name:'Previous supplier',enabled:true,zeroDataRetentionEnabled:true,endpoints:{responses:'https://example.com/a',chatCompletions:'https://example.com/b',messages:'https://example.com/c'},vendorProtocols:{...vendors.defaultProtocols(),gemini:'responses'},models:['gpt-test','gemini-test','claude-test'].map(model)};
  const values=new Map([['byokStudio.state.v1',{version:1,database,providers:[legacy]}]]);const secrets={get:async()=> 'same-key',store:async()=>{throw Error('No key rewrite');},delete:async()=>{throw Error('No key delete');}};
  const storage={get:k=>values.get(k),update:async(k,v)=>values.set(k,structuredClone(v))};
  const store=new StudioStore(storage,secrets,database,()=>{});await store.uiState();const migrated=store.snapshot().providers[0];
  assert.equal(migrated.routingMode,'split');assert.equal(migrated.modelProtocols['gemini-test'],'responses');assert.ok(!Object.hasOwn(migrated,'vendorProtocols'));assert.deepEqual(migrated.endpoints,legacy.endpoints);
  migrated.routingMode='unified';migrated.unified={apiType:'responses',url:'https://example.com/unified'};await store.saveProvider(migrated);
  const reloaded=new StudioStore(storage,secrets,database,()=>{}).snapshot().providers[0];assert.equal(reloaded.routingMode,'unified');assert.deepEqual(reloaded.modelProtocols,migrated.modelProtocols);assert.equal(await store.key('old'),'same-key');
});
test('refresh replacement retains existing assignments and allocates new models by recommendation',()=>{
  const p=supplier();p.modelProtocols=vendors.assignModels(p,['gpt-test'],'messages');
  p.models=vendors.replaceModels(p.models,[{id:'gpt-test',name:'GPT'},{id:'claude-new',name:'Claude'},{id:'gpt-new',name:'New'}]);
  p.modelProtocols=vendors.normalizeRouting(p).modelProtocols;
  assert.deepEqual(p.modelProtocols,{'gpt-test':'messages','claude-new':'messages','gpt-new':'responses'});
});
test('validation checks only active routes while preserving inactive mode endpoints',()=>{
  const p=supplier();p.routingMode='unified';p.unified={apiType:'messages',url:'https://example.com/one'};p.endpoints={responses:'',chatCompletions:'',messages:''};
  assert.equal(validateProvider(p,database).routingMode,'unified');p.routingMode='split';assert.throws(()=>validateProvider(p,database),/协议地址/);
  assert.throws(()=>validateProvider({...p,routingMode:'wrong'},database));
  assert.throws(()=>validateProvider({...p,modelProtocols:{'gpt-test':'wrong'}},database));
});
