const {test}=require('node:test');
const assert=require('node:assert/strict');
const catalog=require('../resources/catalog/models.json');
const audit=require('../docs/catalog-audit.json');
const rules=require('../resources/catalog/rules.json');
const migrations=require('../resources/catalog/migrations.json').updates;
const {recommendedProtocol}=require('../resources/shared/routing');
const {validateDatabase}=require('../dist/core/configuration');

test('the audit accounts for every bundled exact model ID with traceable evidence and limitations',()=>{
  assert.deepEqual(Object.keys(audit.models).sort(),Object.keys(catalog.models).sort());
  for(const [id,item]of Object.entries(audit.models)){
    assert.ok(['verified','partial','alias','unavailable'].includes(item.status),id);
    assert.ok(Array.isArray(item.sourceUrls)&&item.sourceUrls.length>0,id+' missing sources');
    assert.ok(item.sourceUrls.every(url=>/^https:\/\//.test(url)),id);
    assert.ok(Array.isArray(item.findings),id);
    assert.ok(catalog.models[id].contextPricing,id+' needs an explicit pricing policy, including unknown');
    assert.ok(catalog.models[id].reasoningControls?.protocols?.[recommendedProtocol(id)],id+' needs an explicit recommended protocol profile');
    if(item.status==='alias')assert.ok(item.findings.length||catalog.models[id].aliasOf,id+' alias scope must be explicit');
  }
  assert.deepEqual(validateDatabase(catalog),catalog,'All extended metadata survives store validation');
});

test('migrations contain complete inline payloads and no missing or duplicate updates',()=>{
  assert.equal(new Set(migrations.map(m=>m.id)).size,migrations.length);
  for(const m of migrations){
    assert.ok(['add','replace','revision','fields','dates','names','pricing'].includes(m.kind),m.id);
    assert.equal(Object.hasOwn(m,'payload'),!['dates','pricing'].includes(m.kind),m.id);
    if(m.kind==='add')for(const id of m.payload)assert.ok(Object.hasOwn(catalog.models,id),m.id+': '+id);
  }
  assert.ok(rules.vendors.every(v=>['responses','chatCompletions','messages'].includes(v.protocol)));
});
