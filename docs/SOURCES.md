# Model data

The main source is [models.dev](https://models.dev), a community-maintained catalog. The release maintenance script reads [catalog.json](https://models.dev/catalog.json), which contains canonical model metadata and provider records. Upstream data is not labeled as independently verified by this project.

- [Bundled snapshot](../resources/catalog/models.json): the offline model preset catalog and its retrieval time.
- [Compatibility data](../resources/catalog/compatibility.json): source priorities and protocol parameters that upstream JSON cannot express for Copilot.
- [Catalog builder](../src/catalogBuilder.ts): used by the release maintenance script; the builder and compatibility source are excluded from the VSIX.

## Updates

Preset updates are prepared when releasing the extension using the commands below. There is no runtime download or implicit sync. Provider configurations live directly in `chatLanguageModels.json`, while API keys for model discovery and manual export are stored in VS Code's `SecretStorage`.

Presets are read-only defaults; adjust parameters in **Model settings**. Header **Import** / **Export** transfers provider configurations manually.

Provider records are selected by explicit priority, and aliases are matched through unambiguous upstream canonical IDs. Model discovery uses the configured provider's `/models` endpoint; `models.dev` does not determine which models an API key can access.

The editor and generated JSON use two token fields: **Context** (`contextWindow`) and **Output** (`maxOutputTokens`). Output must be smaller than Context. Saving a provider removes retired model fields (`maxInputTokens`, `defaultOutputTokens`, `contextWindowMode`, `streaming`, `zeroDataRetentionEnabled`, `statefulResponses`) on that provider while leaving unrelated configuration groups untouched.

Release-time conversion selects one usable Output default from upstream limits: at most the provider and canonical output limits, 131072 tokens, and one quarter of Context. This is a preset default that users can edit. Presets also contain capabilities, protocol settings, release dates and exact aliases. Pricing and per-record verification metadata are not stored.

Compatibility profiles retain only native reasoning formats, effort mappings, adaptive thinking, thinking budget bounds, and sampling options. Profiles that require unsupported request paths suppress the corresponding reasoning picker. Relevant sources are [Claude extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), [Google's OpenAI compatibility](https://aistudio.google.com/docs/openai), [Gemini long decoding](https://aistudio.google.com/docs/long-decode), and [Kimi model documentation](https://platform.kimi.ai/docs/api/models-overview.md).

## Maintenance

```powershell
npm run build
node scripts/catalog/update.cjs
node scripts/catalog/update.cjs --check
```

The first command builds the shared converter, the second refreshes the bundled snapshot, and `--check` validates it offline. Upstream attribution and the MIT license are in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
