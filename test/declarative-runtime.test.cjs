const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const catalog=require('../data/model-parameters.json');
const rules=require('../data/model-rules.json');
const root=path.resolve(__dirname,'..');
function codeFiles(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?codeFiles(path.join(directory,entry.name)):/\.(?:ts|js|cjs)$/.test(entry.name)&&!/^host.*Test\.ts$|^hostTest\.ts$|\.d\.ts$/.test(entry.name)?[path.join(directory,entry.name)]:[]);}

test('production source has no embedded model IDs or manufacturer identity branches',()=>{
  const ids=new Set(Object.keys(catalog.models));
  const identities=new Set(rules.vendors.filter(x=>x.pattern).map(x=>x.id));
  const findings=[];
  for(const file of [...codeFiles(path.join(root,'src')),...codeFiles(path.join(root,'media')),...codeFiles(path.join(root,'scripts'))]){
    const source=fs.readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
    for(const literal of source.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)){
      const value=literal[2];
      if(ids.has(value))findings.push(`${path.relative(root,file)}: embedded request ID ${value}`);
      if(identities.has(value.toLowerCase())&&/(?:===?|!==?|case\s+|\.startsWith\(\s*|\.includes\(\s*)$/.test(source.slice(Math.max(0,literal.index-40),literal.index).trim()))findings.push(`${path.relative(root,file)}: identity condition ${value}`);
    }
    for(const literal of source.matchAll(/\/(?![/*])(?:\\.|[^/\n])+\/[gimsuy]*/g)){
      if([...identities].some(id=>literal[0].toLowerCase().includes(id)))findings.push(`${path.relative(root,file)}: identity regex ${literal[0]}`);
    }

  }
  assert.deepEqual(findings,[],'Model identities and their behavior belong in declarative data');
});
