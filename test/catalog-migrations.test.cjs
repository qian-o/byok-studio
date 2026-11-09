const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const migrations = require('../resources/catalog/migrations.json');
const { validateReasoningControls } = require('../dist/core/configuration');

// Captured from the original manifest after resolving its ids/file/field payloads.
// Object keys are sorted recursively; array order and every value remain significant.
const originalMigrations = [
  {
    "id": "0.1.1-codex-auto-review",
    "kind": "add",
    "sha256": "fcb6041ad078f1c05ff1d6c69bb03ef53af0831db215b0e0c45299afed8991a4"
  },
  {
    "id": "0.1.2-native-reasoning-efforts",
    "kind": "replace",
    "sha256": "2bfe6da22b07e2d1a57dc5234596f8923a8eab3b13dc57980d6a68f389a68891"
  },
  {
    "id": "0.1.4-release-dates",
    "kind": "dates",
    "sha256": "350cab8bd017f18eb1ea9ee14af1866ec8475da26f8e55429e8cfda195a18772"
  },
  {
    "id": "0.2.0-vendor-model-additions",
    "kind": "add",
    "sha256": "954759c66e7d4c394a86f79ab17c8ab87bcbc3e3d6e561511a8bc587687444e7"
  },
  {
    "id": "0.2.0-vendor-model-parameters",
    "kind": "replace",
    "sha256": "e07836929c017483348108688073d8208bc75bf208e4f0c2e333a53ae2bcdd0d"
  },
  {
    "id": "0.3.1-context-pricing",
    "kind": "pricing",
    "sha256": "8a59b9412752e11a89be82e1bebfef6bc9095af67cccb5813c1cf5c520d29d0c"
  },
  {
    "id": "0.4.0-friendly-alias-names",
    "kind": "names",
    "sha256": "6ca0fd66e5716354096e083694b5bf98a312f9b79807265c7ac41ee31bbfe9c5"
  },
  {
    "id": "0.5.0-official-model-revision",
    "kind": "revision",
    "sha256": "4f4f61f62b7c1b91afd346fe04338c254e6d5a0508286db264f2ccceef2dd70c"
  },
  {
    "id": "0.5.0-official-model-additions",
    "kind": "add",
    "sha256": "97283989442bcc23024634d4cd5f208174c03c8a13df9b80885987cdb4696a43"
  },
  {
    "id": "0.6.0-complete-catalog",
    "kind": "fields",
    "sha256": "8f583b0a2a4d901fb18c12c335bddf4da93abc3036029cd9fe177e3efed3ba33"
  },
  {
    "id": "0.6.0-complete-catalog-additions",
    "kind": "add",
    "sha256": "95da44768aaee8377c67ca73956300ccd93e8f6729373e24344e01a06028aabe"
  },
  {
    "id": "0.7.1-k3-sampling",
    "kind": "fields",
    "sha256": "bc808c8851533415a938ad82a985485d94c10d9bfda844755c847517b0c85e5f"
  }
];

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

test('consolidated legacy profiles preserve the original pre-0.6 validation defaults', () => {
  assert.deepStrictEqual(Object.keys(migrations).sort(), ['legacyProfiles', 'modelsDevBaseline', 'updates']);
  const hash = createHash('sha256').update(canonicalJson(migrations.legacyProfiles)).digest('hex');
  assert.equal(hash, '57da1cfc17dcb8a237c7dbfa0f66b7cb46b2ba81a1b981ccae41b54c93e9d13a');
});

test('pre-0.6 reasoning controls still resolve every bundled legacy protocol profile', () => {
  for (const [api, profiles] of Object.entries(migrations.legacyProfiles)) {
    for (const [name, profile] of Object.entries(profiles)) {
      assert.deepStrictEqual(
        validateReasoningControls({ [api]: name, note: 'Legacy configuration' }),
        validateReasoningControls({ protocols: { [api]: profile }, note: 'Legacy configuration' }),
        `${api}: ${name}`,
      );
    }
  }
});

test('consolidated migrations preserve every original ID, kind, order and resolved payload', () => {
  const actual = migrations.updates.map(migration => ({
    id: migration.id,
    kind: migration.kind,
    sha256: createHash('sha256').update(canonicalJson(migration)).digest('hex'),
  }));
  assert.deepStrictEqual(actual, originalMigrations);
});

test('only date and pricing migrations use the current seed instead of an inline payload', () => {
  for (const migration of migrations.updates) {
    const usesSeed = ['dates', 'pricing'].includes(migration.kind);
    assert.deepStrictEqual(Object.keys(migration).sort(), usesSeed ? ['id', 'kind'] : ['id', 'kind', 'payload'], migration.id);
    if (migration.kind === 'add') {
      assert.ok(Array.isArray(migration.payload), migration.id);
      assert.ok(migration.payload.every(id => typeof id === 'string'), migration.id);
    } else if (migration.kind === 'names') {
      assert.ok(migration.payload && typeof migration.payload === 'object' && !Array.isArray(migration.payload), migration.id);
      assert.ok(Object.values(migration.payload).every(name => typeof name === 'string'), migration.id);
    } else if (!usesSeed) {
      assert.ok(Array.isArray(migration.payload), migration.id);
      for (const replacement of migration.payload) {
        assert.equal(typeof replacement.id, 'string', migration.id);
        assert.ok(Object.hasOwn(replacement, 'before'), migration.id);
        assert.ok(Object.hasOwn(replacement, 'after'), migration.id);
      }
    }
  }
});
