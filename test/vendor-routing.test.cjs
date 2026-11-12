const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const vendors=require('../resources/shared/routing');
const {validateProvider,validateDatabase,effectiveParameters}=require('../dist/core/configuration');
const {StudioStore}=require('../dist/core/store');
const {discoverProviderModels}=require('../dist/core/discovery');
const parameters={name:'',contextWindow:128000,maxOutputTokens:16000,toolCalling:false,vision:false,thinking:false,supportsReasoningEffort:[],source:'test',verifiedAt:null};
const db=()=>({schemaVersion:1,defaults:{...parameters},models:{}});
const model=id=>({id,name:'',discoveredName:'',overrides:{}});
const supplier=()=>({id:'gateway',name:'Gateway',enabled:true,zeroDataRetentionEnabled:false,routingMode:'split',unified:{apiType:'chatCompletions',url:''},endpoints:{responses:'https://example.com/codex/v1',chatCompletions:'https://example.com/v1',messages:'https://example.com/anthropic/v1'},modelProtocols:{},models:[]});
const currentIds={
 openai:['codex-auto-review','gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-6-astra','gpt-6-sol','gpt-6.1-sol','gpt-6.1-terra'],
 claude:['claude-fable-5','claude-haiku-4-5-20251001','claude-opus-4-6','claude-opus-4-7','claude-opus-4-8','claude-sonnet-4-6','claude-sonnet-5','claude-opus-5','claude-opus-5-5','claude-fable-5-1','claude-sonnet-5-5','claude-haiku-5-5'],
 grok:['grok-4.5','grok-4.6','grok-4.7'],gemini:['gemini-3-flash-preview','gemini-3.1-flash-lite-preview','gemini-3.1-pro-preview','gemini-3.8-flash','gemini-4-argon'],
 doubao:['doubao-seed-2-1-pro','doubao-seed-2-1-turbo'],deepseek:['deepseek-v4.1-flash','deepseek-v4.1-flash-1017'],glm:['GLM-5.3','GLM-5.3-Flash'],kimi:['kimi-k3','kimi-k3.1-pro']
};
test('all current gateway models use their family protocols and matching endpoints',()=>{
  const all=Object.values(currentIds).flat();assert.equal(all.length,36);
  const provider={...supplier(),models:all.map(model)};
  for(const [vendor,ids]of Object.entries(currentIds))for(const id of ids){
    assert.equal(vendors.vendorOf(id),vendor,id);assert.equal(vendors.excludedKind(id),null,id);
    const apiType=vendor==='openai'?'responses':vendor==='claude'?'messages':'chatCompletions';
    assert.equal(vendors.recommendedProtocol(id),apiType);
    assert.deepEqual(vendors.routeForModel(provider,id),{apiType,url:provider.endpoints[apiType]});
  }
  assert.deepEqual(vendors.groups(provider.models).map(g=>g.id),['openai','claude','grok','gemini','doubao','deepseek','glm','kimi']);
  assert.equal(vendors.vendorOf('private-alias'),'other');assert.equal(vendors.vendorOf('any-provider/GLM-5.3'),'glm');
});
test('image/video generation is removed without excluding multimodal chat models or unknown IDs',()=>{
  for(const id of ['gpt-image-2','gpt-image-2.5','gpt-image-2.6-flare','grok-imagine-image','grok-imagine-image-quality','gemini-3-pro-image-preview','doubao-seedream-4-5','seedream-4.5'])assert.equal(vendors.excludedKind(id),'image',id);
  for(const id of ['kling-v3','kling-v3-turbo','grok-imagine-video','grok-imagine-video-1.5','seedance-2.0','seedance-2.5','sora-2','veo-3'])assert.equal(vendors.excludedKind(id),'video',id);
  for(const id of ['gemini-4-argon','deepseek-v4-flash-vision-exp','GLM-5.3-Flash','private-vision-model'])assert.equal(vendors.excludedKind(id),null,id);
});
test('legacy single-URL configuration remains unified and gains family routes for split mode',async()=>{
  const legacy={id:'gateway',name:'Example Gateway',enabled:true,apiType:'messages',url:'https://example.com',zeroDataRetentionEnabled:true,models:['gpt-6-astra','claude-opus-4-6','gemini-4-argon','gpt-image-2'].map(model)};
  const values=new Map([['byokStudio.state.v1',{version:1,providers:[legacy],database:db()}]]), secretValues=new Map([['byokStudio.provider.gateway','saved-key']]);
  const storage={get:k=>values.get(k),update:async(k,v)=>values.set(k,structuredClone(v))};
  const secrets={get:async k=>secretValues.get(k),store:async()=>{throw Error('Do not replace keys');},delete:async()=>{throw Error('Do not delete keys');}};
  const store=new StudioStore(storage,secrets,db(),()=>{});await store.uiState();
  const restored=new StudioStore(storage,secrets,db(),()=>{}).snapshot().providers[0];
  assert.deepEqual(Object.values(restored.endpoints),['https://example.com','https://example.com','https://example.com']);
  assert.equal(restored.routingMode,'unified');assert.equal(restored.unified.apiType,'messages');
  assert.deepEqual(restored.modelProtocols,{'gpt-6-astra':'responses','claude-opus-4-6':'messages','gemini-4-argon':'chatCompletions'});
  assert.equal(vendors.routeForModel(restored,'gpt-6-astra').apiType,'messages');
  restored.routingMode='split';
  assert.deepEqual(restored.models.map(m=>vendors.routeForModel(restored,m.id).apiType),['responses','messages','chatCompletions']);
  assert.equal(Object.hasOwn(restored,'zeroDataRetentionEnabled'),false);assert.equal(await store.key('gateway'),'saved-key');
  assert.equal(restored.models.length,3);assert.ok(!Object.hasOwn(restored,'apiType')&&!Object.hasOwn(restored,'url'));
});
test('legacy group protocol migration preserves its routes and checks only used endpoints',()=>{
  const {routingMode,unified,modelProtocols,...legacy}=supplier();
  const p={...legacy,vendorProtocols:vendors.defaultProtocols(),models:['gpt-6-astra','claude-opus-4-6','grok-4.7'].map(model)};
  p.vendorProtocols.grok='responses';const valid=validateProvider(p,db());assert.equal(vendors.routeForModel(valid,'grok-4.7').url,p.endpoints.responses);
  assert.equal(vendors.routeForModel(valid,'claude-opus-4-6').url,p.endpoints.messages);
  p.endpoints.responses='';assert.throws(()=>validateProvider(p,db()),/responses/);
  assert.doesNotThrow(()=>validateProvider(p,db(),true));
  assert.doesNotThrow(()=>validateProvider({...p,models:[]},db()),'Empty refresh result can be saved');
  assert.throws(()=>validateProvider({...p,vendorProtocols:{...p.vendorProtocols,gemini:'invalid'}},db()));
});
test('refresh replacement removes vanished IDs, deduplicates, filters generators and preserves retained customization',()=>{
  const retained={...model('gpt-6-astra'),name:'My Astra',overrides:{maxOutputTokens:8192},reasoningEffort:'high'};
  const old=[retained,model('vanished'),model('gpt-image-2')];
  const replaced=vendors.replaceModels(old,[{id:'new-id',name:'New'},{id:'gpt-6-astra',name:'Endpoint Name'},{id:'new-id',name:'Duplicate'},{id:'kling-v3',name:'Video'}]);
  assert.deepEqual(replaced.map(m=>m.id),['new-id','gpt-6-astra']);assert.equal(replaced[1].name,'My Astra');assert.equal(replaced[1].reasoningEffort,'high');assert.equal(replaced[1].overrides.maxOutputTokens,8192);
  assert.deepEqual(vendors.replaceModels(old,[]),[]);assert.equal(old.length,3);
});
test('legacy preset budgets collapse to Output and retired input fields are dropped',()=>{
  const database=db();database.models['kimi-k3']={...parameters,name:'Kimi K3',contextWindow:262144,maxOutputTokens:262144,defaultOutputTokens:65536,maxInputTokens:262144};
  const valid=validateDatabase(database),effective=effectiveParameters(valid,model('kimi-k3'));
  assert.equal(effective.contextWindow,262144);assert.equal(effective.maxOutputTokens,65536);
  assert.equal(Object.hasOwn(effective,'maxInputTokens'),false);assert.equal(Object.hasOwn(effective,'defaultOutputTokens'),false);
  delete database.models['kimi-k3'].defaultOutputTokens;assert.throws(()=>validateDatabase(database));
});
async function mock(t,handler){const requests=[];const server=http.createServer((req,res)=>{requests.push({url:req.url,headers:req.headers});handler(req,res);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));return {url:`http://127.0.0.1:${server.address().port}`,requests};}
test('model discovery deduplicates identical endpoints, unions channels and filters non-chat models',async t=>{
  const server=await mock(t,(req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:req.url.startsWith('/claude')?[{id:'claude-opus-4-6'},{id:'gpt-6-astra'}]:[{id:'gpt-6-astra'},{id:'gemini-4-argon'},{id:'gpt-image-2'}]}));});
  const p={...supplier(),unified:{apiType:'messages',url:server.url+'/inactive/v1'},endpoints:{responses:server.url+'/v1',chatCompletions:server.url+'/v1',messages:server.url+'/claude/v1'},models:[model('gpt-6-astra')],modelProtocols:{'gpt-6-astra':'responses'}};
  const result=await discoverProviderModels(p,'shared-key',new AbortController().signal);
  assert.equal(server.requests.length,2);assert.deepEqual(result.models.map(m=>m.id),['gpt-6-astra','gemini-4-argon','claude-opus-4-6']);assert.equal(result.excludedCount,1);
  assert.equal(server.requests[0].headers.authorization,'Bearer shared-key');assert.equal(server.requests[1].headers['x-api-key'],'shared-key');
});
test('unified discovery only queries the active unified address even when split addresses are filled',async t=>{
  const server=await mock(t,(req,res)=>{if(req.url.startsWith('/inactive')){res.writeHead(503);res.end('inactive endpoint must not be queried');}else{res.setHeader('content-type','application/json');res.end('{"data":[{"id":"unified-model"}]}');}});
  const p={...supplier(),routingMode:'unified',unified:{apiType:'responses',url:server.url+'/unified/v1'},endpoints:{responses:server.url+'/inactive/responses/v1',chatCompletions:server.url+'/inactive/chat/v1',messages:server.url+'/inactive/messages/v1'},models:[model('unified-model')],modelProtocols:{'unified-model':'messages'}};
  const result=await discoverProviderModels(p,'shared-key',new AbortController().signal);
  assert.deepEqual(result.models.map(m=>m.id),['unified-model']);assert.equal(result.sourceCount,1);assert.equal(server.requests.length,1);assert.equal(server.requests[0].url,'/unified/v1/models');
});
test('a failed discovery channel fails replacement atomically and empty successes stay empty',async t=>{
  const server=await mock(t,(req,res)=>{if(req.url.startsWith('/bad')){res.writeHead(503);res.end('bad');}else{res.setHeader('content-type','application/json');res.end('{"data":[]}');}});
  const p={...supplier(),endpoints:{responses:server.url+'/good/v1',chatCompletions:'',messages:server.url+'/bad/v1'},models:[model('previous')]};
  await assert.rejects(discoverProviderModels(p,'shared-key',new AbortController().signal));assert.equal(p.models[0].id,'previous');
  p.endpoints.messages='';const empty=await discoverProviderModels(p,'shared-key',new AbortController().signal);assert.deepEqual(empty.models,[]);
});
