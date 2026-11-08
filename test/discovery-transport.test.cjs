const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {discoverModels}=require('../dist/core/discoveryTransport');
const {resolveEndpoint}=require('../dist/core/endpoints');
async function fixture(t,handler){const seen=[];const server=http.createServer((req,res)=>{seen.push(req.url);handler(req,res)});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{const done=once(server,'close');server.close();server.closeAllConnections();await done});return{url:`http://127.0.0.1:${server.address().port}`,seen};}
test('endpoint formatting preserves API roots and existing operation paths',()=>{
  for(const[base,api,suffix]of [['https://example.test','responses','/v1/responses'],['https://example.test/prefix/v1','chatCompletions','/prefix/v1/chat/completions'],['https://example.test/v1/messages','messages','/v1/messages']])assert.equal(new URL(resolveEndpoint(base,api,'chat')).pathname,suffix);
  assert.throws(()=>resolveEndpoint('file:///tmp/key','responses','chat'));
  assert.throws(()=>resolveEndpoint('https://user:password@example.test','messages','models'));
});
test('discovery follows only same-endpoint cursors and de-duplicates returned model IDs',async t=>{
  const f=await fixture(t,(req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('after_id=one')?{data:[{id:'a'},{id:'b',display_name:'Second'}],has_more:false}:{data:[{id:'a',name:'First'}],has_more:true,last_id:'one',next:'https://untrusted.invalid'}));});
  const found=await discoverModels({url:f.url,apiType:'messages'},'fixture',new AbortController().signal);
  assert.deepEqual(found,[{id:'a',name:'First'},{id:'b',name:'Second'}]);assert.equal(f.seen.length,2);assert.ok(f.seen[1].startsWith('/v1/models?'));
});
test('HTTP and malformed discovery responses never disclose credentials or raw response data',async t=>{
  const key='fixture-secret';let status=500;const f=await fixture(t,(_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(status===500?key:'{not json '+key);});
  for(const code of [500,200]){status=code;await assert.rejects(discoverModels({url:f.url,apiType:'responses'},key,new AbortController().signal),error=>!error.message.includes(key));}
});
test('redirects and cancellation cannot move model discovery to another endpoint',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(302,{location:'https://untrusted.invalid/models'});res.end();});
  await assert.rejects(discoverModels({url:f.url,apiType:'chatCompletions'},'fixture',new AbortController().signal));assert.equal(f.seen.length,1);
  const controller=new AbortController();controller.abort();await assert.rejects(discoverModels({url:f.url,apiType:'messages'},'fixture',controller.signal));assert.equal(f.seen.length,1);
});
