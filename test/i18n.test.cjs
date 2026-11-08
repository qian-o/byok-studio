const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const i18n=require('../media/i18n');
const ui=require('../media/i18n-en');
const errors=require('../media/i18n-errors');
const messages={...ui,...errors};
const template=fs.readFileSync(path.join(root,'media','index.html'),'utf8');
const placeholders=text=>[...text.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort();

test('translations cover every literal UI label and preserve all interpolation placeholders',()=>{
  for(const [key,value] of Object.entries(messages)){
    assert.equal(typeof value,'string',key);
    assert.ok(value.length,key);
    assert.deepEqual(placeholders(value),placeholders(key),key);
  }
  for(const key of Object.keys(ui))if(Object.hasOwn(errors,key))assert.equal(errors[key],ui[key],`Conflicting shared translation: ${key}`);
  const keys=[...template.matchAll(/\{\{t:([^}]+)\}\}/g)].map(m=>m[1]);
  for(const file of ['app.js','context-policy.js']){
    const code=fs.readFileSync(path.join(root,'media',file),'utf8');
    for(const match of code.matchAll(/\bt\(('(?:\\.|[^'\\])*')/g))keys.push(vm.runInNewContext(match[1]));
  }
  for(const key of keys)assert.ok(Object.hasOwn(messages,key),`Missing English translation: ${key}`);
  i18n.setLocale('en');
  const english=i18n.renderHtml(template);
  assert.doesNotMatch(english,/\{\{t:|[\p{Script=Han}]/u);
  assert.match(english,/<html lang="en">/);
  i18n.setLocale('zh-CN');
  assert.match(i18n.renderHtml(template),/<html lang="zh-CN">/);
});

test('locale follows VS Code language with English fallback and preserves user-supplied text',()=>{
  for(const [language,expected] of [['en','en'],['en-US','en'],['zh-cn','zh-CN'],['zh-TW','zh-CN'],['ZH_hans','zh-CN'],['fr','en'],['','en']]){
    i18n.setLocale(language);assert.equal(i18n.getLocale(),expected);
  }
  i18n.setLocale('en');
  assert.equal(i18n.t('选择模型 {0}','我的模型 {1} $& <b>'), 'Select model 我的模型 {1} $& <b>');
  assert.equal(i18n.t('an untranslated upstream error'),'an untranslated upstream error');
  assert.equal(i18n.renderHtml('{{t:<script>alert(1)</script>}}'),'&lt;script&gt;alert(1)&lt;/script&gt;');
  i18n.setLocale('zh-CN');
  assert.equal(i18n.t('选择模型 {0}','My Model'),'选择模型 My Model');
});

test('manifest translations resolve every command and description in both languages',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const keys=[...JSON.stringify(manifest).matchAll(/%([^%]+)%/g)].map(m=>m[1]);
  assert.ok(keys.length>=4);
  for(const locale of ['', '.zh-cn']){
    const bundle=JSON.parse(fs.readFileSync(path.join(root,`package.nls${locale}.json`),'utf8'));
    for(const key of keys)assert.ok(bundle[key],key);
  }
});
