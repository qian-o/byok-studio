const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {validateProvider,validateDatabase}=require('../dist/core/configuration');
const vendors=require('../resources/shared/routing.js');
const modelRules=require('../resources/catalog/rules.json');
const vendorScript=fs.readFileSync(path.join(__dirname,'..','resources','shared','routing.js'),'utf8');
const i18n=require('../resources/shared/i18n.js');
i18n.setLocale('zh-CN');
const database={
  schemaVersion:1,
  defaults:{name:'',contextWindow:128000,maxOutputTokens:8192,toolCalling:true,vision:false,thinking:false,supportsReasoningEffort:[]},
  models:{}
};
const htmlTemplate=fs.readFileSync(path.join(__dirname,'..','resources','webview','index.html'),'utf8');
const html=i18n.renderHtml(htmlTemplate);
const script=fs.readFileSync(path.join(__dirname,'..','resources','webview','app.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','resources','webview','style.css'),'utf8');
const model=id=>({id,name:'',discoveredName:'',overrides:{}});
const provider=(id='gateway')=>({id,name:'Gateway',routingMode:'unified',unified:{apiType:'chatCompletions',url:'https://chat.example.com/v1'},endpoints:{responses:'https://responses.example.com/v1',chatCompletions:'https://chat.example.com/v1',messages:'https://messages.example.com/v1'},modelProtocols:{},enabled:true,models:[model('unknown-id'),model('another-id')]});
const splitProvider=(id='gateway')=>({...provider(id),routingMode:'split'});
const explicitProtocols=ids=>Object.fromEntries(ids.map(id=>[id,vendors.recommendedProtocol(id)]));
const inProtocol=(ui,apiType)=>ui.get('model-list').querySelector(`[data-protocol="${apiType}"]`).querySelectorAll('[data-model-id]').map(row=>row.dataset.modelId);
const shownModels=ui=>ui.elements.get('model-list').querySelectorAll('[data-model-id]').map(row=>row.dataset.modelId);
const shownGroups=ui=>ui.elements.get('model-list').querySelectorAll('[data-vendor]').map(group=>group.dataset.vendor);
function assertSaveToast(ui) {
  const toast=ui.get('toast');
  assert.equal(toast.hidden,false,'A successful save confirms completion');
  assert.equal(toast.attributes.get('role'),'status');
  assert.equal(toast.attributes.get('aria-live'),'polite');
  assert.match(toast.className,/success-toast/);
  assert.doesNotMatch(toast.className,/error-toast/);
}

async function webview(providers, modelDatabase = database, options = {}) {
  const vendorContext={};
  vm.runInNewContext(vendorScript,vendorContext);
  const localeContext={ByokEnglishMessages:require('../resources/shared/messages.en.js')};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','resources','shared','i18n.js'),'utf8'),localeContext);
  localeContext.ByokI18n.setLocale(options.language || 'zh-CN');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','resources','shared','model-policy.js'),'utf8'),localeContext);
  let state={providers:structuredClone(providers.map(item=>({hasKey:false,...item}))),database:structuredClone(modelDatabase),modelRules:structuredClone(options.modelRules||modelRules),revision:0};
  const elements=new Map(),listeners=new Map(),messages=[],deferredCloses=[];
  const descendants=item=>item.children.flatMap(child=>[child,...descendants(child)]);
  const dataKey=name=>name.replace(/^data-/,'').replace(/-([a-z])/g,(_match,char)=>char.toUpperCase());
  function matches(item,selector) {
    return selector.split(',').some(part=>{
      part=part.trim();
      const attribute=part.match(/^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/);
      if(attribute){
        const [,tag,key,value]=attribute;
        if(tag&&item.tagName!==tag.toUpperCase())return false;
        const actual=key.startsWith('data-')?item.dataset[dataKey(key)]:key==='open'?(item.open?'':undefined):item.attributes.get(key);
        return actual!==undefined&&(value===undefined||String(actual)===value);
      }
      if(part==='input:checked')return item.tagName==='INPUT'&&item.checked;
      if(part.startsWith('.'))return item.className.split(/\s+/).includes(part.slice(1));
      return item.tagName===part.toUpperCase();
    });
  }
  function element(tag='div',id='') {
    const handlers=new Map();let value='';
    const item={
      id,tagName:tag.toUpperCase(),checked:false,hidden:false,disabled:false,open:false,dataset:{},children:[],attributes:new Map(),isConnected:true,className:'',textContent:'',
      get value(){return value;},set value(next){value=String(next);},
      addEventListener(type,callback){handlers.set(type,callback);},
      dispatch(type,event){return handlers.get(type)?.(event);},
      setAttribute(name,value){this.attributes.set(name,String(value));},
      removeAttribute(name){this.attributes.delete(name);},
      hasAttribute(name){return this.attributes.has(name);},
      append(...children){for(const child of children){if(child.tagName==='#FRAGMENT')this.append(...child.children);else{this.children.push(child);child.parentElement=this;}}},
      replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...children);},
      querySelectorAll(selector){return descendants(this).filter(child=>matches(child,selector));},
      querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
      closest(selector){for(let item=this;item;item=item.parentElement)if(matches(item,selector))return item;return null;},
      contains(child){return descendants(this).includes(child);},
      focus(){document.activeElement=this;},select(){},
      showModal(){this.open=true;},close(){this.open=false;if(options.deferClose)deferredCloses.push(()=>this.dispatch('close',{}));else this.dispatch('close',{});}
    };
    item.classList={toggle(name,enabled){const classes=new Set(item.className.split(/\s+/).filter(Boolean));if(enabled)classes.add(name);else classes.delete(name);item.className=[...classes].join(' ');}};
    return item;
  }
  for(const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)){
    const item=element(match[1],match[2]);
    item.hidden=/\bhidden\b/.test(match[0]);
    item.className=match[0].match(/\bclass="([^"]*)"/)?.[1]||'';
    for(const [,name,value] of match[0].matchAll(/\s(data-[\w-]+)="([^"]*)"/g))item.dataset[dataKey(name)]=value;
    elements.set(match[2],item);
  }
  const allElements=()=>[...new Set([...elements.values()].flatMap(item=>[item,...descendants(item)]))];
  const document={
    body:element('body'),activeElement:null,
    getElementById(id){const item=elements.get(id)||allElements().find(item=>item.id===id);assert.ok(item,`Missing HTML element: ${id}`);return item;},
    createElement:tag=>element(tag),createElementNS:(_ns,tag)=>element(tag),createDocumentFragment:()=>element('#fragment'),createTextNode:text=>Object.assign(element('#text'),{textContent:text}),
    querySelectorAll:selector=>allElements().filter(item=>matches(item,selector))
  };
  const bridge={postMessage(message){
    messages.push(structuredClone(message));
    queueMicrotask(async()=>{
      try {
        let data;
        if(message.command==='getState')data=state;
        else if(message.command==='saveProvider'){
          if(options.beforeSave)await options.beforeSave(message);
          const index=state.providers.findIndex(item=>item.id===message.payload.provider.id);
          const hasKey=message.payload.clearKey?false:Boolean(message.payload.apiKey)||state.providers[index]?.hasKey===true;
          const saved={...validateProvider(message.payload.provider,state.database),hasKey};
          if(index<0)state.providers.push(saved);else state.providers[index]=saved;
          state.revision++;
          if(options.afterSave)await options.afterSave(message);
          data=state;
        }else if(message.command==='discoverModels'){
          if(options.discoveryError)throw new Error(options.discoveryError);
          data=options.discover?await options.discover(message):options.discovery||{models:[{id:'discovered-id',name:'Discovered Model'}]};
        }else if(message.command==='updateCatalog'){
          if(options.beforeUpdate)await options.beforeUpdate(message);
          if(options.catalogError)throw new Error(options.catalogError);
          if(options.updatedCatalog)state.database=validateDatabase(options.updatedCatalog);
          state.catalog={source:'models.dev',updatedAt:'2026-11-09T00:00:00.000Z'};
          state.revision++;data=state;
        }else if(message.command==='deleteProvider'){
          state.providers=state.providers.filter(item=>item.id!==message.payload.id);state.revision++;data=state;
        }else if(message.command==='exportProviders'){
          if(options.exportError)throw new Error(options.exportError);
          if(options.exportCanceled)data={canceled:true};
          else data={exported:message.payload.ids.length,target:message.payload.target};
        }else if(message.command==='readImportSource'){
          if(options.importSourceError)throw new Error(options.importSourceError);
          if(options.importSourceCanceled)data={canceled:true};
          else data={providers:structuredClone(options.importSource||[])};
        }else if(message.command==='importProviders'){
          if(options.importError)throw new Error(options.importError);
          const importedIds=[];
          for(const entry of message.payload.providers){
            const {apiKey,...rest}=entry;
            const valid=validateProvider(rest,state.database);
            let index=state.providers.findIndex(item=>item.id===valid.id);
            let targetId=valid.id;
            if(index<0){index=state.providers.findIndex(item=>item.name===valid.name);if(index>=0)targetId=state.providers[index].id;}
            const hasKey=Boolean(apiKey)||state.providers[index]?.hasKey===true;
            const saved={...valid,id:targetId,hasKey};
            if(index<0)state.providers.push(saved);else state.providers[index]=saved;
            importedIds.push(targetId);
          }
          state.revision++;data={state,importedIds};
        }else throw new Error(`Unsupported command: ${message.command}`);
        listeners.get('message')({data:{id:message.id,ok:true,data:data===undefined?undefined:structuredClone(data)}});
      }catch(error){listeners.get('message')({data:{id:message.id,ok:false,error:error.message}});}
    });
  }};
  vm.runInNewContext(script,{ByokModelPolicy:localeContext.ByokModelPolicy,ByokI18n:localeContext.ByokI18n,ByokModelVendors:vendorContext.ByokModelVendors,document,window:{addEventListener:(type,callback)=>listeners.set(type,callback)},acquireVsCodeApi:()=>bridge,crypto:{randomUUID},URL,setTimeout:()=>1,clearTimeout(){}},{filename:'resources/webview/app.js'});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  await flush();
  assert.equal(elements.get('load-error').hidden,true,elements.get('load-error-message').textContent);
  return {
    elements,messages,flush,get state(){return structuredClone(state);},get:document.getElementById,
    async flushCloseEvents(){for(const close of deferredCloses.splice(0))close();await flush();},
    async emit(id,type,fields={},target){const item=document.getElementById(id);Object.assign(item,fields);const event={target:target||item,preventDefault(){}};for(let current=item;current;current=current.parentElement)current.dispatch(type,event);await flush();},
    async select(id){await this.emit('provider-list','click',{}, {closest:()=>({dataset:{providerId:id}})});},
    async mode(mode){await this.emit(`routing-${mode}`,'change',{checked:true});},
    async choose(id,checked=true){const checkbox=this.get('model-list').querySelector(`[data-select-model="${id}"]`);checkbox.checked=checked;await this.emit('model-list','change',{},checkbox);},
    async move(target){await this.emit(`move-to-${target}`,'click');},
    async saved(){
      const before=this.messages.filter(message=>message.command==='saveProvider').length;
      await this.emit('provider-form','submit');
      const saves=this.messages.filter(message=>message.command==='saveProvider');
      assert.equal(saves.length,before+1,this.get('provider-error').textContent);
      assert.equal(this.get('provider-error').hidden,true,this.get('provider-error').textContent);
      assert.equal(this.get('save-provider').disabled,false);
      assertSaveToast(this);
      const saved=saves.at(-1).payload.provider;
      const acknowledged=this.state.providers.find(provider=>provider.id===saved.id);
      assert.deepEqual(saved,validateProvider(acknowledged,this.state.database));
      return saved;
    },
    get activeElement(){return document.activeElement;},
    async editModel(id){await this.emit('model-list','click',{},document.getElementById('model-list').querySelectorAll('[data-model-id]').find(row=>row.dataset.modelId===id).querySelector('.model-open'));},
    async pushState(next){state=structuredClone(next);listeners.get('message')({data:{event:'state',data:structuredClone(next)}});await flush();}
  };
}
test('exported provider shape strips secret and unexpected incoming fields',()=>{
  const result=validateProvider({...provider(),zeroDataRetentionEnabled:true,zdr:false,apiKey:'DO-NOT-EXPORT',hasKey:true,models:[{id:'unknown-id',name:'Private Model',overrides:{apiKey:'DO-NOT-EXPORT'},zdr:false}]},database);
  assert.ok(!JSON.stringify(result).includes('DO-NOT-EXPORT'));
  assert.equal(Object.hasOwn(result,'hasKey'),false);
  assert.equal(Object.hasOwn(result,'zeroDataRetentionEnabled'),false);
  assert.equal(Object.hasOwn(result,'zdr'),false);
  assert.equal(Object.hasOwn(result.models[0],'zdr'),false);
});
test('compact main panel removes help, duplicate headings and secondary footer actions',()=>{
  const main=html.match(/<main\b[\s\S]*?<\/main>/)[0];
  for(const id of ['provider-heading','provider-avatar','key-status','clear-key','clear-key-label','routing-note','provider-zdr-note','model-refresh-status','export-config','open-models']){
    assert.ok(!html.includes(`id="${id}"`),`Removed element ${id} must not return`);
    assert.ok(!script.includes(`$('${id}')`),`Removed element ${id} must not be accessed`);
  }
  assert.doesNotMatch(main,/page-footnote|provider-header|class="source-note|密钥由 VS Code|管理自定义模型供应商/);
  assert.match(main,/class="field compact-field"/);
  assert.match(main,/class="provider-options"/);
  assert.match(main,/id="update-catalog" class="catalog-action"/);
  assert.doesNotMatch(html,/id="(?:database-|open-database|provider-zdr)|context-pricing/);
  assert.match(main,/id="request-status" class="visually-hidden" role="status"/);
  assert.match(main,/id="model-list" class="model-list" role="region" aria-labelledby="models-heading" tabindex="-1"/);
  assert.doesNotMatch(script,/clearKey|refreshStatus|\btoast\(/);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'Static controls must have unique IDs');
});
test('desktop model viewport is shared by protocol columns and narrow screens use page scrolling',()=>{
  const desktop=css.split('@media')[0];
  const rule=selector=>{
    const start=desktop.indexOf(`${selector} {`);
    assert.notEqual(start,-1,selector);
    return desktop.slice(start,desktop.indexOf('}',start)+1);
  };
  assert.match(rule('html, body'),/overflow: hidden/);
  assert.match(rule('.page'),/height: 100dvh/);
  for(const selector of ['.settings-card','.provider-panel','#provider-form','.model-box','.model-list']){
    assert.match(rule(selector),/flex: 1/);
    assert.match(rule(selector),/min-height: 0/);
  }
  assert.match(rule('.model-scroll'),/overflow-y: auto/);
  assert.match(rule('.split-models .model-scroll'),/repeat\(3, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(rule('.protocol-models'),/overflow|max-height/);
  assert.doesNotMatch(rule('.protocol-controls'),/position: sticky|clip-path/);
  assert.match(rule('.protocol-cards'),/position: absolute/);
  assert.match(rule('.protocol-card'),/border-radius: 6px/);
  assert.doesNotMatch(css,/position: sticky|container-type|100cqh|card-clip|protocol-column/);
  assert.doesNotMatch(script,/card-clip|updateCardFrames|requestAnimationFrame|ResizeObserver/);
  assert.match(rule('.panel-footer'),/flex-shrink: 0/);
  assert.match(css,/@media \(max-width: 420px\), \(max-height: 480px\)\s*\{[\s\S]*?html \{[^}]*overflow-y: auto/);
  assert.match(css,/\.model-list, \.model-list\.split-models, \.model-scroll \{ flex: none; overflow: visible; scrollbar-gutter: auto; \}/);
  assert.match(rule('dialog'),/max-height: calc\(100dvh - 32px\); overflow: hidden/);
  assert.match(rule('dialog'),/padding: 8px/);
  assert.match(rule('.dialog-scroll'),/max-height: calc\(100dvh - 50px\); overflow: auto/);
  for(const dialog of html.matchAll(/<dialog\b[^>]*>\s*<([^>]+)>/g))assert.match(dialog[1],/class="dialog-scroll"/);
});
test('supplier navigation and model rows show only names without saved or enabled status markers',async()=>{
  assert.doesNotMatch(html,/id="save-status"|id="provider-enabled"|enabled-badge|class="sidebar"/);
  assert.match(html,/class="provider-navigation"/);
  assert.ok(html.indexOf('class="provider-navigation"')<html.indexOf('id="provider-panel"'));
  const ui=await webview([provider('one'),{...provider('two'),name:'Other supplier',enabled:false}]);
  for(const mode of ['unified','split']){
    await ui.mode(mode);
    assert.equal(ui.get('provider-list').querySelectorAll('.dot,.draft-dot,.enabled-badge').length,0);
    assert.equal(ui.get('model-list').querySelectorAll('.dot').length,0);
  }
  await ui.emit('provider-name','input',{value:'New Name'});
  const labels=ui.get('provider-list').children.map(button=>button.attributes.get('aria-label'));
  assert.deepEqual(labels,['New Name','Other supplier']);
  await ui.select('two');await ui.emit('provider-form','submit');
  assert.equal(ui.state.providers.find(p=>p.id==='two').enabled,false,'Hiding markers must not silently enable a disabled provider');
});
test('save always submits unchanged suppliers and preserves saved keys without resending them',async()=>{
  const original={...provider(),hasKey:true};const ui=await webview([original]);
  const before=validateProvider(original,database);
  for(let i=0;i<3;i++){
    assert.equal(ui.get('save-provider').disabled,false,'Save remains clickable with no edits');
    await ui.emit('provider-form','submit');
    assert.equal(ui.get('save-provider').disabled,false,'Save becomes available again after success');
    assertSaveToast(ui);
    assert.equal(ui.get('toast').textContent,'供应商已保存。');
    assert.equal(ui.get('request-status').textContent,'');
    assert.equal(ui.get('api-key').value,'');
    assert.equal(ui.get('api-key').placeholder,'留空保持已存密钥');
  }
  const saves=ui.messages.filter(message=>message.command==='saveProvider');
  assert.equal(saves.length,3);
  for(const save of saves){assert.deepEqual(save.payload.provider,before);assert.equal(Object.hasOwn(save.payload,'apiKey'),false);assert.equal(Object.hasOwn(save.payload,'clearKey'),false);}
  assert.equal(ui.state.providers[0].hasKey,true);assert.equal(ui.state.revision,3);
});
test('replacing a key resets visibility and subsequent blank saves preserve the saved key',async()=>{
  const ui=await webview([{...provider(),hasKey:true}]);
  await ui.emit('api-key','input',{value:'  REPLACEMENT-KEY  '});
  await ui.emit('toggle-key','click');
  assert.equal(ui.get('api-key').type,'text');
  await ui.saved();
  assert.equal(ui.messages.filter(message=>message.command==='saveProvider').at(-1).payload.apiKey,'REPLACEMENT-KEY');
  assert.equal(ui.get('api-key').type,'password');
  assert.equal(ui.get('toggle-key').attributes.get('aria-pressed'),'false');
  for(const value of ['', '   ', '']){
    await ui.emit('api-key','input',{value});
    await ui.saved();
    const payload=ui.messages.filter(message=>message.command==='saveProvider').at(-1).payload;
    assert.equal(Object.hasOwn(payload,'apiKey'),false);
    assert.equal(Object.hasOwn(payload,'clearKey'),false);
    assert.equal(ui.state.providers[0].hasKey,true);
    assert.equal(ui.get('api-key').value,'');
  }
});
test('save is temporarily blocked only while a request is outstanding and is retryable after failure',async()=>{
  let release;let rejectOnce=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const ui=await webview([provider()],database,{beforeSave:async()=>{await gate;if(rejectOnce){rejectOnce=false;throw Error('simulated save error');}}});
  await ui.emit('provider-form','submit');
  assert.equal(ui.get('save-provider').disabled,true);
  assert.equal(ui.get('request-status').textContent,'正在保存供应商…');
  assert.equal(ui.get('studio').attributes.get('aria-busy'),'true');
  assert.equal(ui.get('toast').hidden,true);
  await ui.emit('provider-form','submit');assert.equal(ui.messages.filter(m=>m.command==='saveProvider').length,1);
  release();await ui.flush();assert.equal(ui.get('save-provider').disabled,false);
  assert.equal(ui.get('request-status').textContent,'');
  assert.equal(ui.get('studio').attributes.get('aria-busy'),'false');
  assertSaveToast(ui);
  rejectOnce=true;await ui.emit('provider-form','submit');
  assert.equal(ui.get('provider-error').hidden,false);assert.equal(ui.get('save-provider').disabled,false);
  assert.equal(ui.get('toast').hidden,true);
  assert.equal(ui.get('request-status').textContent,'');
  await ui.emit('provider-form','submit');assert.equal(ui.get('provider-error').hidden,true);
  assertSaveToast(ui);
  assert.equal(ui.messages.filter(m=>m.command==='saveProvider').length,3);
});
test('save confirmation waits for native sync after interim state updates and stays hidden on sync failure',async()=>{
  for(const fail of [false,true]){
    let finishSync;
    const nativeSync=new Promise((resolve,reject)=>{finishSync=()=>fail?reject(Error('native sync failed')):resolve();});
    const ui=await webview([provider()],database,{afterSave:()=>nativeSync});
    await ui.emit('provider-name','input',{value:'Saved draft'});
    await ui.emit('provider-form','submit');
    assert.equal(ui.state.providers[0].name,'Saved draft','Local state can be saved before native sync completes');
    await ui.pushState(ui.state);
    assert.equal(ui.get('toast').hidden,true,'An interim state event must not announce success');
    assert.equal(ui.get('save-provider').disabled,true);
    finishSync();await ui.flush();
    assert.equal(ui.get('save-provider').disabled,false);
    if(fail){
      assert.equal(ui.get('toast').hidden,true);
      assert.equal(ui.get('provider-error').hidden,false);
      assert.match(ui.get('provider-error').textContent,/native sync failed/);
      assert.match(css,/\.inline-error, \.dialog-error \{ color: var\(--error\)/);
    }else{
      assertSaveToast(ui);
      assert.equal(ui.get('provider-error').hidden,true);
    }
  }
});
test('save success uses green polite status while other errors retain red alerts',async()=>{
  const ui=await webview([provider()],database,{language:'en',catalogError:'catalog unavailable'});
  await ui.saved();
  assert.equal(ui.get('toast').textContent,'Provider saved.');
  await ui.emit('update-catalog','click');
  const toast=ui.get('toast');
  assert.equal(toast.hidden,false);
  assert.equal(toast.attributes.get('role'),'alert');
  assert.equal(toast.attributes.get('aria-live'),'assertive');
  assert.match(toast.className,/error-toast/);
  assert.doesNotMatch(toast.className,/success-toast/);
  assert.match(toast.textContent,/catalog unavailable/);
  assert.match(css,/\.toast\.error-toast \{ border-color: var\(--error\); color: var\(--error\)/);
  assert.match(css,/\.toast\.success-toast \{ border-color: var\(--good\); color: var\(--good\)/);
  await ui.saved();
});
test('supplier URLs stay outside the model editor and retired controls are absent',()=>{
  const form=html.match(/<form id="provider-form"[\s\S]*?<\/form>/)[0];
  const editor=html.match(/<form id="model-form"[\s\S]*?<\/form>/)[0];
  for(const id of ['routing-unified','routing-split','unified-api-type','unified-url'])assert.match(form,new RegExp(`id="${id}"`));
  for(const id of ['responses-url','chat-completions-url','messages-url'])assert.ok(script.includes(`'${id}'`));
  assert.match(script,/input\.dataset\.endpoint = apiType/);
  assert.doesNotMatch(script,/data-vendor-protocol|vendor-protocol-/);
  assert.doesNotMatch(editor,/id="context-size"/);
  assert.doesNotMatch(html,/context-pricing|database-pricing/);
  assert.match(editor,/id="max-input" type="number"/);
  assert.doesNotMatch(html,/zdr|ZDR|零数据保留/);
  assert.doesNotMatch(script,/zeroDataRetentionEnabled|statefulResponses|\bzdr\b/);
  assert.ok(editor.indexOf('id="model-name"')<editor.indexOf('<details'));
  assert.match(editor,/<details[\s\S]*<input id="model-id"[^>]*list="model-id-options"/);
  assert.doesNotMatch(editor,/<select[^>]*id="model-id"/);
});
test('model insertion and discovery order survive edits, additions, saving and reloading',async()=>{
  const ids=['z-model','a-model','m-model'];
  const discovered=['m-model','z-model','b-model'];
  const db=structuredClone(database);
  db.models['a-model']={...db.defaults,releaseDate:'2026-10-01'};
  const ui=await webview([{...provider(),models:ids.map(model)}],db,{discovery:{models:discovered.map(id=>({id,name:id}))}});
  assert.deepEqual(shownModels(ui),ids);
  await ui.editModel('a-model');
  await ui.emit('model-name','input',{value:'First alphabetically'});
  await ui.emit('model-form','submit');
  assert.deepEqual(shownModels(ui),ids);
  await ui.emit('add-model','click');
  await ui.emit('model-id','input',{value:'b-model'});
  await ui.emit('model-form','submit');
  assert.deepEqual(shownModels(ui),[...ids,'b-model']);
  assert.deepEqual((await ui.saved()).models.map(item=>item.id),[...ids,'b-model']);
  await ui.emit('refresh-models','click');
  assert.deepEqual(shownModels(ui),discovered);
  await ui.saved();
  assert.deepEqual(shownModels(await webview(ui.state.providers)),discovered);
});
test('unified models retain provider order across manufacturers without group headings',async()=>{
  const db=structuredClone(database);
  const ids=['unknown-ui','kimi-ui','glm-ui','deepseek-ui','doubao-ui','gemini-ui','grok-ui','claude-ui','gpt-ui-old','gpt-ui-new','gpt-image-2','kling-v3','text-embedding-3'];
  const ui=await webview([{...provider(),models:ids.map(model)}],db);
  assert.deepEqual(shownGroups(ui),[]);
  assert.deepEqual(shownModels(ui),ids.slice(0,10));
  assert.equal(ui.get('model-list').querySelectorAll('h4').length,0);
  assert.equal(ui.get('routing-unified').checked,true);
  assert.equal(ui.get('model-list').querySelectorAll('select').length,0);
  assert.equal(ui.get('model-list').querySelectorAll('[data-select-model]').length,10);
  assert.equal(ui.get('unified-model-selection').hidden,false);
  await ui.emit('unified-api-type','change',{value:'messages'});
  await ui.emit('unified-url','input',{value:'  https://new.example.com/v1  '});
  assert.equal(ui.get('confirm-dialog').open,false);
  assert.equal(shownModels(ui).length,10);
  await ui.emit('provider-form','submit');
  const saved=ui.state.providers[0];
  assert.equal(saved.routingMode,'unified');
  assert.equal(saved.unified.apiType,'messages');
  assert.equal(saved.unified.url,'https://new.example.com/v1');
  assert.deepEqual(saved.modelProtocols,explicitProtocols(ids.slice(0,10)));
  for(const key of ['apiType','url','vendorProtocols','manufacturerProtocols'])assert.equal(Object.hasOwn(saved,key),false);
  const restored=await webview([saved],db);
  assert.equal(restored.get('unified-api-type').value,'messages');
  assert.deepEqual(shownModels(restored),shownModels(ui));
});
test('legacy single routes remain unified while 0.2 group routes migrate to split assignments',async()=>{
  for(const apiType of vendors.apiTypes){
    const {endpoints,modelProtocols,routingMode,unified,...legacy}=provider();
    const input={...legacy,apiType,url:'https://legacy.example.com/v1',models:[model('gpt-ui'),model('claude-ui'),model('custom-ui')]};
    const ui=await webview([input]);
    assert.equal(ui.get('routing-unified').checked,true);
    assert.equal(ui.get('unified-api-type').value,apiType);
    assert.equal(ui.get('unified-url').value,'https://legacy.example.com/v1');
    assert.equal(ui.get('save-provider').disabled,false);
    const exported=await ui.saved();
    assert.equal(exported.routingMode,'unified');
    assert.deepEqual(exported.unified,{apiType,url:'https://legacy.example.com/v1'});
    assert.equal(Object.hasOwn(exported,'apiType'),false);
    assert.equal(Object.hasOwn(exported,'url'),false);
    assert.deepEqual(exported,validateProvider(input,database));
    for(const model of exported.models)assert.equal(vendors.routeForModel(exported,model.id).apiType,apiType);
    await ui.mode('split');
    assert.deepEqual(inProtocol(ui,'responses'),['gpt-ui']);
    assert.deepEqual(inProtocol(ui,'messages'),['claude-ui']);
    assert.deepEqual(inProtocol(ui,'chatCompletions'),['custom-ui']);
  }
  const {routingMode,unified,modelProtocols,...old}=provider();
  old.vendorProtocols={...vendors.defaultProtocols(),openai:'messages',other:'responses'};
  old.models=['gpt-ui','claude-ui','custom-ui'].map(model);
  const ui=await webview([old]);
  assert.equal(ui.get('routing-split').checked,true);
  assert.deepEqual(inProtocol(ui,'responses'),['custom-ui']);
  assert.deepEqual(inProtocol(ui,'messages'),['gpt-ui','claude-ui']);
  assert.deepEqual(inProtocol(ui,'chatCompletions'),[]);
  const exported=await ui.saved();
  assert.equal(Object.hasOwn(exported,'vendorProtocols'),false);
  assert.deepEqual(exported,validateProvider(old,database));
});
test('refresh replaces all models, preserves retained settings and excludes image/video families',async()=>{
  const retained={...model('gpt-ui'),name:'My independent name',discoveredName:'Old upstream name',overrides:{contextWindow:1000,maxInputTokens:800,maxOutputTokens:1000,thinking:true,supportsReasoningEffort:['high']},reasoningEffort:'high'};
  const discovery={models:[{id:'claude-ui',name:'Claude'},{id:'gpt-ui',name:'New upstream name'},{id:'gpt-ui',name:'Duplicate'},{id:'gpt-image-2',name:'Image'},{id:'kling-v3',name:'Video'},{id:'custom-new',name:'Custom'}],excludedCount:2,sourceCount:3};
  const ui=await webview([{...provider(),models:[retained,model('removed-ui')]}],database,{discovery});
  await ui.emit('api-key','input',{value:'SHARED-KEY'});
  await ui.emit('refresh-models','click');
  assert.equal(ui.elements.get('confirm-dialog').open,false);
  assert.equal(ui.messages.filter(message=>message.command==='discoverModels').length,1);
  const request=ui.messages.find(message=>message.command==='discoverModels');
  assert.equal(request.payload.apiKey,'SHARED-KEY');
  assert.deepEqual(request.payload.provider.endpoints,provider().endpoints);
  assert.deepEqual(shownModels(ui),['claude-ui','gpt-ui','custom-new']);
  assert.equal(ui.get('save-provider').disabled,false);
  assert.equal(ui.get('toast').hidden,true);
  assert.equal(ui.get('provider-error').hidden,true);
  assert.deepEqual(ui.state.providers[0].models,[retained,model('removed-ui')]);
  await ui.emit('provider-form','submit');
  const saved=ui.state.providers[0];
  assert.deepEqual(saved.models.find(item=>item.id==='gpt-ui'),{...retained,discoveredName:'New upstream name'});
  assert.deepEqual(saved.models.find(item=>item.id==='claude-ui'),{id:'claude-ui',name:'',discoveredName:'Claude',overrides:{}});
  assert.equal(saved.models.some(item=>item.id==='removed-ui'),false);
});
test('successful empty refresh removes every group and saves an enabled empty supplier',async()=>{
  const ui=await webview([provider()],database,{discovery:{models:[],excludedCount:0,sourceCount:3}});
  await ui.emit('refresh-models','click');
  assert.deepEqual(shownModels(ui),[]);
  assert.deepEqual(shownGroups(ui),[]);
  assert.equal(ui.elements.get('confirm-dialog').open,false);
  assert.equal(ui.get('toast').hidden,true);
  assert.equal(ui.get('provider-error').hidden,true);
  await ui.emit('provider-form','submit');
  assert.deepEqual(ui.state.providers[0].models,[]);
  assert.equal(ui.state.providers[0].enabled,true);
  assert.equal(ui.get('save-provider').disabled,false);
  await ui.emit('add-provider','click');
  await ui.emit('provider-form','submit');
  assert.equal(ui.state.providers.length,2);
  assert.equal(ui.state.providers[1].routingMode,'unified');
  assert.deepEqual(ui.state.providers[1].unified,{apiType:'chatCompletions',url:''});
  assert.deepEqual(ui.state.providers[1].modelProtocols,{});
});
test('failed and malformed refresh results leave the complete old list intact',async()=>{
  for(const options of [{discoveryError:'Messages endpoint failed: UNSAVED-KEY'},{discovery:{models:[{id:'new-ui',name:'New'},{id:'bad id',name:'Invalid'}]}}]){
    const ui=await webview([provider()],database,options);
    await ui.emit('api-key','input',{value:'UNSAVED-KEY'});
    await ui.emit('refresh-models','click');
    assert.deepEqual(shownModels(ui),['unknown-id','another-id']);
    assert.deepEqual(ui.state.providers[0].models,provider().models);
    assert.equal(ui.elements.get('confirm-dialog').open,false);
    assert.equal(ui.elements.get('model-list').attributes.get('aria-busy'),'false');
    assert.equal(ui.get('provider-error').hidden,false);
    assert.equal(ui.get('refresh-models').disabled,false);
    assert.equal(ui.get('request-status').textContent,'');
    assert.equal(ui.get('toast').hidden,true,'Inline recovery needs no duplicate toast');
    assert.doesNotMatch(ui.elements.get('provider-error').textContent,/UNSAVED-KEY/);
    assert.equal(ui.messages.some(message=>message.command==='saveProvider'),false);
  }
});
test('refresh recovery clears inline errors and keeps warnings redacted without success notifications',async()=>{
  let attempt=0;
  const ui=await webview([provider()],database,{discover:async()=>{
    attempt++;
    if(attempt===1)throw Error('Retry endpoint: RECOVERY-KEY');
    return {models:[{id:'recovered-model',name:'Recovered'}],warnings:attempt===2?['Check endpoint: RECOVERY-KEY']:[]};
  }});
  await ui.emit('api-key','input',{value:'  RECOVERY-KEY  '});
  await ui.emit('refresh-models','click');
  assert.deepEqual(shownModels(ui),['unknown-id','another-id']);
  assert.match(ui.get('provider-error').textContent,/Retry endpoint/);
  assert.doesNotMatch(ui.get('provider-error').textContent,/RECOVERY-KEY/);
  assert.equal(ui.get('api-key').value,'  RECOVERY-KEY  ');
  await ui.emit('refresh-models','click');
  assert.deepEqual(shownModels(ui),['recovered-model']);
  assert.match(ui.get('provider-error').textContent,/Check endpoint/);
  assert.doesNotMatch(ui.get('provider-error').textContent,/RECOVERY-KEY/);
  assert.equal(ui.get('toast').hidden,true);
  await ui.emit('refresh-models','click');
  assert.equal(ui.get('provider-error').hidden,true);
  assert.equal(ui.get('toast').hidden,true);
  assert.equal(ui.get('request-status').textContent,'');
  assert.equal(ui.get('model-list').attributes.get('aria-busy'),'false');
  await ui.saved();
  assert.equal(ui.state.providers[0].hasKey,true);
});
test('removing a model changes the draft immediately while supplier deletion still asks for confirmation',async()=>{
  const ui=await webview([provider()]);
  const row=ui.elements.get('model-list').querySelector('[data-model-id="unknown-id"]');
  await ui.emit('model-list','click',{},row.querySelector('.remove-model'));
  assert.deepEqual(shownModels(ui),['another-id']);
  assert.equal(ui.elements.get('confirm-dialog').open,false);
  assert.equal(ui.get('save-provider').disabled,false);
  assert.equal(ui.state.providers[0].models.length,2);
  assert.equal(ui.messages.some(message=>message.command==='saveProvider'),false);
  await ui.emit('provider-form','submit');
  assert.deepEqual(ui.state.providers[0].models.map(item=>item.id),['another-id']);
  await ui.emit('delete-provider','click');
  assert.equal(ui.elements.get('confirm-dialog').open,true);
  assert.equal(ui.messages.some(message=>message.command==='deleteProvider'),false);
});
test('model edits retain optional input limits and independent names and allow output equal to context',async()=>{
  const configured={...model('gpt-ui'),name:'Independent',overrides:{contextWindow:1000,maxInputTokens:800,maxOutputTokens:1000,thinking:true,supportsReasoningEffort:['low','high']},reasoningEffort:'high'};
  const ui=await webview([{...provider(),models:[configured]}]);
  await ui.editModel('gpt-ui');
  assert.equal(ui.elements.get('max-input').value,'800');
  assert.equal(ui.elements.get('reasoning-effort').value,'high');
  await ui.emit('model-name','input',{value:'Renamed only'});
  await ui.emit('model-form','submit');
  assert.equal(ui.elements.get('model-dialog').open,false);
  await ui.emit('provider-form','submit');
  const saved=ui.state.providers[0].models[0];
  assert.equal(saved.id,'gpt-ui');
  assert.equal(saved.name,'Renamed only');
  assert.equal(saved.overrides.maxInputTokens,800);
  assert.equal(saved.overrides.maxOutputTokens,1000);
  assert.equal(saved.reasoningEffort,'high');
  await ui.editModel('gpt-ui');
  for(const input of ['', '0','-1','1001','1.5']){
    await ui.emit('max-input','input',{value:input});
    await ui.emit('model-form','submit');
    assert.equal(ui.elements.get('model-dialog').open,true,`Rejected input ${input}`);
    assert.equal(ui.elements.get('model-error').hidden,false);
  }
  await ui.emit('max-input','input',{value:'1000'});
  await ui.emit('model-form','submit');
  assert.equal(ui.elements.get('model-dialog').open,false);
});
test('preset input limits survive unrelated edits and blank model input derives context minus one',async()=>{
  const db=structuredClone(database);
  db.models['gpt-ui']={...db.defaults,name:'Preset',contextWindow:1000,maxOutputTokens:200,maxInputTokens:900,releaseDate:'2026-01-01'};
  const ui=await webview([{...provider(),models:[model('gpt-ui')]}],db);
  await ui.editModel('gpt-ui');
  assert.equal(ui.elements.get('max-input').value,'900');
  await ui.emit('model-name','input',{value:'Local label'});
  await ui.emit('model-form','submit');
  await ui.emit('provider-form','submit');
  assert.equal(Object.hasOwn(ui.state.providers[0].models[0].overrides,'maxInputTokens'),false);
  await ui.editModel('gpt-ui');
  assert.equal(ui.elements.get('max-input').value,'900');
  await ui.emit('max-input','input',{value:''});
  await ui.emit('model-form','submit');
  await ui.emit('provider-form','submit');
  assert.equal(ui.state.providers[0].models[0].overrides.maxInputTokens,999);
  await ui.editModel('gpt-ui');
  await ui.emit('reset-model','click');
  assert.equal(ui.elements.get('max-input').value,'900');
});
test('state pushes preserve dirty routing, key input and the open model editor',async()=>{
  const ui=await webview([{...splitProvider(),hasKey:true,models:[model('gpt-ui')]}]);
  await ui.emit('responses-url','input',{value:'https://draft.example.com/v1'});
  await ui.emit('api-key','input',{value:'DRAFT-KEY'});
  await ui.choose('gpt-ui');
  await ui.move('chatCompletions');
  await ui.editModel('gpt-ui');
  await ui.emit('model-name','input',{value:'Unapplied name'});
  const next=ui.state;next.revision++;next.providers[0].name='Remote name';next.providers[0].endpoints.responses='https://remote.example.com/v1';
  await ui.pushState(next);
  assert.equal(ui.get('responses-url').value,'https://draft.example.com/v1');
  assert.equal(ui.elements.get('api-key').value,'DRAFT-KEY');
  assert.deepEqual(inProtocol(ui,'chatCompletions'),['gpt-ui']);
  assert.equal(ui.elements.get('model-name').value,'Unapplied name');
  assert.equal(ui.elements.get('model-dialog').open,true);
  assert.equal(ui.elements.get('model-update').hidden,false);
  assert.equal(ui.elements.get('update-banner').hidden,false);
  await ui.emit('model-form','submit');
  await ui.emit('provider-form','submit');
  assert.equal(ui.elements.get('confirm-dialog').open,true);
  await ui.emit('confirm-action','click');
  assert.equal(ui.state.providers[0].endpoints.responses,'https://draft.example.com/v1');
  assert.equal(ui.state.providers[0].modelProtocols['gpt-ui'],'chatCompletions');
  assert.equal(ui.state.providers[0].models[0].name,'Unapplied name');
  assert.equal(ui.elements.get('api-key').value,'');
});
test('unsupported stored reasoning effort no longer blocks supplier edits',async()=>{
  const ui=await webview([{...provider(),models:[{...model('gpt-ui'),overrides:{thinking:true,supportsReasoningEffort:['low']},reasoningEffort:'obsolete'}]}]);
  await ui.emit('provider-name','input',{value:'Updated supplier'});
  await ui.emit('provider-form','submit');
  assert.equal(ui.get('save-provider').disabled,false);
  assert.equal(Object.hasOwn(ui.state.providers[0].models[0],'reasoningEffort'),false);
});
test('fifty models share one viewport and repeated mode changes do not duplicate endpoint controls',async()=>{
  const models=Array.from({length:50},(_,index)=>model(`${['gpt','claude','custom'][index%3]}-fixture-${index}`));
  const ui=await webview([{...provider(),models}]);
  for(let repeat=0;repeat<3;repeat++){
    assert.equal(shownModels(ui).length,50);
    assert.equal(ui.get('model-scroll').children.length,50);
    await ui.mode('split');
    assert.equal(ui.get('model-scroll').children.length,3);
    assert.equal(ui.get('model-list').querySelectorAll('.protocol-models').length,3);
    assert.equal(shownModels(ui).length,50);
    assert.equal(new Set(shownModels(ui)).size,50);
    const controls=ui.get('model-list').querySelectorAll('input,select,button,h4').filter(item=>item.id);
    assert.equal(new Set(controls.map(item=>item.id)).size,controls.length);
    assert.equal(ui.get('model-list').querySelectorAll('.protocol-card').length,3);
    assert.equal(ui.get('model-list').querySelectorAll('.protocol-controls').length,3);
    assert.equal(ui.get('model-scroll').querySelectorAll('[data-endpoint]').length,0,'Protocol controls must be outside the model-row scroll viewport');
    for(const controls of ui.get('model-list').querySelectorAll('.protocol-controls')){
      assert.equal(controls.querySelectorAll('[data-endpoint]').length,1);
      assert.equal(ui.get('model-scroll').contains(controls),false);
    }
    await ui.mode('unified');
    assert.equal(ui.get('model-list').querySelectorAll('[data-endpoint]').length,0);
  }
  await ui.emit('unified-url','change',{value:'https://changed.example.com/v1'});
  assert.equal((await ui.saved()).unified.url,'https://changed.example.com/v1');
});
test('split columns group models by family in provider order with no provider protocol selector',async()=>{
  const ids=['gpt-old','claude-one','gpt-new','custom-new','gemini-one','gpt-undated','gpt-image-2','kling-v3'];
  const ui=await webview([{...splitProvider(),models:ids.map(model)}]);
  assert.deepEqual(ui.get('model-list').querySelectorAll('[data-protocol]').map(column=>column.dataset.protocol),vendors.apiTypes);
  assert.deepEqual(inProtocol(ui,'responses'),['gpt-old','gpt-new','gpt-undated']);
  assert.deepEqual(inProtocol(ui,'chatCompletions'),['custom-new','gemini-one']);
  assert.deepEqual(inProtocol(ui,'messages'),['claude-one']);
  assert.equal(new Set(shownModels(ui)).size,6);
  assert.deepEqual(shownGroups(ui),[]);
  assert.equal(ui.get('unified-endpoint').hidden,true);
  assert.match(html,/<div id="unified-endpoint"[^>]*>\s*<div[^>]*><label for="unified-api-type">/);
  assert.doesNotMatch(html,/供应商默认协议|恢复继承|继承供应商默认/);
  assert.equal(ui.get('model-list').querySelectorAll('.protocol-inheritance').length,0);
  assert.equal(ui.get('model-selection').hidden,true);
  assert.equal(ui.get('model-total').textContent,'6');
  for(const apiType of vendors.apiTypes){
    assert.equal(ui.get(`move-to-${apiType}`).hidden,true);
    assert.equal(ui.get(`select-all-${apiType}`).disabled,false);
  }
  const input=ui.get('responses-url');input.focus();
  await ui.emit('responses-url','input',{value:'https://typing.example.com/v1'});
  assert.equal(ui.get('responses-url'),input,'Endpoint typing must not recreate the focused input');
  assert.equal(ui.activeElement,input);
  await ui.emit('responses-url','change',{value:'https://changed.example.com/v1'});
  assert.equal(ui.get('responses-url'),input);
  const saved=await ui.saved();
  assert.equal(saved.endpoints.responses,'https://changed.example.com/v1');
});
test('checkboxes select independently of model editing and transfers preserve settings and endpoints',async()=>{
  const custom={...model('gpt-one'),name:'My model',overrides:{vision:true}};
  const ui=await webview([{...splitProvider(),modelProtocols:explicitProtocols(['gpt-one','gpt-two','claude-one']),models:[custom,model('gpt-two'),model('claude-one')]}]);
  const before=await ui.saved();
  const checkbox=ui.get('model-list').querySelector('[data-select-model="gpt-one"]');
  await ui.emit('model-list','click',{},checkbox);
  await ui.choose('gpt-one');
  assert.equal(ui.get('model-dialog').open,false);
  assert.equal(ui.get('save-provider').disabled,false);
  assert.equal(ui.get('select-all-responses').indeterminate,true);
  assert.equal(ui.get('select-all-responses').checked,false);
  assert.equal(ui.get('model-selection-count').textContent,'已选 1');
  assert.equal(ui.get('move-to-messages').disabled,false);
  await ui.move('messages');
  assert.deepEqual(inProtocol(ui,'responses'),['gpt-two']);
  assert.deepEqual(inProtocol(ui,'messages'),['gpt-one','claude-one']);
  assert.equal(ui.get('model-list').querySelector('[data-select-model="gpt-one"]').checked,true);
  assert.equal(ui.get('model-selection-count').textContent,'已选 1');
  assert.equal(ui.get('select-all-messages').indeterminate,true);
  assert.equal(ui.get('confirm-dialog').open,false);
  const moved=await ui.saved();
  assert.deepEqual(moved.models,before.models);
  assert.deepEqual(moved.endpoints,before.endpoints);
  assert.equal(moved.modelProtocols['gpt-one'],'messages');
  assert.equal(moved.modelProtocols['gpt-two'],'responses');
  await ui.emit('select-all-messages','change',{checked:true});
  assert.equal(ui.get('select-all-messages').indeterminate,false);
  assert.equal(ui.get('model-selection-count').textContent,'已选 2');
  await ui.emit('select-all-messages','change',{checked:false});
  assert.equal(ui.get('model-selection').hidden,true);
  await ui.emit('select-all-messages','change',{checked:true});
  await ui.move('chatCompletions');
  await ui.emit('provider-form','submit');
  const saved=ui.state.providers[0];
  assert.equal(saved.modelProtocols['gpt-one'],'chatCompletions');
  assert.equal(saved.modelProtocols['claude-one'],'chatCompletions');
  assert.deepEqual(saved.models[0],custom);
  assert.deepEqual(inProtocol(await webview([saved]),'chatCompletions'),['gpt-one','claude-one']);
});
test('one destination moves selected IDs across sources, skips resident models and preserves order and focus',async()=>{
  const models=['custom-selected','gpt-stay','claude-selected','gpt-selected','custom-stay'].map(id=>({...model(id),name:`Name ${id}`,overrides:{maxOutputTokens:16000,defaultOutputTokens:4000,thinking:true,supportsReasoningEffort:['low','high']},reasoningEffort:'high'}));
  const ui=await webview([{...splitProvider(),models,modelProtocols:explicitProtocols(models.map(model=>model.id))}]);
  for(const id of ['gpt-selected','claude-selected','custom-selected'])await ui.choose(id);
  assert.equal(ui.get('model-selection-count').textContent,'已选 3');
  assert.match(ui.get('move-to-messages').attributes.get('aria-label'),/2.*Messages/);
  assert.equal(ui.get('move-to-messages').querySelector('span').textContent,'移到这里 · 2');
  await ui.move('messages');
  assert.deepEqual(inProtocol(ui,'messages'),['custom-selected','claude-selected','gpt-selected']);
  assert.deepEqual(inProtocol(ui,'responses'),['gpt-stay']);
  assert.deepEqual(inProtocol(ui,'chatCompletions'),['custom-stay']);
  assert.equal(ui.get('model-selection-count').textContent,'已选 3');
  assert.equal(ui.get('select-all-messages').checked,true);
  assert.equal(ui.activeElement.dataset.selectModel,'custom-selected');
  assert.equal(ui.get('move-to-messages').disabled,true);
  assert.match(ui.get('model-selection-status').textContent,/已将 2 个模型移到 Messages/);
  assert.equal(ui.get('toast').hidden,true);
  const focused=ui.activeElement;
  await ui.move('messages');
  assert.equal(ui.activeElement,focused,'Already-resident selections must not trigger a render or transfer');
  for(const id of ['custom-selected','claude-selected','gpt-selected']){
    const checkbox=ui.get('model-list').querySelector(`[data-select-model="${id}"]`);
    assert.equal(checkbox.checked,true);
    assert.match(checkbox.closest('[data-model-id]').className,/selected/);
  }
  const saved=await ui.saved();
  assert.deepEqual(saved.models,models);
  for(const id of ['custom-selected','claude-selected','gpt-selected'])assert.equal(saved.modelProtocols[id],'messages');
  assert.equal(saved.modelProtocols['gpt-stay'],'responses');
  assert.equal(saved.modelProtocols['custom-stay'],'chatCompletions');
});
test('column select-all stays scoped and explicit clearing restores focus without changing routes',async()=>{
  const ids=['gpt-one','gpt-two','claude-one','custom-one'];
  const ui=await webview([{...splitProvider(),models:ids.map(model),modelProtocols:explicitProtocols(ids)}]);
  await ui.choose('claude-one');
  await ui.choose('gpt-one');
  assert.equal(ui.get('select-all-responses').indeterminate,true);
  await ui.emit('select-all-responses','change',{checked:true});
  assert.equal(ui.get('model-selection-count').textContent,'已选 3');
  await ui.emit('select-all-responses','change',{checked:false});
  assert.equal(ui.get('model-selection-count').textContent,'已选 1');
  assert.equal(ui.get('model-list').querySelector('[data-select-model="claude-one"]').checked,true);
  await ui.emit('clear-model-selection','click');
  assert.equal(ui.get('model-selection').hidden,true);
  assert.equal(ui.get('model-selection-status').textContent,'已选 0 个模型');
  assert.equal(ui.get('model-list').querySelectorAll('input:checked').length,0);
  assert.equal(ui.activeElement,ui.get('model-scroll'));
  for(const apiType of vendors.apiTypes)assert.equal(ui.get(`move-to-${apiType}`).hidden,true);
  const saved=await ui.saved();
  assert.equal(saved.modelProtocols['gpt-one'],'responses');
  assert.equal(saved.modelProtocols['claude-one'],'messages');
});
test('unified selection supports indeterminate select-all, clearing and focus without transfer controls',async()=>{
  const input={...provider(),modelProtocols:{'unknown-id':'messages','another-id':'responses'}};
  const ui=await webview([input]);
  const checkbox=ui.get('model-list').querySelector('[data-select-model="unknown-id"]');
  await ui.emit('model-list','click',{},checkbox);
  await ui.choose('unknown-id');
  assert.equal(ui.get('model-dialog').open,false);
  assert.equal(ui.get('model-selection-count').textContent,'已选 1');
  assert.equal(ui.get('select-all-unified').indeterminate,true);
  assert.equal(ui.get('select-all-unified').checked,false);
  assert.equal(ui.get('model-selection-target').hidden,true);
  assert.equal(ui.get('model-list').querySelectorAll('[data-move-to]').length,0);
  await ui.emit('select-all-unified','change',{checked:true});
  assert.equal(ui.get('model-selection-count').textContent,'已选 2');
  assert.equal(ui.get('select-all-unified').checked,true);
  assert.equal(ui.get('select-all-unified').indeterminate,false);
  await ui.emit('select-all-unified','change',{checked:false});
  assert.equal(ui.get('model-selection').hidden,true);
  assert.equal(ui.get('delete-selected-models').disabled,true);
  await ui.choose('unknown-id');
  await ui.emit('clear-model-selection','click');
  assert.equal(ui.activeElement,ui.get('model-scroll'));
  assert.equal(ui.get('model-selection-status').textContent,'已选 0 个模型');
  assert.equal(ui.get('select-all-unified').indeterminate,false);
  assert.equal(ui.get('model-list').querySelectorAll('input:checked').length,0);
  assert.deepEqual((await ui.saved()).modelProtocols,input.modelProtocols);
});
for(const mode of ['unified','split']){
  test(`${mode} batch deletion confirms its count, supports cancellation and changes only selected draft models`,async()=>{
    const kept={...model('custom-keep'),name:'My model',overrides:{thinking:true,supportsReasoningEffort:['high'],maxOutputTokens:16000},reasoningEffort:'high'};
    const input={...provider(),routingMode:mode,models:[kept,model('gpt-remove'),model('claude-remove'),model('last-keep')],modelProtocols:{'custom-keep':'messages','gpt-remove':'chatCompletions','claude-remove':'responses','last-keep':'messages'}};
    const ui=await webview([input]);
    await ui.emit('api-key','input',{value:'KEEP-DRAFT-KEY'});
    await ui.choose('gpt-remove');
    await ui.choose('claude-remove');
    assert.equal(ui.get('model-selection-target').hidden,mode==='unified');
    const beforeModels=shownModels(ui);
    const beforeState=ui.state;
    ui.get('delete-selected-models').focus();
    await ui.emit('delete-selected-models','click');
    assert.equal(ui.get('confirm-dialog').open,true);
    assert.match(ui.get('confirm-message').textContent,/2 个模型.*保存供应商后生效/);
    assert.deepEqual(shownModels(ui),beforeModels);
    await ui.emit('confirm-cancel','click');
    assert.equal(ui.get('confirm-dialog').open,false);
    assert.equal(ui.activeElement,ui.get('delete-selected-models'));
    assert.equal(ui.get('model-selection-count').textContent,'已选 2');
    assert.deepEqual(shownModels(ui),beforeModels);
    await ui.emit('delete-selected-models','click');
    await ui.emit('confirm-action','click');
    assert.deepEqual(shownModels(ui),['custom-keep','last-keep']);
    assert.equal(ui.get('model-total').textContent,'2');
    assert.equal(ui.get('model-selection').hidden,true);
    assert.equal(ui.get('delete-selected-models').disabled,true);
    assert.equal(ui.get('model-list').querySelectorAll('input:checked').length,0);
    assert.equal(ui.activeElement,ui.get('model-scroll'));
    assert.equal(ui.get('api-key').value,'KEEP-DRAFT-KEY');
    assert.deepEqual(ui.state,beforeState);
    assert.deepEqual(ui.messages.map(message=>message.command),['getState'],'Deletion must not call the backend');
    if(mode==='split')for(const apiType of vendors.apiTypes)assert.equal(ui.get(`move-to-${apiType}`).hidden,true);
    const saved=await ui.saved();
    assert.deepEqual(saved.models,[kept,model('last-keep')]);
    assert.deepEqual(saved.modelProtocols,{'custom-keep':'messages','last-keep':'messages'});
    assert.deepEqual(saved.endpoints,input.endpoints);
    assert.deepEqual(saved.unified,input.unified);
    assert.equal(ui.messages.at(-1).payload.apiKey,'KEEP-DRAFT-KEY');
    assert.deepEqual(shownModels(await webview(ui.state.providers)),['custom-keep','last-keep']);
  });
  test(`${mode} batch deletion can remove all models and empty selections do nothing`,async()=>{
    const ui=await webview([{...provider(),routingMode:mode,models:['gpt-one','claude-one','custom-one'].map(model)}]);
    await ui.emit('delete-selected-models','click');
    assert.equal(ui.get('confirm-dialog').open,false);
    if(mode==='unified')await ui.emit('select-all-unified','change',{checked:true});
    else for(const apiType of vendors.apiTypes)await ui.emit(`select-all-${apiType}`,'change',{checked:true});
    assert.equal(ui.get('model-selection-count').textContent,'已选 3');
    await ui.emit('delete-selected-models','click');
    assert.match(ui.get('confirm-message').textContent,/3 个模型/);
    await ui.emit('confirm-action','click');
    assert.deepEqual(shownModels(ui),[]);
    assert.equal(ui.get('model-total').textContent,'0');
    assert.equal(ui.get('delete-selected-models').disabled,true);
    assert.equal(ui.get('model-selection').hidden,true);
    const selectIds=mode==='unified'?['select-all-unified']:vendors.apiTypes.map(apiType=>`select-all-${apiType}`);
    for(const id of selectIds){
      assert.equal(ui.get(id).disabled,true);
      assert.equal(ui.get(id).checked,false);
      assert.equal(ui.get(id).indeterminate,false);
    }
    await ui.emit('delete-selected-models','click');
    assert.equal(ui.get('confirm-dialog').open,false);
    assert.equal(ui.messages.some(message=>message.command==='saveProvider'),false);
    const saved=await ui.saved();
    assert.deepEqual(saved.models,[]);
    assert.deepEqual(saved.modelProtocols,{});
    assert.equal(saved.enabled,true);
  });
}
test('batch selections cannot bleed across suppliers or protocol modes',async()=>{
  const ui=await webview([provider('one'),splitProvider('two')]);
  await ui.choose('unknown-id');
  await ui.select('two');
  assert.equal(ui.get('model-selection').hidden,true);
  await ui.choose('another-id');
  await ui.mode('unified');
  assert.equal(ui.get('model-selection').hidden,true);
  await ui.choose('unknown-id');
  await ui.mode('split');
  assert.equal(ui.get('model-selection').hidden,true);
  await ui.choose('another-id');
  await ui.select('one');
  assert.equal(ui.get('model-selection').hidden,true);
  await ui.emit('delete-selected-models','click');
  assert.equal(ui.get('confirm-dialog').open,false);
  await ui.choose('unknown-id');
  await ui.emit('delete-selected-models','click');
  await ui.emit('confirm-action','click');
  await ui.select('two');
  assert.equal(ui.get('model-selection').hidden,true);
  assert.deepEqual(shownModels(ui),['unknown-id','another-id']);
  await ui.select('one');
  assert.deepEqual(shownModels(ui),['another-id']);
  assert.deepEqual(ui.messages.map(message=>message.command),['getState']);
});
test('editing selected IDs preserves other selections and assigned protocols',async()=>{
  const ui=await webview([{...splitProvider(),models:['custom-one','custom-two'].map(model),modelProtocols:{'custom-one':'messages','custom-two':'responses'}}]);
  await ui.choose('custom-one');
  await ui.choose('custom-two');
  await ui.editModel('custom-one');
  await ui.emit('model-id','input',{value:'renamed-one'});
  await ui.emit('model-form','submit');
  assert.equal(ui.get('model-selection-count').textContent,'已选 2');
  assert.equal(ui.get('model-list').querySelector('[data-select-model="renamed-one"]').checked,true);
  assert.equal(ui.get('model-list').querySelector('[data-select-model="custom-two"]').checked,true);
  assert.deepEqual(inProtocol(ui,'messages'),['renamed-one']);
  const saved=await ui.saved();
  assert.deepEqual(saved.models.map(item=>item.id),['renamed-one','custom-two']);
  assert.equal(saved.modelProtocols['renamed-one'],'messages');
  assert.equal(Object.hasOwn(saved.modelProtocols,'custom-one'),false);
});
test('browser applies exclusions and saved assignments survive changes to family rules',async()=>{
  const rules=structuredClone(modelRules);
  rules.models['custom-one']={protocol:'messages'};
  rules.models['custom-hidden']={excludedKind:'non-chat'};
  const input={...splitProvider(),models:['custom-one','custom-hidden'].map(model)};
  const ui=await webview([input],database,{modelRules:rules});
  assert.deepEqual(inProtocol(ui,'messages'),['custom-one']);
  assert.deepEqual(shownModels(ui),['custom-one']);
  await ui.saved();
  const next=ui.state;
  next.revision++;
  next.modelRules.models['custom-one'].protocol='responses';
  await ui.pushState(next);
  assert.deepEqual(inProtocol(ui,'messages'),['custom-one']);
  assert.deepEqual(inProtocol(ui,'responses'),[]);
});
test('mode toggles preserve custom model routes, all addresses and the common key',async()=>{
  const input={...splitProvider(),modelProtocols:{'gpt-one':'messages','claude-one':'responses'},models:[model('gpt-one'),model('claude-one'),model('custom-one')]};
  const ui=await webview([input]);
  await ui.emit('api-key','input',{value:'ONE-KEY'});
  await ui.choose('gpt-one');
  await ui.mode('unified');
  assert.equal(ui.get('unified-endpoint').hidden,false);
  assert.deepEqual(shownGroups(ui),[]);
  assert.deepEqual(shownModels(ui),['gpt-one','claude-one','custom-one']);
  await ui.emit('unified-api-type','change',{value:'responses'});
  await ui.emit('unified-url','input',{value:'https://single.example.com/v1'});
  await ui.mode('split');
  assert.equal(ui.get('model-list').querySelectorAll('input:checked').length,0);
  assert.deepEqual(inProtocol(ui,'messages'),['gpt-one']);
  assert.deepEqual(inProtocol(ui,'responses'),['claude-one']);
  assert.deepEqual(inProtocol(ui,'chatCompletions'),['custom-one']);
  assert.equal(ui.get('api-key').value,'ONE-KEY');
  assert.equal(ui.get('confirm-dialog').open,false);
  await ui.mode('unified');
  const exported=await ui.saved();
  assert.deepEqual(exported.endpoints,input.endpoints);
  assert.equal(exported.modelProtocols['gpt-one'],'messages');
  assert.equal(exported.unified.apiType,'responses');
  assert.doesNotMatch(JSON.stringify(exported),/ONE-KEY/);
  await ui.emit('provider-form','submit');
  const save=ui.messages.find(message=>message.command==='saveProvider');
  assert.equal(save.payload.apiKey,'ONE-KEY');
  assert.equal(ui.get('api-key').value,'');
  const reloaded=await webview(ui.state.providers);
  assert.equal(reloaded.get('unified-url').value,'https://single.example.com/v1');
  await reloaded.mode('split');
  assert.deepEqual(inProtocol(reloaded,'responses'),['claude-one']);
  assert.deepEqual(inProtocol(reloaded,'chatCompletions'),['custom-one']);
  assert.deepEqual(inProtocol(reloaded,'messages'),['gpt-one']);
});
test('first split can seed empty endpoints but never overwrites partial or subsequently cleared addresses',async()=>{
  const endpoints={responses:'',chatCompletions:'',messages:''};
  const input={...provider(),endpoints,models:[]};
  const ui=await webview([input]);
  await ui.mode('split');
  for(const field of ['responses-url','chat-completions-url','messages-url'])assert.equal(ui.get(field).value,input.unified.url);
  for(const field of ['responses-url','chat-completions-url','messages-url'])await ui.emit(field,'input',{value:''});
  await ui.mode('unified');
  await ui.mode('split');
  assert.deepEqual((await ui.saved()).endpoints,endpoints);
  for(const populated of vendors.apiTypes){
    const partial={...endpoints,[populated]:'https://keep.example.com/v1'};
    const ui=await webview([{...input,endpoints:partial}]);
    await ui.mode('split');
    assert.deepEqual((await ui.saved()).endpoints,partial);
  }
  const empty=await webview([]);
  await empty.emit('add-provider','click');
  assert.equal(empty.get('routing-unified').checked,true);
  assert.equal(empty.get('unified-api-type').value,'chatCompletions');
  assert.equal(empty.get('unified-url').value,'');
});
test('split refresh resets family assignments and preserves matching settings, addresses and key',async()=>{
  const retained={...model('gpt-retained'),name:'Saved name',overrides:{contextWindow:100000,maxInputTokens:80000,maxOutputTokens:16000,defaultOutputTokens:4000,vision:true,thinking:true,supportsReasoningEffort:['low','high']},reasoningEffort:'high'};
  const input={...splitProvider(),models:[retained,model('claude-retained'),model('unknown-retained'),model('gpt-removed')],modelProtocols:{'gpt-retained':'messages','claude-retained':'chatCompletions','unknown-retained':'responses','gpt-removed':'chatCompletions'}};
  const discovered=['unknown-retained','gpt-new','gpt-retained','claude-retained','claude-new','unknown-new'];
  const ui=await webview([input],database,{discovery:{models:discovered.map(id=>({id,name:`Upstream ${id}`}))}});
  assert.equal(ui.get('refresh-models-label').textContent,'刷新');
  assert.match(ui.get('refresh-models').title,/按模型系列重新分配协议/);
  await ui.emit('api-key','input',{value:'  KEEP-KEY  '});
  await ui.choose('gpt-retained');
  await ui.emit('refresh-models','click');
  const payload=ui.messages.find(message=>message.command==='discoverModels').payload;
  const request=payload.provider;
  assert.equal(request.routingMode,'split');
  assert.deepEqual(request.endpoints,input.endpoints);
  assert.equal(request.modelProtocols['gpt-retained'],'messages');
  assert.equal(payload.apiKey,'KEEP-KEY');
  assert.deepEqual(inProtocol(ui,'responses'),['gpt-new','gpt-retained']);
  assert.deepEqual(inProtocol(ui,'messages'),['claude-retained','claude-new']);
  assert.deepEqual(inProtocol(ui,'chatCompletions'),['unknown-retained','unknown-new']);
  assert.equal(ui.get('model-list').querySelectorAll('input:checked').length,0);
  assert.equal(ui.get('api-key').value,'  KEEP-KEY  ');
  assert.equal(ui.get('toast').hidden,true);
  assert.equal(ui.messages.some(message=>message.command==='saveProvider'),false);
  assert.deepEqual(ui.state.providers[0],{hasKey:false,...input});
  const next=await ui.saved();
  assert.deepEqual(next.models.map(model=>model.id),discovered,'Resetting routes must keep the existing discovery order');
  assert.deepEqual(next.models.find(model=>model.id==='gpt-retained'),{...retained,discoveredName:'Upstream gpt-retained'});
  assert.deepEqual(next.endpoints,input.endpoints);
  assert.deepEqual(next.unified,input.unified);
  assert.equal(Object.hasOwn(next.modelProtocols,'gpt-removed'),false);
  assert.deepEqual(next.modelProtocols,{'unknown-retained':'chatCompletions','gpt-new':'responses','gpt-retained':'responses','claude-retained':'messages','claude-new':'messages','unknown-new':'chatCompletions'});
  await ui.emit('provider-form','submit');
  assert.deepEqual(ui.state.providers[0],{...next,hasKey:true});
});
test('split refresh applies exact-ID protocol rules',async()=>{
  const rules=structuredClone(modelRules);
  rules.models['custom-retained']={protocol:'responses'};
  const input={...splitProvider(),models:[model('custom-retained')],modelProtocols:{'custom-retained':'messages'}};
  const ui=await webview([input],database,{modelRules:rules,discovery:{models:[{id:'custom-retained',name:'Custom'}]}});
  await ui.emit('refresh-models','click');
  assert.deepEqual(inProtocol(ui,'responses'),['custom-retained']);
  assert.deepEqual(inProtocol(ui,'messages'),[]);
  assert.deepEqual(ui.state.modelRules,rules);
});
test('failed split refresh keeps routes, overrides, endpoints, key and selected models intact',async()=>{
  for(const options of [{discoveryError:'Endpoint failed'},{discovery:{models:[{id:'new-model',name:'New'},{id:'bad id',name:'Invalid'}]}},{discovery:{models:[],warnings:[false]}}]){
    const retained={...model('gpt-retained'),name:'My name',overrides:{thinking:true,supportsReasoningEffort:['high'],maxOutputTokens:16000},reasoningEffort:'high'};
    const input={...splitProvider(),models:[retained,model('claude-retained')],modelProtocols:{'gpt-retained':'messages','claude-retained':'responses'}};
    const ui=await webview([input],database,options);
    await ui.emit('api-key','input',{value:'  KEEP-KEY  '});
    await ui.choose('gpt-retained');
    const before=ui.state;
    await ui.emit('refresh-models','click');
    assert.deepEqual(ui.state,before);
    assert.deepEqual(inProtocol(ui,'messages'),['gpt-retained']);
    assert.deepEqual(inProtocol(ui,'responses'),['claude-retained']);
    assert.equal(ui.get('model-list').querySelector('[data-select-model="gpt-retained"]').checked,true);
    assert.equal(ui.get('model-selection-count').textContent,'已选 1');
    assert.equal(ui.get('api-key').value,'  KEEP-KEY  ');
    assert.equal(ui.get('provider-error').hidden,false);
    assert.equal(ui.get('toast').hidden,true);
    assert.equal(ui.messages.some(message=>message.command==='saveProvider'),false);
    assert.deepEqual(await ui.saved(),input);
  }
});
test('unified discovery keeps its active route and resets future split assignments by family',async()=>{
  const input={...provider(),unified:{apiType:'messages',url:'https://unified.example.com'},models:[model('gpt-retained')],modelProtocols:{'gpt-retained':'chatCompletions'}};
  const ui=await webview([input],database,{discovery:{models:[{id:'gpt-retained',name:'Retained'},{id:'gpt-new',name:'New'}]}});
  assert.equal(ui.get('refresh-models-label').textContent,'刷新');
  assert.match(ui.get('refresh-models').title,/按模型系列重新分配协议/);
  await ui.emit('refresh-models','click');
  const payload=ui.messages.find(message=>message.command==='discoverModels').payload;
  assert.equal(payload.provider.routingMode,'unified');
  assert.deepEqual(payload.provider.unified,input.unified);
  assert.deepEqual(payload.provider.endpoints,input.endpoints);
  assert.deepEqual((await ui.saved()).modelProtocols,{'gpt-retained':'responses','gpt-new':'responses'});
  await ui.mode('split');
  assert.deepEqual(inProtocol(ui,'responses'),['gpt-retained','gpt-new']);
  assert.deepEqual(inProtocol(ui,'messages'),[]);
  assert.deepEqual(inProtocol(ui,'chatCompletions'),[]);
});
test('switching clears selections while deleting a different model and failed refresh preserve them',async()=>{
  const ui=await webview([splitProvider('one'),splitProvider('two')],database,{discoveryError:'Unavailable'});
  await ui.choose('unknown-id');
  await ui.select('two');
  await ui.choose('another-id');
  await ui.select('one');
  assert.equal(ui.get('model-list').querySelectorAll('input:checked').length,0);
  await ui.select('two');
  assert.equal(ui.get('model-list').querySelectorAll('input:checked').length,0);
  await ui.choose('unknown-id');
  const remove=ui.get('model-list').querySelector('[data-model-id="another-id"]').querySelector('.remove-model');
  await ui.emit('model-list','click',{},remove);
  assert.equal(ui.get('model-list').querySelector('[data-select-model="unknown-id"]').checked,true);
  assert.equal(ui.get('model-selection-count').textContent,'已选 1');
  assert.equal(ui.get('confirm-dialog').open,false);
  assert.deepEqual(shownModels(ui),['unknown-id']);
  await ui.choose('unknown-id');
  await ui.emit('refresh-models','click');
  assert.equal(ui.get('model-list').querySelector('[data-select-model="unknown-id"]').checked,true);
  assert.equal(ui.get('model-selection-count').textContent,'已选 1');
  assert.deepEqual(shownModels(ui),['unknown-id']);
  assert.equal(ui.messages.some(message=>message.command==='saveProvider'),false);
});
test('empty split columns retain their controls and save after an empty refresh',async()=>{
  const ui=await webview([splitProvider()],database,{discovery:{models:[]}});
  await ui.emit('refresh-models','click');
  assert.equal(ui.get('model-list').querySelectorAll('[data-protocol]').length,3);
  for(const apiType of vendors.apiTypes){
    assert.deepEqual(inProtocol(ui,apiType),[]);
    assert.equal(ui.get(`select-all-${apiType}`).disabled,true);
    assert.equal(ui.get(`move-to-${apiType}`).hidden,true);
  }
  await ui.emit('provider-form','submit');
  assert.deepEqual(ui.state.providers[0].models,[]);
  assert.deepEqual(ui.state.providers[0].modelProtocols,{});
});
test('saving validates each assigned protocol, including different routes for the same manufacturer',async()=>{
  const input={...splitProvider(),endpoints:{...provider().endpoints,messages:''},models:[model('gpt-one'),model('gpt-two')],modelProtocols:{'gpt-one':'responses','gpt-two':'messages'}};
  const ui=await webview([input]);
  await ui.emit('provider-name','input',{value:'Changed'});
  await ui.emit('provider-form','submit');
  assert.equal(ui.messages.some(message=>message.command==='saveProvider'),false);
  assert.match(ui.get('provider-error').textContent,/gpt-two.*Messages/);
  assert.equal(ui.activeElement,ui.get('messages-url'));
  await ui.emit('messages-url','input',{value:'https://messages.example.com/v1'});
  await ui.emit('provider-form','submit');
  assert.equal(ui.get('save-provider').disabled,false);
});
test('retired model budgets are excluded from supplier saves while capability overrides survive',async()=>{
  for(const contextSize of [128000,200000,1000000]){
    const db=structuredClone(database);
    db.models['gpt-ui']={...db.defaults,contextWindow:1000001};
    const ui=await webview([{...provider(),models:[{...model('gpt-ui'),contextSize,overrides:{defaultOutputTokens:4096}}]}],db);
    await ui.editModel('gpt-ui');
    await ui.emit('model-name','input',{value:'My label'});
    await ui.emit('model-form','submit');
    await ui.emit('provider-form','submit');
    const saved=ui.state.providers[0].models[0];
    assert.equal(Object.hasOwn(saved,'contextSize'),false);
    assert.equal(saved.overrides.defaultOutputTokens,4096);
    assert.equal(saved.name,'My label');
  }
});
test('obsolete context budgets clear on supplier save and model ID changes retain the selected route',async()=>{
  const ui=await webview([{...splitProvider(),models:[{...model('gpt-ui'),contextSize:500000,overrides:{contextWindow:100000}}],modelProtocols:{'gpt-ui':'messages'}}]);
  await ui.emit('provider-name','input',{value:'New supplier name'});
  await ui.emit('provider-form','submit');
  assert.equal(Object.hasOwn(ui.state.providers[0].models[0],'contextSize'),false);
  await ui.editModel('gpt-ui');
  await ui.emit('model-id','input',{value:'custom-new'});
  await ui.emit('model-form','submit');
  const next=await ui.saved();
  assert.equal(next.modelProtocols['custom-new'],'messages');
  assert.equal(Object.hasOwn(next.modelProtocols,'gpt-ui'),false);
  assert.deepEqual(inProtocol(ui,'messages'),['custom-new']);
});
test('new models get family protocols independently of existing IDs and deletion prunes assignments',async()=>{
  const ui=await webview([{...splitProvider(),models:[model('null')],modelProtocols:{null:'messages'}}]);
  for(const [id,apiType] of [['gpt-added','responses'],['claude-added','messages'],['custom-added','chatCompletions']]){
    await ui.choose('null');
    await ui.emit('add-model','click');
    await ui.emit('model-id','input',{value:id});
    assert.equal(ui.get('model-protocol').value,apiType);
    await ui.emit('model-form','submit');
    assert.equal(ui.get('model-dialog').open,false);
    assert.equal((await ui.saved()).modelProtocols[id],apiType);
    assert.ok(inProtocol(ui,apiType).includes(id));
    assert.equal(ui.get('model-list').querySelectorAll('input:checked').length,0);
  }
  const remove=ui.get('model-list').querySelector('[data-model-id="gpt-added"]').querySelector('.remove-model');
  await ui.emit('model-list','click',{},remove);
  assert.equal(Object.hasOwn((await ui.saved()).modelProtocols,'gpt-added'),false);
  assert.equal(ui.get('confirm-dialog').open,false);
});
test('reasoning picker hides declarative controls that native configuration cannot express',async()=>{
  const db=structuredClone(database);
  db.models.fixture={...db.defaults,thinking:true,supportsReasoningEffort:['none','low','high'],protocols:{chatCompletions:{effortValues:{none:null}}}};
  const ui=await webview([{...provider(),models:[{...model('fixture'),reasoningEffort:'none'}]}],db,{language:'en'});
  await ui.editModel('fixture');
  assert.deepEqual(ui.get('reasoning-effort').children.map(option=>option.value),['','low','high']);
  assert.equal(ui.get('reasoning-effort').value,'');
  assert.match(ui.get('reasoning-note').textContent,/unsupported/);
  await ui.emit('reasoning-effort','change',{value:'high'});
  await ui.emit('model-form','submit');
  assert.equal((await ui.saved()).models[0].reasoningEffort,'high');
});

test('English UI supports editing, validation and protocol transfer without translating user data',async()=>{
  const custom={...model('custom-id'),name:'我的模型 <literal>'};
  const ui=await webview([{...splitProvider(),name:'我的供应商',models:[custom,model('other')]}],database,{language:'en'});
  assert.equal(ui.get('provider-name').value,'我的供应商');
  await ui.choose('custom-id');
  assert.match(ui.get('model-selection-count').textContent,/1/);
  assert.doesNotMatch(ui.get('model-selection-count').textContent,/[\p{Script=Han}]/u);
  await ui.move('responses');
  assert.doesNotMatch(ui.get('model-selection-status').textContent,/[\p{Script=Han}]/u);
  await ui.editModel('custom-id');
  assert.equal(ui.get('model-name').value,custom.name);
  for(const id of ['model-title','apply-model','reasoning-note'])assert.doesNotMatch(ui.get(id).textContent,/[\p{Script=Han}]/u,id);
  await ui.emit('max-output','input',{value:'0'});
  await ui.emit('model-form','submit');
  assert.equal(ui.get('model-error').hidden,false);
  assert.doesNotMatch(ui.get('model-error').textContent,/[\p{Script=Han}]/u);
  await ui.emit('max-output','input',{value:'8192'});
  await ui.emit('model-form','submit');
  const saved=await ui.saved();
  assert.equal(saved.name,'我的供应商');
  assert.equal(saved.models[0].name,custom.name);
  assert.equal(saved.models[0].id,'custom-id');
  assert.equal(saved.modelProtocols['custom-id'],'responses');
});

test('retired retention flags are ignored across discovery, protocol changes and saves',async()=>{
  for(const flag of [true,false,'ignored',null]){
    const input={...provider(),zeroDataRetentionEnabled:flag,statefulResponses:flag,zdr:flag};
    input.models[0].zdr=flag;
    const ui=await webview([input]);
    await ui.emit('refresh-models','click');
    const discovered=ui.messages.find(message=>message.command==='discoverModels').payload.provider;
    for(const key of ['zeroDataRetentionEnabled','statefulResponses','zdr'])assert.equal(Object.hasOwn(discovered,key),false);
    await ui.emit('unified-api-type','change',{value:'responses'});
    const saved=await ui.saved();
    for(const key of ['zeroDataRetentionEnabled','statefulResponses','zdr'])assert.equal(Object.hasOwn(saved,key),false);
    const reloaded=await webview(ui.state.providers);
    assert.deepEqual(await reloaded.saved(),saved);
  }
});

test('one-click preset update preserves provider drafts and sends no credentials',async()=>{
  const updated=structuredClone(database);
  updated.models['new-model']={...updated.defaults,name:'New model',contextWindow:200000};
  const ui=await webview([provider()],database,{language:'en',updatedCatalog:updated});
  await ui.emit('provider-name','input',{value:'Unsaved provider'});
  await ui.emit('api-key','input',{value:'draft-secret-must-stay-local'});
  await ui.emit('update-catalog','click');
  const request=ui.messages.find(message=>message.command==='updateCatalog');
  assert.ok(request);
  assert.equal(JSON.stringify(request).includes('draft-secret'),false);
  assert.equal(Object.keys(request.payload||{}).length,0);
  assert.equal(ui.get('provider-name').value,'Unsaved provider');
  assert.equal(ui.get('api-key').value,'draft-secret-must-stay-local');
  assert.equal(ui.get('toast').hidden,true);
  assert.match(ui.get('update-catalog').title,/Last updated:/);
  await ui.emit('add-model','click');
  await ui.emit('model-id','input',{value:'new-model'});
  assert.equal(ui.get('context-window').value,'200000');
  await ui.emit('model-form','submit');
  assert.equal((await ui.saved()).models.at(-1).id,'new-model');
});

test('preset update failures retain state and drafts and the action can be retried',async()=>{
  let release;
  const options={catalogError:'models.dev unavailable',beforeUpdate:()=>new Promise(resolve=>{release=resolve;})};
  const ui=await webview([provider()],database,options);
  await ui.emit('api-key','input',{value:'local-key'});
  const before=ui.state;
  await ui.emit('update-catalog','click');
  assert.equal(ui.get('update-catalog').disabled,true);
  await ui.emit('update-catalog','click');
  assert.equal(ui.messages.filter(message=>message.command==='updateCatalog').length,1);
  release();await ui.flush();
  assert.deepEqual(ui.state,before);
  assert.equal(ui.get('api-key').value,'local-key');
  assert.equal(ui.get('update-catalog').disabled,false);
  assert.match(ui.get('toast').textContent,/models.dev unavailable/);
  delete options.catalogError;delete options.beforeUpdate;
  await ui.emit('update-catalog','click');
  assert.equal(ui.get('toast').hidden,true);
  assert.equal(ui.messages.filter(message=>message.command==='updateCatalog').length,2);
});

test('preset updates keep an open model edit and allow explicitly restoring new preset values',async()=>{
  const db=structuredClone(database);
  db.models.sample={...db.defaults,name:'Sample',contextWindow:200000};
  const updated=structuredClone(db);updated.models.sample.contextWindow=300000;
  const ui=await webview([{...provider(),models:[model('sample')]}],db,{updatedCatalog:updated});
  await ui.editModel('sample');
  await ui.emit('context-window','input',{value:'250000'});
  const remote=ui.state;remote.database=updated;remote.revision++;
  await ui.pushState(remote);
  assert.equal(ui.get('model-dialog').open,true);
  assert.equal(ui.get('context-window').value,'250000');
  assert.equal(ui.get('model-update').hidden,false);
  await ui.emit('model-form','submit');
  assert.equal((await ui.saved()).models[0].overrides.contextWindow,250000);
  await ui.editModel('sample');
  await ui.emit('reset-model','click');
  assert.equal(ui.get('context-window').value,'300000');
  await ui.emit('model-form','submit');
  assert.equal(Object.hasOwn((await ui.saved()).models[0].overrides,'contextWindow'),false);
});

test('changing the unified protocol does not change split family routes or manual assignments',async()=>{
  const input={...splitProvider(),models:['gpt-automatic','claude-automatic','pinned'].map(model),modelProtocols:{pinned:'responses'}};
  const ui=await webview([input]);
  assert.equal(ui.get('unified-endpoint').hidden,true);
  assert.deepEqual(inProtocol(ui,'responses'),['gpt-automatic','pinned']);
  assert.deepEqual(inProtocol(ui,'messages'),['claude-automatic']);
  await ui.mode('unified');
  assert.equal(ui.get('unified-endpoint').hidden,false);
  await ui.emit('unified-api-type','change',{value:'messages'});
  await ui.mode('split');
  assert.equal(ui.get('unified-endpoint').hidden,true);
  assert.deepEqual(inProtocol(ui,'responses'),['gpt-automatic','pinned']);
  assert.deepEqual(inProtocol(ui,'messages'),['claude-automatic']);
  const saved=await ui.saved();
  assert.deepEqual(saved.modelProtocols,{'gpt-automatic':'responses','claude-automatic':'messages',pinned:'responses'});
  const restarted=await webview([saved]);
  assert.deepEqual(inProtocol(restarted,'responses'),['gpt-automatic','pinned']);
  assert.deepEqual(inProtocol(restarted,'messages'),['claude-automatic']);
});

test('model protocol choices apply only with the dialog and survive model ID edits',async()=>{
  const ui=await webview([{...splitProvider(),models:[model('gpt-model')]}]);
  await ui.editModel('gpt-model');
  assert.equal(ui.get('model-protocol').value,'responses');
  assert.equal(ui.get('model-protocol').disabled,false);
  assert.equal(ui.get('model-protocol-field').hidden,false);
  assert.match(ui.get('model-protocol-note').textContent,/模型默认归入 Responses/);
  await ui.emit('model-protocol','change',{value:'messages'});
  ui.get('model-dialog').close();await ui.flush();
  assert.deepEqual((await ui.saved()).modelProtocols,{'gpt-model':'responses'});
  await ui.editModel('gpt-model');
  await ui.emit('model-protocol','change',{value:'messages'});
  await ui.emit('model-form','submit');
  assert.deepEqual((await ui.saved()).modelProtocols,{'gpt-model':'messages'});
  await ui.editModel('gpt-model');
  await ui.emit('model-id','input',{value:'gpt-renamed'});
  await ui.emit('model-form','submit');
  const saved=await ui.saved();
  assert.deepEqual(saved.modelProtocols,{'gpt-renamed':'messages'});
  assert.equal(saved.models[0].id,'gpt-renamed');
  assert.deepEqual(inProtocol(ui,'messages'),['gpt-renamed']);
});

test('batch protocol moves remain editable and persist without inheritance controls',async()=>{
  const ui=await webview([{...splitProvider(),models:['gpt-one','claude-two'].map(model)}]);
  await ui.choose('gpt-one');
  assert.equal(ui.elements.has('inherit-selected-models'),false);
  assert.equal(ui.get('move-to-responses').disabled,true);
  assert.equal(ui.get('move-to-chatCompletions').disabled,false);
  await ui.move('chatCompletions');
  assert.deepEqual(inProtocol(ui,'chatCompletions'),['gpt-one']);
  assert.deepEqual(inProtocol(ui,'messages'),['claude-two']);
  await ui.choose('claude-two');
  await ui.move('responses');
  assert.deepEqual(inProtocol(ui,'responses'),['gpt-one','claude-two']);
  assert.equal(ui.get('move-to-responses').disabled,true);
  assert.deepEqual((await ui.saved()).modelProtocols,{'gpt-one':'responses','claude-two':'responses'});
});

test('export selects all providers without a key toggle and preserves focus when selecting',async()=>{
  const empty=await webview([]);
  assert.equal(empty.get('export-providers').disabled,true);
  assert.equal(empty.get('import-providers').disabled,false);

  const ui=await webview([{...provider('one'),name:'Alpha',hasKey:true},{...provider('two'),name:'Beta',hasKey:false}]);
  assert.equal(ui.get('export-providers').disabled,false);
  await ui.emit('export-providers','click');
  assert.equal(ui.get('export-dialog').open,true);
  assert.equal(ui.get('export-select-all').checked,true);
  assert.equal(ui.elements.has('export-include-keys'),false);
  assert.equal(ui.get('export-provider-list').querySelectorAll('[data-transfer-id]').length,2);

  // Uncheck one provider
  const second=ui.get('export-provider-list').querySelector('[data-transfer-id="two"]');
  second.focus();
  second.checked=false;
  await ui.emit('export-provider-list','change',{},second);
  assert.equal(ui.get('export-select-all').checked,false);
  assert.equal(ui.get('export-select-all').indeterminate,true);
  assert.equal(ui.activeElement,second);
  assert.equal(ui.get('export-provider-list').querySelector('[data-transfer-id="two"]'),second);
  await ui.emit('export-clipboard','click');
  assert.equal(ui.get('export-dialog').open,false);
  const exported=ui.messages.find(message=>message.command==='exportProviders');
  assert.deepEqual(exported.payload,{ids:['one'],target:'clipboard'});
  assertSaveToast(ui);
  assert.match(ui.get('toast').textContent,/剪贴板/);
});

test('import dialog previews clipboard or file sources, selects all by default, preserves unrelated dirty drafts and scrubs imported keys',async()=>{
  const incoming=[
    {...provider('one'),name:'Alpha',apiKey:'IMPORTED-ALPHA-SECRET'},
    {...provider('three'),name:'Gamma',models:[model('gamma-model')]}
  ];
  const ui=await webview([{...provider('one'),name:'Alpha'},{...provider('two'),name:'Beta'}],database,{importSource:incoming});
  await ui.select('two');
  await ui.emit('provider-name','input',{value:'Unsaved Beta Draft'});
  await ui.emit('import-providers','click');
  assert.equal(ui.get('import-dialog').open,true);
  assert.equal(ui.get('apply-import').disabled,true);

  await ui.emit('import-from-clipboard','click');
  assert.equal(ui.get('import-selection-section').hidden,false);
  assert.equal(ui.get('import-select-all').checked,true);
  assert.equal(ui.get('apply-import').disabled,false);
  assert.match(ui.get('import-summary').textContent,/2 \/ 2/);

  // Deselect Alpha so only Gamma is imported
  const alphaCheck=ui.get('import-provider-list').querySelector('[data-transfer-id="one"]');
  alphaCheck.checked=false;
  await ui.emit('import-provider-list','change',{},alphaCheck);
  assert.equal(ui.get('import-select-all').indeterminate,true);
  await ui.emit('apply-import','click');
  assert.equal(ui.get('import-dialog').open,false);
  assertSaveToast(ui);
  assert.equal(ui.state.providers.length,3);
  assert.equal(ui.get('provider-name').value,'Unsaved Beta Draft','Unrelated dirty draft stays intact');
});

test('transfer dialogs keep close controls without footer cancellation and file cancellation preserves selection',async()=>{
  for(const mode of ['export','import']){
    const dialog=html.match(new RegExp(`<dialog id="${mode}-dialog"[\\s\\S]*?</dialog>`))[0];
    assert.match(dialog,new RegExp(`data-close="${mode}-dialog"`));
    assert.doesNotMatch(dialog.match(/<footer[\s\S]*?<\/footer>/)[0],/取消|data-close/);
  }
  const options={exportCanceled:true};
  const ui=await webview([provider()],database,options);
  await ui.emit('export-providers','click');
  await ui.emit('export-file','click');
  assert.equal(ui.get('export-dialog').open,true);
  assert.equal(ui.get('export-select-all').checked,true);
  assert.equal(ui.get('toast').hidden,true);
  options.exportCanceled=false;
  await ui.emit('export-file','click');
  assert.equal(ui.get('export-dialog').open,false);
  assert.match(ui.get('toast').textContent,/已导出 1/);
});

test('delayed close events cannot clear a newly opened transfer dialog',async()=>{
  const ui=await webview([provider()],database,{deferClose:true});
  for(const previousMode of ['import','export']){
    await ui.emit(`${previousMode}-providers`,'click');
    ui.get(`${previousMode}-dialog`).close();
    await ui.emit('export-providers','click');
    await ui.flushCloseEvents();
    assert.equal(ui.get('export-dialog').open,true);
    const previousExports=ui.messages.filter(m=>m.command==='exportProviders').length;
    await ui.emit('export-clipboard','click');
    assert.equal(ui.messages.filter(m=>m.command==='exportProviders').length,previousExports+1);
    assert.equal(ui.get('export-dialog').open,false);
    await ui.flushCloseEvents();
  }
});

test('import failures preserve selection and mask all keys, and same-name imports acknowledge the local draft',async()=>{
  const entries=[{...provider('remote'),name:'Alpha',apiKey:'first-import-key'},{...provider('other'),name:'Beta',apiKey:'second-import-key'}];
  const options={importSource:entries,importError:'failed first-import-key second-import-key'};
  const ui=await webview([{...provider('local'),name:'Alpha'}],database,options);
  await ui.emit('provider-name','input',{value:'Unsaved Alpha'});
  await ui.emit('import-providers','click');
  await ui.emit('import-from-file','click');
  await ui.emit('apply-import','click');
  assert.equal(ui.get('import-dialog').open,true);
  assert.equal(ui.get('import-select-all').checked,true);
  assert.doesNotMatch(ui.get('import-error').textContent,/first-import-key|second-import-key/);
  assert.equal(ui.get('toast').hidden,true);
  delete options.importError;
  await ui.emit('apply-import','click');
  assert.equal(ui.get('import-dialog').open,false);
  assert.equal(ui.get('provider-name').value,'Alpha');
  assert.equal(ui.get('update-banner').hidden,true);
  assert.equal(ui.get('toast').textContent,'已导入 2 个供应商。');
  assert.deepEqual(ui.state.providers.map(p=>p.id),['local','other']);
});


test('unified mode hides model protocol controls and keeps assignments for split mode',async()=>{
  const input={...provider(),models:[model('existing')],modelProtocols:{existing:'messages'}};
  const ui=await webview([input]);
  await ui.editModel('existing');
  assert.equal(ui.get('model-protocol').value,'messages');
  assert.equal(ui.get('model-protocol').disabled,true);
  assert.equal(ui.get('model-protocol-field').hidden,true);
  await ui.emit('model-form','submit');
  assert.deepEqual((await ui.saved()).modelProtocols,input.modelProtocols);
  await ui.mode('split');
  assert.deepEqual(inProtocol(ui,'messages'),['existing']);
});

test('reasoning options use the protocol selected in the unsaved model editor',async()=>{
  const db=structuredClone(database);
  db.models.sample={...db.defaults,thinking:true,supportsReasoningEffort:['low','high'],protocols:{chatCompletions:{effortFormat:'unsupported'}}};
  const ui=await webview([{...splitProvider(),models:[model('sample')]}],db);
  await ui.editModel('sample');
  assert.equal(ui.get('reasoning-effort').disabled,true);
  await ui.emit('model-protocol','change',{value:'responses'});
  assert.deepEqual(ui.get('reasoning-effort').children.map(option=>option.value),['','low','high']);
  await ui.emit('reasoning-effort','change',{value:'high'});
  await ui.emit('model-form','submit');
  const saved=await ui.saved();
  assert.equal(saved.modelProtocols.sample,'responses');
  assert.equal(saved.models[0].reasoningEffort,'high');
});

test('production webview only loads local script and stylesheet with a restrictive CSP',()=>{
  assert.match(html,/Content-Security-Policy/i);
  assert.match(html,/default-src 'none'/);
  assert.match(html,/nonce-\{\{NONCE\}\}/);
  assert.ok(!/on(?:click|load|error|input|change)\s*=/.test(html));
  assert.ok(!/https?:\/\/[^\s"<>]+\.(?:js|css)/.test(html));
  const resources=[...html.matchAll(/\{\{resource:([^}]+)\}\}/g)].map(match=>match[1]);
  assert.deepEqual(resources,['webview/style.css','shared/messages.en.js','shared/i18n.js','shared/routing.js','shared/model-policy.js','webview/app.js']);
  for(const resource of resources)assert.ok(fs.existsSync(path.join(__dirname,'..','resources',resource)),resource);
  for(const resource of resources.slice(1))assert.ok(html.includes(`<script nonce="{{NONCE}}" src="{{resource:${resource}}}"></script>`));
  assert.doesNotMatch(script,/272000|32768|272K|32K/);
  assert.doesNotMatch(script,/\blocalStorage\b|\bsessionStorage\b|\bfetch\s*\(|\bXMLHttpRequest\b/);
});
