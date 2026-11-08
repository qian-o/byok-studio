const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-extension-test-'));
  try {
    await fs.mkdir(path.join(temporary, 'user', 'User'), { recursive: true });
    await fs.writeFile(path.join(temporary, 'user', 'User', 'settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none', 'workbench.startupEditor': 'none' }));
    const executable = process.env.VSCODE_EXECUTABLE;
    await runTests({
      ...(executable ? { vscodeExecutablePath: executable } : {}),
      extensionDevelopmentPath: [path.resolve(__dirname, '..'), ...(process.env.VSCODE_COPILOT_EXTENSION ? [process.env.VSCODE_COPILOT_EXTENSION] : [])],
      extensionTestsPath: path.resolve(__dirname, '..', 'dist', 'hostTest.js'),
      launchArgs: ['--user-data-dir', path.join(temporary, 'user'), '--extensions-dir', path.join(temporary, 'extensions'), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu'],
      extensionTestsEnv: { BYOK_TEST_MODE: '1', BYOK_TEST_USER_DATA: path.join(temporary, 'user') }
    });
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
