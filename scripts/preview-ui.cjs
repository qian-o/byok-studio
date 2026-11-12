// Local validation harness. It is excluded from the VSIX.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {StudioStore, parseExportBundle, MAX_IMPORT_BYTES} = require('../dist/core/store');
const {validateProvider, sanitizeError} = require('../dist/core/configuration');
const {discoverProviderModels} = require('../dist/core/discovery');
const {setLocale,renderHtml} = require('../resources/shared/i18n');
setLocale(process.env.BYOK_PREVIEW_LANGUAGE || 'en');
const root = path.resolve(__dirname,'..');
const data = new Map(), keys = new Map();
const store = new StudioStore({get:key=>data.get(key),update:async(key,value)=>{data.set(key,value);}}, {get:async key=>keys.get(key),store:async(key,value)=>{keys.set(key,value);},delete:async key=>{keys.delete(key);}},require('../resources/catalog/models.json').database,()=>{});
const template=fs.readFileSync(path.join(root,'resources','webview','index.html'),'utf8');
const resourcePattern=/\{\{resource:((?:webview|shared)\/[a-z0-9.-]+)\}\}/g;
const allowedResources=new Set([...template.matchAll(resourcePattern)].map(match=>'/resources/'+match[1]));
const nonce=crypto.randomBytes(18).toString('base64');
const bridge=`window.acquireVsCodeApi=()=>{
  const post=(message)=>fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)}).then(r=>r.json());
  const reply=(data)=>window.dispatchEvent(new MessageEvent('message',{data}));
  const t=(message)=>window.ByokI18n.t(message);
  return {
    async postMessage(message){
      try {
        if(message.command==='readImportSource'&&message.payload?.source==='file'){
          const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
          const file=await new Promise(resolve=>{input.onchange=()=>resolve(input.files?.[0]||null);input.oncancel=()=>resolve(null);input.click();});
          if(!file){reply({id:message.id,ok:true,data:{canceled:true}});return;}
          if(file.size>${MAX_IMPORT_BYTES})throw Error(t('导入内容超过 16 MiB 大小限制。'));
          const rawText=await file.text();
          reply(await post({...message,payload:{...message.payload,rawText}}));return;
        }
        if(message.command==='readImportSource'&&message.payload?.source==='clipboard'){
          let rawText;
          try{rawText=await navigator.clipboard.readText();}
          catch{throw Error(t('浏览器无法访问剪贴板，请允许访问或使用 JSON 文件。'));}
          reply(await post({...message,payload:{...message.payload,rawText}}));return;
        }
        const res=await post(message);
        if(res.ok&&message.command==='exportProviders'&&res.data?.content){
          if(res.data.target==='clipboard'){
            try{await navigator.clipboard.writeText(res.data.content);}
            catch{throw Error(t('浏览器无法访问剪贴板，请允许访问或使用 JSON 文件。'));}
          }
          else if(res.data.target==='file'){
            const url=URL.createObjectURL(new Blob([res.data.content],{type:'application/json'}));
            const a=document.createElement('a');a.href=url;a.download=res.data.filename||'byok-providers.json';a.click();
            setTimeout(()=>URL.revokeObjectURL(url),1000);
          }
        }
        reply(res);
      } catch(e) { reply({id:message.id,ok:false,error:String(e?.message||e)}); }
    },
    getState(){return undefined;},setState(){}
  };
};`;
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
        else if(m.command==='exportProviders'){const bundle=await store.exportProviders(p.ids);const content=JSON.stringify(bundle,null,2)+'\n';output={exported:bundle.providers.length,target:p.target,content,filename:`byok-providers-${new Date().toISOString().slice(0,10)}.json`};}
        else if(m.command==='readImportSource'){output={providers:parseExportBundle(p.rawText,store.database())};}
        else if(m.command==='importProviders'){const importedIds=await store.importProviders({version:1,providers:p.providers});output={state:await store.uiState(),importedIds};}
        else if(m.command==='discoverModels'){const provider=validateProvider(p.provider,store.database(),true);output=await discoverProviderModels(provider,p.apiKey||await store.key(provider.id)||'',AbortSignal.timeout(15000));}
        else if(m.command==='openModels')output=null;
        else throw Error('Preview operation unavailable');
        result={id:m.id,ok:true,data:output};
      }catch(e){const secrets=[p.apiKey,...(p.providers||[]).map(item=>item.apiKey)].filter(key=>typeof key==='string');result={id:m.id,ok:false,error:sanitizeError(e,secrets)};}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
    }
    res.writeHead(404);res.end();
  }catch(e){res.writeHead(500);res.end('Preview error');}
});
server.listen(0,'127.0.0.1',()=>console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}`));
