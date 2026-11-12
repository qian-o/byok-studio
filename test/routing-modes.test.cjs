require('../resources/shared/i18n').setLocale('zh-CN');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vendors=require('../resources/shared/routing');
const {validateProvider}=require('../dist/core/configuration');
const {StudioStore}=require('../dist/core/store');
const database={schemaVersion:1,defaults:{name:'',contextWindow:128000,maxOutputTokens:16000,toolCalling:false,vision:false,thinking:false,supportsReasoningEffort:[],source:'test',verifiedAt:null},models:{}};
const model=id=>({id,name:'',discoveredName:'',overrides:{}});
function supplier(){const models=['gpt-test','claude-test','gemini-test','private-model'].map(model);return {id:'routing-test',name:'Gateway',enabled:true,zeroDataRetentionEnabled:false,...vendors.normalizeRouting({routingMode:'split',endpoints:{responses:'https://example.com/oai/v1',chatCompletions:'https://example.com/chat/v1',messages:'https://example.com/claude/v1'},modelProtocols:{},models}),models};}
test('split models group by family and ignore the unified protocol',()=>{
  const p=supplier();const lists=vendors.protocolLists(p);
  assert.deepEqual(p.modelProtocols,{'gpt-test':'responses','claude-test':'messages','gemini-test':'chatCompletions','private-model':'chatCompletions'});
  assert.deepEqual(lists.map(list=>[list.apiType,list.models.map(m=>m.id)]),[['responses',['gpt-test']],['chatCompletions',['gemini-test','private-model']],['messages',['claude-test']]]);
  assert.equal(new Set(lists.flatMap(list=>list.models.map(m=>m.id))).size,4);
  const cases={'gateway/GPT-test':'responses','codex-test':'responses','gateway/Claude-test':'messages','grok-test':'chatCompletions','GLM-test':'chatCompletions','private-id':'chatCompletions'};
  for(const [id,apiType] of Object.entries(cases))assert.equal(vendors.routeForModel({...p,models:[model(id)]},id).apiType,apiType);
});
test('split family assignments are independent of populated endpoints and unified settings',()=>{
  for(const config of [{},{endpoints:{messages:'https://example.com/messages'},modelProtocols:{}},{routingMode:'split',unified:{apiType:'responses',url:''}}]){
    const p={...config,models:['gpt-test','claude-test','custom-id'].map(model)};
    const routing=vendors.normalizeRouting(p);
    assert.deepEqual(routing.modelProtocols,{'gpt-test':'responses','claude-test':'messages','custom-id':'chatCompletions'});
    assert.equal(routing.unified.apiType,config.unified?.apiType||'chatCompletions');
    for(const m of p.models)assert.equal(vendors.routeForModel(p,m.id,routing).apiType,routing.routingMode==='split'?routing.modelProtocols[m.id]:routing.unified.apiType);
  }
});
test('unified protocol changes leave split model routes unchanged',()=>{
  const p=supplier();p.modelProtocols=vendors.assignModels(p,['gpt-test'],'chatCompletions');
  p.modelProtocols=vendors.assignModels(p,['claude-test'],'responses');
  for(const apiType of ['messages','responses','chatCompletions']){
    p.unified.apiType=apiType;
    assert.deepEqual(vendors.routeForModel(p,'gpt-test'),{apiType:'chatCompletions',url:p.endpoints.chatCompletions});
    assert.deepEqual(vendors.routeForModel(p,'claude-test'),{apiType:'responses',url:p.endpoints.responses});
    for(const id of ['gemini-test','private-model'])assert.deepEqual(vendors.routeForModel(p,id),{apiType:'chatCompletions',url:p.endpoints.chatCompletions});
    for(const list of vendors.protocolLists(p))for(const m of list.models)assert.equal(vendors.routeForModel(p,m.id).apiType,list.apiType);
    assert.deepEqual(p.modelProtocols,{'gpt-test':'chatCompletions','claude-test':'responses','gemini-test':'chatCompletions','private-model':'chatCompletions'});
  }
});
test('transfer moves only selected model IDs and preserves their data and the other assignments',()=>{
  const p=supplier();p.models[0].name='Custom GPT';p.models[0].overrides.maxOutputTokens=4096;
  p.modelProtocols=vendors.assignModels(p,['gpt-test','gemini-test'],'messages');
  assert.equal(vendors.routeForModel(p,'gpt-test').apiType,'messages');assert.equal(vendors.routeForModel(p,'private-model').apiType,'chatCompletions');
  assert.equal(p.models[0].name,'Custom GPT');assert.equal(p.models[0].overrides.maxOutputTokens,4096);
  const ids=vendors.protocolLists(p).flatMap(list=>list.models.map(m=>m.id));assert.equal(ids.length,new Set(ids).size);
  assert.throws(()=>vendors.assignModels(p,['gpt-test'],'invalid'));
  assert.throws(()=>vendors.assignModels(p,['gpt-test'],undefined));
});
test('empty protocol maps restore family assignments without mutating model settings',()=>{
  const p=supplier();p.modelProtocols=vendors.assignModels(p,p.models.map(m=>m.id),'chatCompletions');
  const models=structuredClone(p.models),before=structuredClone(p.modelProtocols);
  assert.throws(()=>vendors.assignModels(p,['gpt-test'],'') ,/Unsupported protocol/);
  assert.deepEqual(p.modelProtocols,before);assert.deepEqual(p.models,models);
  p.unified.apiType='responses';
  for(const routingMode of ['unified','split']){
    p.routingMode=routingMode;p.modelProtocols={};
    const expected={'gpt-test':'responses','claude-test':'messages','gemini-test':'chatCompletions','private-model':'chatCompletions'};
    assert.deepEqual(vendors.normalizeRouting(p).modelProtocols,expected);
    for(const m of p.models)assert.equal(vendors.routeForModel(p,m.id).apiType,routingMode==='split'?expected[m.id]:'responses');
  }
});
test('unified mode routes all models through one URL and switching back restores split assignments',()=>{
  const p=supplier();p.modelProtocols=vendors.assignModels(p,['gpt-test'],'messages');const preserved=structuredClone(p.modelProtocols);
  p.routingMode='unified';p.unified={apiType:'chatCompletions',url:'https://example.com/unified/v1'};
  for(const m of p.models)assert.deepEqual(vendors.routeForModel(p,m.id),{apiType:'chatCompletions',url:p.unified.url});
  assert.deepEqual(vendors.protocolLists(p).map(list=>list.models.map(m=>m.id)),[[],p.models.map(m=>m.id),[]]);
  p.routingMode='split';assert.deepEqual(p.modelProtocols,preserved);assert.equal(vendors.routeForModel(p,'gpt-test').url,p.endpoints.messages);
});
test('v0.2 group choices migrate to per-model assignments and survive roundtrip storage',async()=>{
  const legacy={id:'old',name:'Previous supplier',enabled:true,zeroDataRetentionEnabled:true,endpoints:{responses:'https://example.com/a',chatCompletions:'https://example.com/b',messages:'https://example.com/c'},vendorProtocols:{...vendors.defaultProtocols(),gemini:'responses'},models:['gpt-test','gemini-test','claude-test'].map(model)};
  const values=new Map([['byokStudio.state.v1',{version:1,database,providers:[legacy]}]]);const secrets={get:async()=> 'same-key',store:async()=>{throw Error('No key rewrite');},delete:async()=>{throw Error('No key delete');}};
  const storage={get:k=>values.get(k),update:async(k,v)=>values.set(k,structuredClone(v))};
  const store=new StudioStore(storage,secrets,database,()=>{});await store.uiState();const migrated=store.snapshot().providers[0];
  assert.equal(migrated.routingMode,'split');assert.deepEqual(migrated.modelProtocols,{'gpt-test':'responses','gemini-test':'responses','claude-test':'messages'});assert.ok(!Object.hasOwn(migrated,'vendorProtocols'));assert.deepEqual(migrated.endpoints,legacy.endpoints);
  migrated.routingMode='unified';migrated.unified={apiType:'responses',url:'https://example.com/unified'};await store.saveProvider(migrated);
  const reloaded=new StudioStore(storage,secrets,database,()=>{}).snapshot().providers[0];assert.equal(reloaded.routingMode,'unified');assert.deepEqual(reloaded.modelProtocols,migrated.modelProtocols);assert.equal(await store.key('old'),'same-key');
});
test('normalization prunes removed IDs and assigns new models by family',()=>{
  const p=supplier();p.modelProtocols=vendors.assignModels(p,['gpt-test'],'messages');
  p.modelProtocols['private-model']='responses';p.modelProtocols['gpt-image-2']='responses';
  p.models=vendors.replaceModels(p.models,[{id:'gpt-test',name:'GPT'},{id:'claude-new',name:'Claude'},{id:'gpt-new',name:'New'}]);
  p.modelProtocols=vendors.normalizeRouting(p).modelProtocols;
  assert.deepEqual(p.modelProtocols,{'gpt-test':'messages','claude-new':'messages','gpt-new':'responses'});
  p.modelProtocols={};assert.deepEqual(vendors.normalizeRouting(p).modelProtocols,{'gpt-test':'responses','claude-new':'messages','gpt-new':'responses'});
});
test('missing assignments use family rules while explicit and legacy assignments survive',()=>{
  const p=supplier();const {modelProtocols,unified,...legacy}=p;
  assert.deepEqual(vendors.normalizeRouting(legacy).modelProtocols,{'gpt-test':'responses','claude-test':'messages','gemini-test':'chatCompletions','private-model':'chatCompletions'});
  assert.deepEqual(vendors.normalizeRouting({...legacy,modelProtocols:{}}).modelProtocols,modelProtocols);
  assert.deepEqual(vendors.normalizeRouting({...legacy,unified}).modelProtocols,modelProtocols);
  assert.deepEqual(vendors.normalizeRouting({...legacy,modelProtocols:{'gpt-test':'chatCompletions'},vendorProtocols:{claude:'responses'}}).modelProtocols,{'gpt-test':'chatCompletions','claude-test':'responses','gemini-test':'chatCompletions','private-model':'chatCompletions'});
  const inherited=Object.create({'gpt-test':'messages'});
  assert.deepEqual(vendors.normalizeRouting({...p,modelProtocols:inherited}).modelProtocols,modelProtocols);
  for(const id of ['toString','valueOf'])assert.equal(vendors.routeForModel({...p,models:[model(id)]},id).apiType,'chatCompletions');
});
test('validation checks only active routes while preserving inactive mode endpoints',()=>{
  const p=supplier();p.routingMode='unified';p.unified={apiType:'messages',url:'https://example.com/one'};p.endpoints={responses:'',chatCompletions:'',messages:''};
  assert.equal(validateProvider(p,database).routingMode,'unified');p.routingMode='split';assert.throws(()=>validateProvider(p,database),/协议地址/);
  assert.throws(()=>validateProvider({...p,routingMode:'wrong'},database));
  assert.throws(()=>validateProvider({...p,modelProtocols:{'gpt-test':'wrong'}},database));
});
test('split validation requires only effective URLs and preserves empty unused addresses',()=>{
  const p=supplier();p.models=['gpt-one','gpt-two'].map(model);p.modelProtocols={};p.unified={apiType:'messages',url:''};p.endpoints.chatCompletions='';p.endpoints.messages='';
  assert.deepEqual(validateProvider(p,database).endpoints,p.endpoints);
  p.modelProtocols={'gpt-one':'messages'};assert.throws(()=>validateProvider(p,database),/messages/);
  p.endpoints.messages='https://example.com/claude/v1';assert.doesNotThrow(()=>validateProvider(p,database));
  p.endpoints.responses='';assert.throws(()=>validateProvider(p,database),/responses/);
  p.modelProtocols=vendors.assignModels(p,p.models.map(m=>m.id),'messages');assert.doesNotThrow(()=>validateProvider(p,database));
  p.endpoints.messages='';assert.doesNotThrow(()=>validateProvider(p,database,true));assert.doesNotThrow(()=>validateProvider({...p,enabled:false},database));
});
test('validation rejects malformed protocol maps even for disabled or unified providers',()=>{
  const p={...supplier(),enabled:false,routingMode:'unified'};
  for(const modelProtocols of [null,undefined,[],true,'messages',{'gpt-test':''},{'gpt-test':undefined},{'gpt-test':'wrong'},{'deleted-model':'wrong'},{'bad id':'responses'},JSON.parse('{"__proto__":"responses"}')]){
    assert.throws(()=>validateProvider({...p,modelProtocols},database));
  }
  const valid=validateProvider({...p,models:[model(' gpt-test ')],modelProtocols:{'gpt-test':'messages','deleted-model':'responses'}},database);
  assert.deepEqual(valid.modelProtocols,{'gpt-test':'messages'});assert.equal(valid.models[0].id,'gpt-test');
});
test('family routes and manual assignments persist through save, reload and reset',async()=>{
  const values=new Map(),storage={get:k=>values.get(k),update:async(k,v)=>values.set(k,structuredClone(v))};
  const secrets={get:async()=> 'saved-key',store:async()=>assert.fail('Key rewritten'),delete:async()=>assert.fail('Key removed')};
  const create=()=>new StudioStore(storage,secrets,database,()=>{});
  let store=create();const p=supplier();p.modelProtocols={'gpt-test':'chatCompletions'};await store.saveProvider(p);
  store=create();const restored=store.snapshot().providers[0];assert.deepEqual(restored.modelProtocols,{'gpt-test':'chatCompletions','claude-test':'messages','gemini-test':'chatCompletions','private-model':'chatCompletions'});
  restored.unified.apiType='messages';await store.saveProvider(restored);
  store=create();const changed=store.snapshot().providers[0];
  assert.equal(vendors.routeForModel(changed,'gpt-test').apiType,'chatCompletions');assert.equal(vendors.routeForModel(changed,'claude-test').apiType,'messages');
  changed.modelProtocols={};await store.saveProvider(changed);
  store=create();assert.deepEqual(store.snapshot().providers[0].modelProtocols,{'gpt-test':'responses','claude-test':'messages','gemini-test':'chatCompletions','private-model':'chatCompletions'});assert.equal(await store.key(p.id),'saved-key');
});
