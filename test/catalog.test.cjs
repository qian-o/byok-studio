const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {validateDatabase}=require('../dist/core/configuration');
const {compileOfficialGroup}=require('../dist/core/officialConfig');
const snapshot=require('../resources/catalog/models.json');
const catalog=snapshot.database;

test('the bundled offline catalog is a valid models.dev snapshot with traceable provenance',()=>{
  assert.equal(snapshot.source,'models.dev');
  assert.equal(new Date(snapshot.updatedAt).toISOString(),snapshot.updatedAt);
  assert.ok(Object.keys(catalog.models).length>100);
  assert.deepEqual(validateDatabase(catalog),catalog);
  for(const [id,model] of Object.entries(catalog.models)){
    assert.ok(model.name,id);
    assert.match(model.source,/models\.dev/,id);
    assert.equal(model.verifiedAt,null,'Community metadata must not be labeled as independently verified');
    assert.ok(model.contextPricing,id);
    assert.equal(model.contextPricing.checkedAt,null,id);
    assert.ok(model.defaultOutputTokens>0&&model.defaultOutputTokens<=model.maxOutputTokens,id);
  }
});

test('all bundled catalog entries produce valid native allocations for all protocols',()=>{
  const models=Object.keys(catalog.models).map(id=>({id,name:'',discoveredName:'',overrides:{}}));
  for(const apiType of ['responses','chatCompletions','messages']){
    const group=compileOfficialGroup({id:'fixture',name:'Fixture',apiType,url:'https://example.test/v1',enabled:true,zeroDataRetentionEnabled:false,models},catalog);
    assert.deepEqual(group.models.map(m=>m.id),models.map(m=>m.id));
    for(const model of group.models){
      assert.ok(model.maxInputTokens>0&&model.maxOutputTokens>0,model.id);
      assert.ok(model.maxOutputTokens<=catalog.models[model.id].maxOutputTokens,model.id);
      if(catalog.models[model.id].contextWindowMode!=='input')assert.ok(model.maxInputTokens+model.maxOutputTokens<=catalog.models[model.id].contextWindow,model.id);
    }
  }
});

test('catalog maintenance has one source converter and preserves upstream license attribution',()=>{
  const script=fs.readFileSync(path.join(__dirname,'../scripts/catalog/update.cjs'),'utf8');
  assert.match(script,/modelCatalog/);
  for(const obsolete of ['generation.json','overrides.json','pricing.json','release-dates.json'])assert.equal(fs.existsSync(path.join(__dirname,'../scripts/catalog',obsolete)),false);
  const notice=fs.readFileSync(path.join(__dirname,'../THIRD_PARTY_NOTICES.txt'),'utf8');
  assert.match(notice,/Copyright \(c\) 2025 models.dev/);
  assert.match(notice,/MIT License/);
});
