'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');

function fixture(language = 'en', showStatusBarItem = undefined) {
  const commands = new Map();
  const panels = [];
  const errors = [];
  const statusBarItems = [];
  const configurationListeners = new Set();
  let failRead = false;
  let pendingRead;
  let resumeRead;
  const uri = value => ({ value, toString: () => value });
  const vscode = {
    env: { language },
    Uri: { joinPath: (base, ...segments) => uri([base.value, ...segments].join('/')) },
    ViewColumn: { Active: -1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: {
      registerCommand(id, handler) {
        assert.equal(commands.has(id), false);
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      async executeCommand(id, ...args) { return commands.get(id)?.(...args); }
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'byokStudio');
        return { get(key, defaultValue) {
          assert.equal(key, 'showStatusBarItem');
          assert.equal(defaultValue, false);
          return showStatusBarItem ?? defaultValue;
        } };
      },
      onDidChangeConfiguration(listener) {
        configurationListeners.add(listener);
        return { dispose: () => configurationListeners.delete(listener) };
      },
      fs: { async readFile() {
        if (pendingRead) await pendingRead;
        if (failRead) { failRead = false; throw new Error('Template unavailable'); }
        return fs.readFileSync(path.join(root, 'resources', 'webview', 'index.html'));
      } }
    },
    window: {
      createStatusBarItem(id, alignment, priority) {
        const item = {
          id, alignment, priority, visible: false, disposed: false, updates: 0,
          show() { this.visible = true; this.updates++; },
          hide() { this.visible = false; this.updates++; },
          dispose() { this.disposed = true; this.visible = false; }
        };
        statusBarItems.push(item);
        return item;
      },
      showErrorMessage(message) { errors.push(message); return Promise.resolve(undefined); },
      createWebviewPanel(type, title, options, webviewOptions) {
        let onDispose;
        const panel = {
          type, title, options, webviewOptions, viewColumn: 2, disposed: false, reveals: [],
          webview: {
            html: '', cspSource: 'vscode-webview:',
            asWebviewUri: target => target,
            onDidReceiveMessage: () => ({ dispose() {} })
          },
          onDidDispose(callback) { onDispose = callback; return { dispose() {} }; },
          reveal(column, preserveFocus) { this.reveals.push({ column, preserveFocus }); },
          dispose() { if (!this.disposed) { this.disposed = true; onDispose?.(); } }
        };
        panels.push(panel);
        return panel;
      }
    }
  };
  const loaded = new Map();
  function load(name) {
    if (loaded.has(name)) return loaded.get(name);
    const file = path.join(root, 'dist', `${name}.js`);
    const realRequire = createRequire(file);
    const module = { exports: {} };
    const mockedRequire = id => {
      if (id === 'vscode') return vscode;
      if (id === './panel') return load('panel');
      if (id === './configService') return { ConfigService: class {} };
      if (id === './vscodeHost') return { createVsCodeAdapter: () => ({ host: {}, openOfficialFile: async () => {} }) };
      return realRequire(id);
    };
    const run = vm.runInThisContext(`(function(require, module, exports) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
    run(mockedRequire, module, module.exports);
    loaded.set(name, module.exports);
    return module.exports;
  }
  const context = { extensionUri: uri('file:///extension'), subscriptions: [] };
  const api = load('extension').activate(context);
  return {
    commands, panels, errors, api, statusBarItems, configurationListeners,
    async clickStatusBar() {
      const [item] = statusBarItems;
      assert.equal(item.visible, true);
      assert.equal(item.disposed, false);
      assert.equal(typeof commands.get(item.command), 'function');
      await commands.get(item.command)();
    },
    changeConfiguration(key, value) {
      if (key === 'byokStudio.showStatusBarItem') showStatusBarItem = value;
      for (const listener of configurationListeners) {
        listener({ affectsConfiguration: section => section === key });
      }
    },
    failNextRead() { failRead = true; },
    pauseReads() { pendingRead = new Promise(resolve => { resumeRead = resolve; }); },
    resumeReads() { pendingRead = undefined; resumeRead?.(); },
    dispose() { for (const subscription of context.subscriptions) subscription.dispose(); }
  };
}

test('the status bar entry defaults to hidden after startup and shows when enabled', async () => {
  assert.ok(manifest.activationEvents.includes('onStartupFinished'));
  assert.equal(manifest.contributes.menus?.['chat/input/status'], undefined);
  assert.equal(manifest.contributes.menus?.['view/title'], undefined);
  const setting = manifest.contributes.configuration.properties['byokStudio.showStatusBarItem'];
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, false);
  assert.equal(setting.scope, 'window');
  for (const file of ['package.nls.json', 'package.nls.zh.json', 'package.nls.zh-cn.json']) {
    const strings = require(path.join(root, file));
    assert.ok(strings[setting.description.slice(1, -1)]);
  }
  const f = fixture();
  try {
    assert.equal(f.statusBarItems.length, 1);
    const [item] = f.statusBarItems;
    assert.equal(item.text, '$(key)');
    assert.equal(item.visible, false);
    assert.equal(item.alignment, 2);
    assert.equal(item.priority, 100.15);
    assert.equal(item.name, 'BYOK Studio');
    assert.equal(item.tooltip, 'Configure BYOK');
    assert.equal(f.panels.length, 0);
    f.changeConfiguration('byokStudio.showStatusBarItem', true);
    assert.equal(item.visible, true);
    await f.clickStatusBar();
    assert.equal(f.panels.length, 1);
    assert.match(f.panels[0].webview.html, /Model settings/);
    assert.equal(f.errors.length, 0);
  } finally { f.dispose(); }
});

test('status bar and palette commands focus and reuse the same management panel', async () => {
  const f = fixture('en', true);
  try {
    await f.clickStatusBar();
    assert.equal(f.panels[0].options.preserveFocus, false);
    assert.equal(f.panels[0].options.viewColumn, -1);
    await f.commands.get('byokStudio.manage')();
    await f.api.openSettings();
    assert.equal(f.panels.length, 1);
    assert.deepEqual(f.panels[0].reveals, [{ column: 2, preserveFocus: false }, { column: 2, preserveFocus: false }]);
    f.panels[0].dispose();
    await f.clickStatusBar();
    assert.equal(f.panels.length, 2);
  } finally { f.dispose(); }
});

test('visibility changes take effect immediately and hiding the entry leaves the palette command available', async () => {
  const f = fixture('en', true);
  try {
    const [item] = f.statusBarItems;
    assert.equal(item.visible, true);
    await f.clickStatusBar();
    f.changeConfiguration('byokStudio.showStatusBarItem', false);
    assert.equal(item.visible, false);
    assert.equal(f.panels[0].disposed, false);
    await f.commands.get('byokStudio.manage')();
    assert.equal(f.panels.length, 1);
    f.changeConfiguration('byokStudio.showStatusBarItem', true);
    assert.equal(item.visible, true);
    const updates = item.updates;
    f.changeConfiguration('editor.fontSize', 14);
    assert.equal(item.updates, updates);
  } finally { f.dispose(); }
  assert.equal(f.statusBarItems[0].disposed, true);
  assert.equal(f.configurationListeners.size, 0);
});

test('rapid clicks create one panel while its template is loading', async () => {
  const f = fixture('en', true);
  try {
    f.pauseReads();
    const first = f.clickStatusBar();
    const second = f.clickStatusBar();
    assert.equal(f.panels.length, 1);
    f.resumeReads();
    await Promise.all([first, second]);
    assert.match(f.panels[0].webview.html, /Model settings/);
  } finally { f.dispose(); }
});

test('template failures are reported and a later click retries successfully', async () => {
  const f = fixture('zh-CN', true);
  try {
    f.failNextRead();
    assert.equal(f.statusBarItems[0].tooltip, '配置 BYOK');
    assert.deepEqual(f.statusBarItems[0].accessibilityInformation, { label: '配置 BYOK', role: 'button' });
    await f.clickStatusBar();
    assert.equal(f.panels[0].disposed, true);
    assert.deepEqual(f.errors, ['BYOK Studio：Template unavailable']);
    await f.clickStatusBar();
    assert.equal(f.panels.length, 2);
    assert.match(f.panels[1].title, /模型设置/);
    assert.match(f.panels[1].webview.html, /lang="zh-CN"/);
  } finally { f.dispose(); }
});

test('closing during template loading does not update a disposed webview', async () => {
  const f = fixture('en', true);
  try {
    f.pauseReads();
    const opening = f.clickStatusBar();
    f.panels[0].dispose();
    f.resumeReads();
    await opening;
    assert.equal(f.panels[0].webview.html, '');
    assert.equal(f.errors.length, 0);
    await f.clickStatusBar();
    assert.equal(f.panels.length, 2);
    assert.match(f.panels[1].webview.html, /Model settings/);
  } finally { f.dispose(); }
});

test('all runtime and manifest localization keys are complete with zero unused entries', () => {
  const messages = require('../resources/shared/messages.en.js');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  );
  const sources = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'resources')), ...walk(path.join(root, 'scripts'))]
    .filter(file => /\.(ts|js|cjs|html)$/.test(file) && !file.endsWith('messages.en.js') && !file.endsWith('.test.cjs'));
  const used = new Set();
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) used.add(match[2]);
    for (const match of text.matchAll(/\{\{t:([^}]+)\}\}/g)) used.add(match[1]);
  }
  assert.deepEqual([...used].filter(key => !Object.hasOwn(messages, key)), []);
  assert.deepEqual(Object.keys(messages).filter(key => !used.has(key)), []);

  const manifestText = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const manifestKeys = [...new Set([...manifestText.matchAll(/%([^%]+)%/g)].map(match => match[1]))];
  for (const file of ['package.nls.json', 'package.nls.zh-cn.json', 'package.nls.zh.json']) {
    const table = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.deepEqual(manifestKeys.filter(key => !Object.hasOwn(table, key)), []);
    assert.deepEqual(Object.keys(table).filter(key => !manifestKeys.includes(key)), []);
  }
});
