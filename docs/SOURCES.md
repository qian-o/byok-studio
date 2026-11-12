# Model data

The main source is [models.dev](https://models.dev), a community-maintained catalog. BYOK Studio reads [catalog.json](https://models.dev/catalog.json), which contains canonical model metadata and provider records. Upstream data is not labeled as independently verified by this project.

- [Bundled snapshot](../resources/catalog/models.json): the offline starting catalog and its retrieval time.
- [Compatibility data](../resources/catalog/compatibility.json): source priorities and parameters that the upstream JSON cannot express for Copilot.
- [Converter](../src/core/modelCatalog.ts): used by both the extension and the maintenance script.

## Updates

Use **Update presets** at the top of the settings page. A successful update is cached locally. Network or validation errors leave the previous catalog intact. Startup uses the bundled or cached snapshot without making a network request.

Presets are read-only; change model parameters using each model's **Advanced options**. There is no separate preset editor or preset JSON import/export workflow (header **Import** / **Export** transfers provider configurations only). Provider keys, URLs, model IDs and per-model overrides remain separate from the upstream snapshot.

An update replaces the preset snapshot. A configured model missing from the new snapshot uses the new defaults with its existing overrides. If any saved model becomes invalid or loses its selected reasoning level, the entire update is rejected and the previous snapshot and timestamp remain unchanged.

When upgrading from the editable library, supported settings used by saved providers (including disabled providers) are converted into per-model overrides and custom names. Unused entries from the old editable library are discarded after a successful save. Incompatible legacy settings stop conversion with an explicit error and leave the original storage intact.

Provider records are selected by explicit priority. Aliases are matched only through unambiguous upstream canonical IDs. Provider discovery still uses the configured provider's model-list endpoint; models.dev does not determine which models an API key can access.

Input/output allocation and protocol translation are configuration rules. Output capacity is not an instruction to reserve the entire context window. Presets contain token limits, capabilities, supported protocol settings, release dates and exact aliases. Pricing and per-record verification metadata are not stored.

Compatibility profiles retain only native reasoning formats, effort mappings, adaptive thinking, thinking budget bounds, and sampling options. Profiles that require unsupported request paths suppress the corresponding reasoning picker. Relevant sources are [Claude extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), [Google's OpenAI compatibility](https://aistudio.google.com/docs/openai), [Gemini long decoding](https://aistudio.google.com/docs/long-decode), and [Kimi model documentation](https://platform.kimi.ai/docs/api/models-overview.md).

## Maintenance

```powershell
npm run build
node scripts/catalog/update.cjs
node scripts/catalog/update.cjs --check
```

The first command builds the shared converter, the second refreshes the bundled snapshot, and `--check` validates it offline. Upstream attribution and the MIT license are in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
