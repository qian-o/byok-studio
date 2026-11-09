const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { t, setLocale } = require('../resources/shared/i18n.js');

const STATE_KEY = 'byokStudio.state.v1';
const BINDINGS_KEY = 'byokStudio.officialBindings.v1';
const READ_ERROR = '无法读取 BYOK Studio 本地状态；原始数据未修改。';
const JSON_ERROR = 'BYOK Studio 本地状态不是有效的 UTF-8 JSON；原始数据未修改。';
const SAVE_ERROR = '无法保存 BYOK Studio 本地状态；已保存的数据未修改。';
const saved = name => ({ version: 1, providers: [], database: { schemaVersion: 1, models: {}, defaults: {
  name, contextWindow: 128000, maxOutputTokens: 16000, toolCalling: true,
  vision: false, thinking: false, supportsReasoningEffort: [], source: '', verifiedAt: null
} } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class MockUri {
  constructor(uriPath, scheme = 'file', authority = '') { this.path = uriPath; this.scheme = scheme; this.authority = authority; }
  static joinPath(uri, ...parts) { return new MockUri(path.posix.join(uri.path, ...parts), uri.scheme, uri.authority); }
}
class MockFileSystemError extends Error {
  constructor(code) { super('private fixture filesystem detail'); this.code = code; }
}

function fixture({ legacy, file, readError, scheme = 'file' } = {}) {
  const folder = new MockUri('/profile/User/globalStorage/byok-studio', scheme, 'profile-fixture');
  const statePath = path.posix.join(folder.path, 'studio-state.json');
  const globals = new Map([[BINDINGS_KEY, { owned: { keep: true } }], ['preference', 7]]);
  if (legacy !== undefined) globals.set(STATE_KEY, structuredClone(legacy));
  const files = new Map();
  if (file !== undefined) files.set(statePath, Buffer.isBuffer(file) ? Buffer.from(file) : Buffer.from(JSON.stringify(file)));
  const world = { globals, files, folder, statePath, readError, reads: 0, globalReads: [], events: [], mementoWrites: [] };
  const checkUri = uri => {
    assert.equal(uri.scheme, folder.scheme);
    assert.equal(uri.authority, folder.authority);
  };
  const fail = operation => { if (world.fail === operation) throw new MockFileSystemError('NoPermissions'); };
  const globalState = {
    get: key => { world.globalReads.push(key); return structuredClone(globals.get(key)); },
    update: async (key, value) => {
      const write = { key, value: structuredClone(value) };
      world.mementoWrites.push(write);
      world.events.push({ type: 'memento', ...write });
      if (world.failMemento) throw new Error('private fixture memento detail');
      if (value === undefined) globals.delete(key); else globals.set(key, structuredClone(value));
    }
  };
  const vscode = {
    Uri: MockUri, FileSystemError: MockFileSystemError,
    workspace: { fs: {
      readFile: async uri => {
        checkUri(uri);
        assert.equal(uri.path, statePath);
        world.reads++;
        if (world.readError) throw world.readError;
        if (!files.has(uri.path)) throw new MockFileSystemError('FileNotFound');
        return new Uint8Array(files.get(uri.path));
      },
      createDirectory: async uri => {
        checkUri(uri);
        assert.equal(uri.path, folder.path);
        world.events.push({ type: 'mkdir' });
        fail('mkdir');
        world.directoryReady = true;
      },
      writeFile: async (uri, bytes) => {
        checkUri(uri);
        assert.equal(path.posix.dirname(uri.path), folder.path);
        assert.notEqual(uri.path, statePath);
        assert.equal(world.directoryReady, true);
        world.events.push({ type: 'write', path: uri.path, bytes: Buffer.from(bytes) });
        if (world.fail === 'write') files.set(uri.path, Buffer.from('partial private fixture'));
        fail('write');
        files.set(uri.path, Buffer.from(bytes));
      },
      rename: async (from, to, options) => {
        checkUri(from);
        checkUri(to);
        assert.equal(path.posix.dirname(from.path), folder.path);
        assert.equal(to.path, statePath);
        assert.deepEqual(options, { overwrite: true });
        world.events.push({ type: 'rename', from: from.path, to: to.path });
        if (world.beforeRename) await world.beforeRename();
        fail('rename');
        assert.ok(files.has(from.path));
        files.set(to.path, files.get(from.path));
        files.delete(from.path);
      },
      delete: async uri => {
        checkUri(uri);
        assert.equal(path.posix.dirname(uri.path), folder.path);
        assert.notEqual(uri.path, statePath);
        world.events.push({ type: 'delete', path: uri.path });
        if (world.failTempCleanup) throw new MockFileSystemError('NoPermissions');
        if (!files.delete(uri.path)) throw new MockFileSystemError('FileNotFound');
      }
    } }
  };
  const modulePath = path.join(__dirname, '../dist/stateStorage.js');
  const localRequire = createRequire(modulePath);
  const exports = {};
  vm.compileFunction(fs.readFileSync(modulePath, 'utf8'), ['exports', 'require'], { filename: modulePath })(
    exports, name => name === 'vscode' ? vscode : localRequire(name)
  );
  world.load = () => exports.createStateStorage({ globalState, globalStorageUri: folder });
  world.onDisk = () => JSON.parse(files.get(statePath).toString('utf8'));
  return world;
}

beforeEach(() => setLocale('en'));

test('missing file falls back to legacy state without writing during initialization', async () => {
  const legacy = saved('legacy');
  const world = fixture({ legacy });
  const storage = await world.load();
  assert.deepEqual(storage.get(STATE_KEY), legacy);
  storage.get(STATE_KEY).database.defaults.name = 'caller mutation';
  assert.deepEqual(storage.get(STATE_KEY), legacy);
  assert.deepEqual(world.globals.get(STATE_KEY), legacy);
  assert.equal(world.reads, 1);
  assert.deepEqual(world.events, []);
  assert.equal(world.files.size, 0);
});

test('a fresh profile stays empty until a valid state is saved', async () => {
  const world = fixture();
  const storage = await world.load();
  assert.equal(storage.get(STATE_KEY), undefined);
  assert.deepEqual(world.events, []);
  await storage.update(STATE_KEY, saved('first'));
  assert.deepEqual(world.onDisk(), saved('first'));
  assert.deepEqual(world.mementoWrites, []);
});

test('existing UTF-8 file takes precedence and is read only once', async () => {
  const current = saved('本地配置');
  const world = fixture({ file: current, legacy: saved('obsolete'), scheme: 'vscode-userdata' });
  const storage = await world.load();
  assert.deepEqual(storage.get(STATE_KEY), current);
  storage.get(STATE_KEY).database.defaults.name = 'caller mutation';
  world.files.set(world.statePath, Buffer.from(JSON.stringify(saved('external change'))));
  assert.deepEqual(storage.get(STATE_KEY), current);
  assert.equal(world.reads, 1);
  assert.deepEqual(world.globalReads, []);
  assert.deepEqual(world.events, []);
});

test('save creates the directory, stages JSON, renames, then removes legacy state', async () => {
  const legacy = saved('legacy');
  const next = saved('new 中文');
  const world = fixture({ legacy });
  const storage = await world.load();
  world.beforeRename = () => {
    assert.deepEqual(storage.get(STATE_KEY), legacy);
    assert.deepEqual(world.globals.get(STATE_KEY), legacy);
    assert.equal(world.files.has(world.statePath), false);
  };
  await storage.update(STATE_KEY, next);
  assert.deepEqual(world.events.map(event => event.type), ['mkdir', 'write', 'rename', 'delete', 'memento']);
  const write = world.events.find(event => event.type === 'write');
  assert.match(path.posix.basename(write.path), /^studio-state\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/);
  assert.deepEqual(JSON.parse(write.bytes.toString('utf8')), next);
  assert.equal(world.events.find(event => event.type === 'rename').from, write.path);
  assert.equal(world.events.find(event => event.type === 'delete').path, write.path);
  assert.deepEqual(world.mementoWrites, [{ key: STATE_KEY, value: undefined }]);
  assert.deepEqual(world.globals.get(BINDINGS_KEY), { owned: { keep: true } });
  assert.equal(world.globals.get('preference'), 7);
  assert.deepEqual(storage.get(STATE_KEY), next);
  assert.deepEqual(world.onDisk(), next);
  assert.deepEqual([...world.files.keys()], [world.statePath]);
  assert.deepEqual((await world.load()).get(STATE_KEY), next);
});

for (const operation of ['mkdir', 'write', 'rename']) {
  test(`${operation} failure preserves the file, cache, and legacy state; a later save can succeed`, async () => {
    const previous = saved('previous');
    const legacy = saved('legacy');
    const world = fixture({ file: previous, legacy });
    const originalBytes = Buffer.from(world.files.get(world.statePath));
    const storage = await world.load();
    world.fail = operation;
    await assert.rejects(storage.update(STATE_KEY, saved('rejected')), { message: t(SAVE_ERROR) });
    assert.deepEqual(world.files.get(world.statePath), originalBytes);
    assert.deepEqual(storage.get(STATE_KEY), previous);
    assert.deepEqual(world.globals.get(STATE_KEY), legacy);
    assert.deepEqual(world.mementoWrites, []);
    assert.deepEqual([...world.files.keys()], [world.statePath]);
    world.fail = undefined;
    await storage.update(STATE_KEY, saved('recovered'));
    assert.deepEqual(world.onDisk(), saved('recovered'));
    assert.deepEqual(storage.get(STATE_KEY), saved('recovered'));
  });
}

test('failed first migration leaves legacy state available after restart', async () => {
  const legacy = saved('legacy');
  const world = fixture({ legacy });
  const storage = await world.load();
  world.fail = 'rename';
  await assert.rejects(storage.update(STATE_KEY, saved('rejected')), { message: t(SAVE_ERROR) });
  assert.equal(world.files.size, 0);
  assert.deepEqual(storage.get(STATE_KEY), legacy);
  assert.deepEqual((await world.load()).get(STATE_KEY), legacy);
  assert.deepEqual(world.mementoWrites, []);
});

for (const [label, bytes] of [
  ['malformed JSON', Buffer.from('{"private fixture":')],
  ['empty file', Buffer.alloc(0)],
  ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]
]) {
  test(`${label} fails without falling back to legacy or changing stored data`, async () => {
    const world = fixture({ file: bytes, legacy: saved('legacy') });
    await assert.rejects(world.load(), { message: t(JSON_ERROR) });
    assert.deepEqual(world.files.get(world.statePath), bytes);
    assert.deepEqual(world.globals.get(STATE_KEY), saved('legacy'));
    assert.deepEqual(world.globalReads, []);
    assert.deepEqual(world.events, []);
  });
}

for (const readError of [new MockFileSystemError('NoPermissions'), new MockFileSystemError('Unavailable'), new Error('private fixture read detail')]) {
  test(`read error ${readError.code || 'unknown'} is surfaced without exposing raw details`, async () => {
    const world = fixture({ readError, legacy: saved('legacy') });
    await assert.rejects(world.load(), { message: t(READ_ERROR) });
    assert.deepEqual(world.globalReads, []);
    assert.deepEqual(world.events, []);
  });
}

test('legacy and temporary cleanup failures cannot turn a committed save into failure', async () => {
  const world = fixture({ legacy: saved('legacy') });
  const storage = await world.load();
  world.failMemento = true;
  world.failTempCleanup = true;
  await storage.update(STATE_KEY, saved('committed'));
  assert.deepEqual(storage.get(STATE_KEY), saved('committed'));
  assert.deepEqual(world.onDisk(), saved('committed'));
  assert.deepEqual(world.globals.get(STATE_KEY), saved('legacy'));
  const restarted = await world.load();
  assert.deepEqual(restarted.get(STATE_KEY), saved('committed'));
  world.failMemento = false;
  world.failTempCleanup = false;
  await restarted.update(STATE_KEY, saved('next'));
  assert.equal(world.globals.has(STATE_KEY), false);
  assert.deepEqual((await world.load()).get(STATE_KEY), saved('next'));
});

test('failed temporary cleanup preserves the original save error and ignores staging files on restart', async () => {
  const world = fixture({ file: saved('original') });
  const storage = await world.load();
  world.fail = 'write';
  world.failTempCleanup = true;
  await assert.rejects(storage.update(STATE_KEY, saved('rejected')), { message: t(SAVE_ERROR) });
  assert.equal(world.files.size, 2);
  assert.deepEqual(world.onDisk(), saved('original'));
  assert.deepEqual((await world.load()).get(STATE_KEY), saved('original'));
});

test('pending writes stay ordered and capture input before callers can mutate it', async () => {
  const world = fixture({ file: saved('original') });
  const storage = await world.load();
  const entered = deferred();
  const release = deferred();
  let renames = 0;
  world.beforeRename = async () => {
    if (++renames === 1) { entered.resolve(); await release.promise; }
  };
  const firstValue = saved('first');
  const first = storage.update(STATE_KEY, firstValue);
  firstValue.database.defaults.name = 'mutated first';
  await entered.promise;
  const secondValue = saved('second');
  const second = storage.update(STATE_KEY, secondValue);
  secondValue.database.defaults.name = 'mutated second';
  try {
    await new Promise(setImmediate);
    assert.equal(renames, 1);
    assert.equal(world.events.filter(event => event.type === 'write').length, 1);
    assert.deepEqual(storage.get(STATE_KEY), saved('original'));
    assert.deepEqual(world.onDisk(), saved('original'));
  } finally { release.resolve(); }
  await Promise.all([first, second]);
  const writes = world.events.filter(event => event.type === 'write');
  assert.deepEqual(writes.map(event => JSON.parse(event.bytes.toString('utf8'))), [saved('first'), saved('second')]);
  assert.notEqual(writes[0].path, writes[1].path);
  assert.deepEqual(storage.get(STATE_KEY), saved('second'));
  assert.deepEqual((await world.load()).get(STATE_KEY), saved('second'));
});

test('undefined and nonserializable updates reject without deleting or changing state', async () => {
  const world = fixture({ file: saved('original'), legacy: saved('legacy') });
  const storage = await world.load();
  const circular = {};
  circular.self = circular;
  for (const value of [undefined, circular, { version: 1n }]) {
    await assert.rejects(storage.update(STATE_KEY, value), { message: t(SAVE_ERROR) });
  }
  assert.deepEqual(storage.get(STATE_KEY), saved('original'));
  assert.deepEqual(world.onDisk(), saved('original'));
  assert.deepEqual(world.globals.get(STATE_KEY), saved('legacy'));
  assert.deepEqual(world.events, []);
  await storage.update(STATE_KEY, saved('valid'));
  assert.deepEqual(world.onDisk(), saved('valid'));
});

test('other keys delegate to globalState and never write the state file', async () => {
  const world = fixture({ file: saved('original') });
  const storage = await world.load();
  assert.deepEqual(storage.get(BINDINGS_KEY), { owned: { keep: true } });
  assert.equal(storage.get('missing'), undefined);
  await storage.update('preference', 9);
  assert.equal(storage.get('preference'), 9);
  await storage.update('preference', undefined);
  assert.equal(storage.get('preference'), undefined);
  world.failMemento = true;
  await assert.rejects(storage.update('preference', 10), /private fixture memento detail/);
  assert.deepEqual(world.events.map(event => event.type), ['memento', 'memento', 'memento']);
  assert.deepEqual(world.mementoWrites.map(write => write.key), ['preference', 'preference', 'preference']);
  assert.deepEqual(world.onDisk(), saved('original'));
  assert.deepEqual(world.globals.get(BINDINGS_KEY), { owned: { keep: true } });
});

test('file errors use the active shared locale', async () => {
  setLocale('zh-CN');
  const world = fixture({ file: Buffer.from('malformed private fixture') });
  await assert.rejects(world.load(), { message: JSON_ERROR });
});
