// Local validation harness. It is excluded from the VSIX.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {StudioStore} = require('../dist/core/store');
const {validateProvider, sanitizeError} = require('../dist/core/configuration');
const {discoverProviderModels} = require('../dist/core/discovery');
const {setLocale,renderHtml} = require('../resources/shared/i18n');
setLocale(process.env.BYOK_PREVIEW_LANGUAGE || 'en');
const root = path.resolve(__dirname,'..');
const data = new Map(), keys = new Map();
const store = new StudioStore({get:key=>data.get(key),update:async(key,value)=>{data.set(key,value);}}, {get:async key=>keys.get(key),store:async(key,value)=>{keys.set(key,value);},delete:async key=>{keys.delete(key);}},require('../resources/catalog/models.json'),()=>{});
const template=fs.readFileSync(path.join(root,'resources','webview','index.html'),'utf8');
const resourcePattern=/\{\{resource:((?:webview|shared)\/[a-z0-9.-]+)\}\}/g;
const allowedResources=new Set([...template.matchAll(resourcePattern)].map(match=>'/resources/'+match[1]));
const nonce=crypto.randomBytes(18).toString('base64');
const bridge=`window.acquireVsCodeApi=()=>({postMessage(message){fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)}).then(r=>r.json()).then(data=>window.dispatchEvent(new MessageEvent('message',{data})));},getState(){return undefined;},setState(){}});`;
const server = http.createServer(async(req,res)=>{
  try {
    if(req.method==='GET'&&req.url==='/'){
      let html=renderHtml(template).replace(resourcePattern,(_match,file)=>'/resources/'+file).replaceAll('{{CSP_SOURCE}}',"'self'").replaceAll('{{NONCE}}',nonce);
      html=html.replace("default-src 'none';","default-src 'none'; connect-src 'self';").replace('</head>',`<script nonce="${nonce}">${bridge}</script></head>`);
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);return;
    }
    if(req.method==='GET'&&allowedResources.has(req.url)){
      res.writeHead(200,{'content-type':req.url.endsWith('.css')?'text/css':'text/javascript'});res.end(fs.readFileSync(path.join(root,req.url)));return;
    }
    if(req.method==='GET'&&['/v1/models','/responses/v1/models','/chat/v1/models','/messages/v1/models'].includes(req.url.split('?')[0])){
      const ids=require('../test/preview-models.json');
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:ids.map(id=>({id,name:id})),has_more:false}));return;
    }
    if(req.method==='POST'&&req.url==='/rpc'){
      const chunks=[];for await(const c of req)chunks.push(c);
      const m=JSON.parse(Buffer.concat(chunks).toString());const p=m.payload||{};
      let result;
      try{
        let output=null;
        if(m.command==='getState')output=await store.uiState();
        else if(m.command==='saveProvider'){await store.saveProvider(p.provider,p.apiKey,p.clearKey);output=await store.uiState();}
        else if(m.command==='deleteProvider'){await store.deleteProvider(p.id);output=await store.uiState();}
        else if(m.command==='saveDatabase'){await store.saveDatabase(p.database);output=await store.uiState();}
        else if(m.command==='discoverModels'){const provider=validateProvider(p.provider,store.snapshot().database,true);if((provider.routingMode==='unified'?[provider.unified.url]:Object.values(provider.endpoints)).some(url=>url&&!url.startsWith(`http://127.0.0.1:${server.address().port}/`)))throw Error('Preview harness only allows its local mock endpoint.');output=await discoverProviderModels(provider,p.apiKey||await store.key(provider.id)||'',AbortSignal.timeout(5000));}
        else if(['openModels','exportConfig','exportDatabase'].includes(m.command))output=null;
        else throw Error('Preview operation unavailable');
        result={id:m.id,ok:true,data:output};
      }catch(e){result={id:m.id,ok:false,error:sanitizeError(e,p.apiKey)};}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
    }
    res.writeHead(404);res.end();
  }catch(e){res.writeHead(500);res.end('Preview error');}
});
server.listen(0,'127.0.0.1',()=>console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}`));
