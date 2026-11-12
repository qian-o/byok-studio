const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {listFiles,PackageManager}=require('@vscode/vsce');
const root=path.resolve(__dirname,'..');

test('the VSIX includes runtime resources and excludes catalog maintenance and evidence',async()=>{
  const files=new Set((await listFiles({cwd:root,packageManager:PackageManager.None})).map(file=>file.replaceAll('\\','/')));
  for(const file of ['dist/extension.js','dist/panel.js','dist/officialManager.js','resources/icon.png','resources/catalog/models.json','resources/catalog/rules.json','resources/shared/model-policy.js','resources/shared/routing.js','resources/shared/i18n.js','resources/shared/messages.en.js'])assert.ok(files.has(file),file);
  assert.equal(files.has('resources/catalog/migrations.json'),false);
  for(const file of ['dist/stateStorage.js','THIRD_PARTY_NOTICES.txt'])assert.ok(files.has(file),file);
  for(const file of ['dist/core/modelCatalog.js','resources/catalog/compatibility.json'])assert.equal(files.has(file),false,file);
  const html=fs.readFileSync(path.join(root,'resources/webview/index.html'),'utf8');
  for(const match of html.matchAll(/\{\{resource:([^}]+)\}\}/g))assert.ok(files.has('resources/'+match[1]),match[1]);
  for(const file of files){
    assert.doesNotMatch(file,/^(?:src|test|scripts|data|media|releases)\//,file);
    assert.doesNotMatch(file,/^(?:docs\/.*\.(?:json|md)|dist\/hostTest\.|.*\.d\.ts$)/,file);
  }
  assert.ok(files.has('docs/images/configuration-en.png'));
  assert.ok(files.has('docs/images/configuration-zh-CN.png'));
});
