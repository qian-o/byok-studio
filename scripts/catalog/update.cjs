'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchModelCatalog, validateCatalogSnapshot } = require('../../dist/core/modelCatalog');

const OUTPUT = path.resolve(__dirname, '../../resources/catalog/models.json');

function checkSnapshot(raw) {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid catalog snapshot.');
  assert.deepEqual(Object.keys(raw).sort(), ['database', 'source', 'updatedAt']);
  const snapshot = validateCatalogSnapshot(raw);
  assert.deepEqual(Object.keys(raw.database).sort(), ['defaults', 'models', 'schemaVersion']);
  assert(Object.keys(snapshot.database.models).length > 0, 'The catalog must not be empty.');
  return snapshot;
}

async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: node scripts/catalog/update.cjs [--check]');
  if (args[0] === '--check') {
    const snapshot = checkSnapshot(JSON.parse(await fs.readFile(OUTPUT, 'utf8')));
    console.log(`Catalog OK: ${Object.keys(snapshot.database.models).length} models; ${snapshot.updatedAt}.`);
    return;
  }
  const snapshot = checkSnapshot(await fetchModelCatalog());
  const pending = `${OUTPUT}.pending-${process.pid}`;
  try {
    await fs.writeFile(pending, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(pending, OUTPUT);
  } finally { await fs.rm(pending, { force: true }); }
  console.log(`Updated community catalog: ${Object.keys(snapshot.database.models).length} models; ${snapshot.updatedAt}.`);
}

if (require.main === module) main().catch(error => {
  console.error(error && typeof error.message === 'string' ? error.message : 'Catalog update failed.');
  process.exitCode = 1;
});
module.exports = { checkSnapshot, main };
