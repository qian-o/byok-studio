# Model data

The main source is [models.dev](https://models.dev), a community-maintained catalog. BYOK Studio reads [catalog.json](https://models.dev/catalog.json), which contains canonical model metadata and provider records. Upstream data is not labeled as independently verified by this project.

- [Bundled snapshot](../resources/catalog/models.json): the offline starting catalog and its retrieval time.
- [Compatibility data](../resources/catalog/compatibility.json): source priorities and parameters that the upstream JSON cannot express for Copilot.
- [Converter](../src/core/modelCatalog.ts): used by both the extension and the maintenance script.
- [Legacy migrations](../resources/catalog/migrations.json): retained only to upgrade existing installations without replacing user edits.

## Updates

Use **Update presets** in the model library. A successful update is cached in VS Code storage. Network or validation errors leave the previous catalog intact. Startup does not make a network request.

Updates compare the current library with its previous source snapshot. Manual fields, custom entries, deleted presets, provider keys, URLs, model IDs and per-model overrides are preserved. Entries absent from an upstream update remain available locally.

Provider records are selected by explicit priority. Aliases are matched only through unambiguous upstream canonical IDs. Provider discovery still uses the configured provider's model-list endpoint; models.dev does not determine which models an API key can access.

Input/output allocation and protocol translation are configuration rules. Output capacity is not an instruction to reserve the entire context window. Pricing is stored only when the response can be represented faithfully; provider and proxy charges may differ.

## Maintenance

```powershell
npm run build
node scripts/catalog/update.cjs
node scripts/catalog/update.cjs --check
```

The first command builds the shared converter, the second refreshes the bundled snapshot, and `--check` validates it offline. Upstream attribution and the MIT license are in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
