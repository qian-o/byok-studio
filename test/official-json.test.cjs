const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScanner, SyntaxKind } = require('jsonc-parser');
const {
  parseNativeGroups, listGroups, hasGroupConflict, updateOwnedGroup, patchOwnedGroups, removeLegacyGroups
} = require('../dist/core/officialJson');

const owned = (id, extra = {}) => ({ name: `Managed ${id}`, vendor: 'customendpoint', byokStudioId: id, ...extra });
const json = value => JSON.stringify(value);
const plain = value => JSON.parse(JSON.stringify(value));
const rawNodes = text => {
  const { root } = parseNativeGroups(text);
  return root.children.map(node => text.slice(node.offset, node.offset + node.length));
};
const comments = text => {
  const result = [];
  const scanner = createScanner(text);
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) {
      result.push(text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
    }
  }
  return result;
};

const unrelatedOne = '{ "vendor" : "copilot", "name":"用户配置", "profiles":[{"settings":{"x":true,},}], /* inside first */ "future":{"key":"// [, ]"} }';
const unrelatedTwo = '{\n    "vendor": "customendpoint",\n    "name": "手动分组",\n    "apiKey": "dummy-ref-only",\n    "models": [{"id":"manual", "settings":{"context":2048}, /* keep model comment */}],\n    "settings": {"unknown": [1, 2, 3]},\n  }';

test('parses JSONC arrays with AST offsets, opaque settings, BOM, comments and trailing commas', () => {
  const text = `\uFEFF// header\r\n[\r\n${unrelatedOne},\r\n${unrelatedTwo},\r\n] // footer`;
  const parsed = parseNativeGroups(text);
  assert.equal(parsed.root.type, 'array');
  assert.equal(text[parsed.root.offset], '[');
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.groups[0].profiles[0].settings.x, true);
  assert.equal(parsed.groups[1].apiKey, 'dummy-ref-only');
  assert.deepEqual(rawNodes(text), [unrelatedOne, unrelatedTwo]);
  assert.equal(updateOwnedGroup(text, 'missing', null), text);
  assert.equal(removeLegacyGroups(text, []), text);
  assert.equal(patchOwnedGroups(text, []), text);
});

test('updates only the owned object span and retains exact unrelated objects and surrounding bytes', () => {
  const before = owned('one', { models: [{ id: 'a' }], apiKey: 'dummy-ref-old' });
  const text = `// begin\n[\n  ${unrelatedOne}, // adjacent , comma\n  /* owned lead */ ${json(before)} /* owned tail */,\n  // next lead\n  ${unrelatedTwo},\n] // end`;
  const { root } = parseNativeGroups(text);
  const target = root.children[1];
  const output = updateOwnedGroup(text, 'one', owned('one', { name: '已更新', apiKey: 'dummy-ref-new' }));
  const updated = parseNativeGroups(output).root.children[1];
  assert.equal(output.slice(0, updated.offset), text.slice(0, target.offset));
  assert.equal(output.slice(updated.offset + updated.length), text.slice(target.offset + target.length));
  assert.deepEqual([rawNodes(output)[0], rawNodes(output)[2]], [unrelatedOne, unrelatedTwo]);
  assert.deepEqual(comments(output), comments(text));
  assert.equal(listGroups(output)[1].apiKey, 'dummy-ref-new');
});

test('merges unknown group and model fields recursively, reorders by ID, and removes missing owned models', () => {
  const previous = owned('merge', {
    apiKey: 'dummy-ref', custom: { keep: true }, settings: { local: 7, nested: { keep: true, change: 1 } },
    models: [
      { id: 'a', name: 'old', context: 1024, custom: { preserved: true }, settings: { reasoning: 'low', userValue: 9 } },
      { id: 'b', future: 'keep-b' }, { id: 'removed', settings: { userValue: 5 } }
    ], obsolete: 'delete explicitly'
  });
  const incoming = owned('merge', {
    settings: { nested: { change: 2 } },
    models: [{ id: 'b', name: 'new-b' }, { id: 'a', name: 'new-a', settings: { reasoning: 'high' } }, { id: 'new' }]
  });
  const untouched = json(incoming);
  const output = updateOwnedGroup(`[${json(previous)}]`, 'merge', incoming, { removeFields: ['obsolete'] });
  const result = plain(listGroups(output)[0]);
  assert.deepEqual(result.settings, { local: 7, nested: { keep: true, change: 2 } });
  assert.deepEqual(result.custom, { keep: true });
  assert.equal(result.apiKey, 'dummy-ref');
  assert.equal(Object.hasOwn(result, 'obsolete'), false);
  assert.deepEqual(result.models, [
    { id: 'b', future: 'keep-b', name: 'new-b' },
    { id: 'a', name: 'new-a', context: 1024, custom: { preserved: true }, settings: { reasoning: 'high', userValue: 9 } },
    { id: 'new' }
  ]);
  assert.equal(json(incoming), untouched);
  assert.equal(updateOwnedGroup(output, 'merge', incoming, { removeFields: ['obsolete'] }), output);
  assert.deepEqual(plain(listGroups(updateOwnedGroup(output, 'merge', owned('merge', { models: [] })))[0].models), []);
});

test('semantic no-op preserves owned comments, formatting, key order and trailing commas exactly', () => {
  const text = '[\n\t{"models":[{"id":"a",/* model */"settings":{"user":1},},], /* own */ "byokStudioId":"one","vendor":"customendpoint","name":"Managed one",},\n]';
  assert.equal(updateOwnedGroup(text, 'one', owned('one', { models: [{ id: 'a' }] })), text);
});

test('appends before closing bracket without changing unrelated object bytes or comments', () => {
  for (const trailing of ['', ',']) {
    for (const tail of [' ', ' /* comma , and ] are comment text */ ', ' // trailing , comment\n']) {
      const text = `/* top */ [${unrelatedOne},${unrelatedTwo}${trailing}${tail}] /* footer */`;
      const output = updateOwnedGroup(text, 'add', owned('add', { apiKey: 'dummy-ref' }));
      assert.deepEqual(rawNodes(output).slice(0, 2), [unrelatedOne, unrelatedTwo]);
      assert.deepEqual(comments(output), comments(text));
      assert.equal(listGroups(output).at(-1).byokStudioId, 'add');
      assert.ok(output.endsWith('] /* footer */'));
      const last = parseNativeGroups(output).root.children.at(-1);
      assert.equal(output.slice(last.offset + last.length).trimStart().startsWith(','), !!trailing);
      assert.equal(updateOwnedGroup(output, 'add', owned('add', { apiKey: 'dummy-ref' })), output);
    }
  }
});

test('appends to compact and commented empty arrays and preserves bracket-adjacent comments', () => {
  for (const text of ['[]', '[ ]', '[\n]', '[/* keep */]', '// heading\n[\n  // empty explanation\n]\n']) {
    const output = updateOwnedGroup(text, 'new', owned('new'));
    assert.equal(listGroups(output).length, 1);
    assert.deepEqual(comments(output), comments(text));
    assert.equal(updateOwnedGroup(output, 'new', owned('new')), output);
  }
});

test('appends and updates using existing tabs or spaces and Chinese CRLF without introducing LF', () => {
  for (const unit of ['\t', '    ']) {
    const text = `\uFEFF// 中文\r\n[\r\n${unit}{\r\n${unit}${unit}"vendor":"other",\r\n${unit}${unit}"name":"用户"\r\n${unit}},\r\n]\r\n`;
    const added = updateOwnedGroup(text, '中文', owned('中文', { name: '管理模型' }));
    const output = updateOwnedGroup(added, '中文', owned('中文', { name: '新名称' }));
    assert.ok(output.includes(`\r\n${unit}{\r\n${unit}${unit}"name": "新名称"`));
    assert.ok(output.includes('管理模型') === false);
    assert.equal(output.replaceAll('\r\n', '').includes('\n'), false);
    assert.equal(rawNodes(output)[0], rawNodes(text)[0]);
    assert.ok(output.startsWith('\uFEFF// 中文\r\n'));
  }
});

test('deletes first, middle and last elements with and without trailing comma, preserving all other bytes', () => {
  const target = json(owned('delete'));
  for (const index of [0, 1, 2]) {
    for (const trailing of ['', ',']) {
      const values = [unrelatedOne, unrelatedTwo];
      values.splice(index, 0, target);
      const gaps = [' /* trailing , comment */ , // next\n  ', ' /* another , */ ,\n  '];
      const text = `[\n  /* lead */ ${values[0]}${gaps[0]}${values[1]}${gaps[1]}${values[2]}${trailing} /* footer , */\n]`;
      const output = updateOwnedGroup(text, 'delete', null);
      assert.deepEqual(rawNodes(output), [unrelatedOne, unrelatedTwo]);
      assert.deepEqual(comments(output), comments(text));
      const targetOffset = text.indexOf(target);
      let expected = text.slice(0, targetOffset) + text.slice(targetOffset + target.length);
      if (index < 2) {
        const commaOffset = targetOffset + gaps[index].lastIndexOf(' ,') + 1;
        expected = expected.slice(0, commaOffset) + expected.slice(commaOffset + 1);
      } else if (trailing) {
        expected = expected.slice(0, targetOffset) + expected.slice(targetOffset + 1);
      } else {
        const commaOffset = text.lastIndexOf(' ,\n  ', targetOffset) + 1;
        expected = expected.slice(0, commaOffset) + expected.slice(commaOffset + 1);
      }
      assert.equal(output, expected);
      assert.equal(updateOwnedGroup(output, 'delete', null), output);
    }
  }
});

test('deletes the sole group and all managed groups while retaining array comments', () => {
  for (const trailing of ['', ',']) {
    const single = `[/* before , */${json(owned('a'))} /* after , */${trailing}// closing\n]`;
    const removed = updateOwnedGroup(single, 'a', null);
    assert.deepEqual(listGroups(removed), []);
    assert.deepEqual(comments(removed), comments(single));
    const all = `[// before\n${json(owned('a'))},/* between , */${json(owned('b'))}${trailing}\n// after\n]`;
    const output = patchOwnedGroups(all, [{ providerId: 'a', group: null }, { providerId: 'b', group: null }]);
    assert.deepEqual(listGroups(output), []);
    assert.deepEqual(comments(output), comments(all));
  }
});

test('matches by marker only and rejects collisions with other customendpoint names', () => {
  const manual = { name: 'Managed one', vendor: 'customendpoint', models: [] };
  const text = json([manual]);
  assert.equal(hasGroupConflict(text, 'Managed one', 'one'), true);
  assert.throws(() => updateOwnedGroup(text, 'one', owned('one')), /already uses this name/);
  assert.equal(updateOwnedGroup(text, 'one', null), text);
  const managed = json([owned('one'), { name: 'Reserved', vendor: 'customendpoint' }]);
  assert.equal(hasGroupConflict(managed, 'Managed one', 'one'), false);
  assert.throws(() => updateOwnedGroup(managed, 'one', owned('one', { name: 'Reserved' })), /already uses this name/);
  assert.equal(listGroups(updateOwnedGroup(json([{ name: 'Managed one', vendor: 'other' }]), 'one', owned('one'))).length, 2);
  const preMarker = json([{ vendor: 'customendpoint', name: 'Other', providerId: 'one' }]);
  assert.equal(updateOwnedGroup(preMarker, 'one', null), preMarker);
});

test('rejects duplicate markers, mismatched vendors, invalid ownership and essential duplicate keys', () => {
  const inputs = [
    json([owned('same'), owned('same', { name: 'Different' })]),
    json([owned('wrong', { vendor: 'other' })]),
    json([owned('wrong', { byokStudioId: 42 })]),
    json([owned('wrong', { name: '' })]),
    '[{"vendor":"other","vendor":"customendpoint"}]',
    '[{"name":"one","na\\u006de":"two"}]',
    '[{"byokStudioId":"one","byokStudioId":"two","vendor":"customendpoint","name":"x"}]',
    '[{"providerId":"one","providerId":"two"}]',
    '[{"byokStudioGroupName":"one","byokStudioGroupName":"two"}]',
    '[{"models":[],"models":[]}]',
    '[{"models":[{"id":"a","id":"b"}]}]',
    json([owned('bad-model', { models: [{ id: 'a' }, { id: 'a' }] })])
  ];
  for (const text of inputs) {
    assert.throws(() => parseNativeGroups(text));
    assert.throws(() => updateOwnedGroup(text, 'new', owned('new')));
    assert.throws(() => removeLegacyGroups(text, []));
  }
  assert.throws(() => updateOwnedGroup('[]', 'one', owned('different')));
  assert.throws(() => updateOwnedGroup('[]', 'one', owned('one', { vendor: 'byok-studio' })));
  assert.throws(() => updateOwnedGroup('[]', '', owned('')));
  assert.throws(() => updateOwnedGroup('[]', 'one', owned('one'), { removeFields: ['byokStudioId'] }));
});

test('does not reserialize unrelated duplicate custom keys; rejects ambiguous fields when updating owned objects', () => {
  const manual = '{"vendor":"other","settings":{"custom":1,"custom":2}}';
  const output = updateOwnedGroup(`[${manual}]`, 'add', owned('add'));
  assert.equal(rawNodes(output)[0], manual);
  const ambiguous = '[{"vendor":"customendpoint","name":"Managed one","byokStudioId":"one","custom":{"x":1,"x":2}}]';
  assert.throws(() => updateOwnedGroup(ambiguous, 'one', owned('one')), /Duplicate keys/);
});

test('removes legacy references only for explicitly known IDs and complete legacy identity shape', () => {
  const old = id => ({ vendor: 'byok-studio', providerId: id, byokStudioGroupName: `Old ${id}` });
  const keep = [
    unrelatedOne,
    json(old('unknown')),
    json({ vendor: 'other', providerId: 'known', byokStudioGroupName: 'Not legacy' }),
    json({ vendor: 'byok-studio', providerId: 'known' }),
    json({ vendor: 'byok-studio', providerId: 'known', byokStudioGroupName: 5 }),
    json(owned('known'))
  ];
  const parts = [json(old('known')), ...keep.slice(0, 3), json(old('known')), ...keep.slice(3), json(old('second'))];
  const text = `[// start\n${parts.join(',/* keep gap , */\n')},// finish\n]`;
  assert.equal(removeLegacyGroups(text, []), text);
  const output = removeLegacyGroups(text, ['known', 'second']);
  assert.deepEqual(rawNodes(output), keep);
  assert.deepEqual(comments(output), comments(text));
  assert.equal(removeLegacyGroups(output, ['known', 'second']), output);
  const allLegacy = `[${json(old('known'))}, /* retain */ ${json(old('second'))},]`;
  assert.deepEqual(listGroups(removeLegacyGroups(allLegacy, ['known', 'second'])), []);
  assert.deepEqual(comments(removeLegacyGroups(allLegacy, ['known', 'second'])), ['/* retain */']);
});

test('invalid input is rejected by every API, even no-op requests, without attempting repair', () => {
  for (const text of [
    '', '  // only a comment', '{}', 'null', '[null]', '[42]', '[[]]', '[{"vendor":"x"}',
    '[{},,{}]', '[{} {}]', '[{"a":}]', '[{"a":NaN}]', '[{}] extra', '[/* unterminated]', '[{"a":"bad\\q"}]',
    '[{"a":1e}]', '[{"a":01}]', '[{"a":"line\nbreak"}]'
  ]) {
    const original = text;
    for (const operation of [
      () => parseNativeGroups(text), () => listGroups(text), () => hasGroupConflict(text, 'name', 'id'),
      () => updateOwnedGroup(text, 'absent', null), () => updateOwnedGroup(text, 'new', owned('new')),
      () => patchOwnedGroups(text, []), () => removeLegacyGroups(text, [])
    ]) { assert.throws(operation); }
    assert.equal(text, original);
  }
});

test('validates incoming JSON values and preserves opaque keys without prototype mutation', () => {
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(0)]) {
    assert.throws(() => updateOwnedGroup('[]', 'one', owned('one', { settings: { value } })));
  }
  const circular = owned('one');
  circular.self = circular;
  assert.throws(() => updateOwnedGroup('[]', 'one', circular), /cycles/);
  const before = '[{"name":"Managed one","vendor":"customendpoint","byokStudioId":"one","__proto__":{"retained":true},"constructor":{"value":1}}]';
  const incoming = JSON.parse('{"name":"Renamed","vendor":"customendpoint","byokStudioId":"one","__proto__":{"added":true}}');
  const result = listGroups(updateOwnedGroup(before, 'one', incoming))[0];
  assert.deepEqual(plain(result.__proto__), { retained: true, added: true });
  assert.equal(result.constructor.value, 1);
  assert.equal({}.retained, undefined);
});

test('batch updates compose without exposing partial output, and are idempotent', () => {
  const text = `[${unrelatedOne},${json(owned('remove'))},${unrelatedTwo},]`;
  const changes = [
    { providerId: 'remove', group: null },
    { providerId: 'a', group: owned('a', { models: [{ id: 'one' }] }) },
    { providerId: 'b', group: owned('b') }
  ];
  const output = patchOwnedGroups(text, changes);
  assert.deepEqual(rawNodes(output).slice(0, 2), [unrelatedOne, unrelatedTwo]);
  assert.deepEqual(listGroups(output).slice(2).map(group => group.byokStudioId), ['a', 'b']);
  assert.equal(patchOwnedGroups(output, changes), output);
  assert.throws(() => patchOwnedGroups(text, [...changes, { providerId: 'conflict', group: owned('conflict', { name: '手动分组' }) }]));
  assert.equal(listGroups(text)[1].byokStudioId, 'remove');
});


test('clears stale managed fields while retaining unrelated model properties and settings',()=>{
  const prior=owned('one',{apiKey:'old-ref',models:[{id:'m',name:'Old',adaptiveThinking:true,minThinkingBudget:1024,requestHeaders:{'x-custom':'keep'},future:'preserved'}],settings:{m:{reasoningEffort:'high',future:7}},futureGroup:[1,2]});
  const text=`[${unrelatedOne},${json(prior)},${unrelatedTwo}]`;
  const next=owned('one',{models:[{id:'m',name:'New'}],settings:{m:{future:7}}});
  const result=updateOwnedGroup(text,'one',next,{managedModelFields:['name','adaptiveThinking','minThinkingBudget'],replaceFields:['settings'],removeFields:['apiKey']});
  const group=listGroups(result)[1];assert.equal(group.apiKey,undefined);assert.equal(group.models[0].adaptiveThinking,undefined);assert.equal(group.models[0].minThinkingBudget,undefined);
  assert.equal(group.models[0].future,'preserved');assert.deepEqual(plain(group.models[0].requestHeaders),{'x-custom':'keep'});assert.deepEqual(plain(group.settings),{m:{future:7}});assert.deepEqual(group.futureGroup,[1,2]);
  assert.deepEqual([rawNodes(result)[0],rawNodes(result)[2]],[unrelatedOne,unrelatedTwo]);assert.deepEqual(comments(result),comments(text));
});
