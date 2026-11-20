# Model data

Model presets are fetched online at runtime from [models.dev](https://models.dev) via [`https://models.dev/catalog.json`](https://models.dev/catalog.json), which combines canonical model metadata (`models.json`) and provider records (`api.json`) while omitting specialized non-chat model types by default. Upstream data is not labeled as independently verified by this project.

- [Catalog builder](../src/catalogBuilder.ts): fetches, validates, and converts online `models.dev` data into chat model presets.
- [Shared routing & matching](../resources/shared/routing.js): protocol assignment, non-chat exclusion, normalized preset lookup, and fallback display name formatting.

## Online sync & caching

On the first catalog read, BYOK Studio uses its local cache (`models-catalog.json` in VS Code `globalStorageUri`) and updates it in the background if it is more than six hours old. Refreshing a group's models waits for a catalog update if the cache is more than 15 minutes old. With no usable cache, the extension tries to fetch the catalog immediately. A failed download falls back to the last usable cache when available. Manual model configuration can use conservative defaults when the catalog is unavailable.

Each group compiles to a `customendpoint` entry in `chatLanguageModels.json`, while per-group API keys for model discovery and manual export are stored in VS Code's `SecretStorage`.

## Filtering & conversion rules

**Refresh** matches the model IDs returned by the provider against the IDs and aliases in the text chat catalog index. An unavailable catalog or a refresh with no matches leaves the draft list in place.

1. **Chat-only filtering**: Only models whose `type` is `chat`, `text`, or omitted, whose `modalities.input` includes `text`, whose `modalities.output` is strictly `["text"]`, and whose ID does not match non-chat exclusion patterns (image, video, audio, TTS, transcription, embeddings, reranking, moderation, realtime) are retained.
2. **Canonical + provider aggregation**: All valid canonical chat models in `models` are indexed alongside their leaf IDs and enriched with `reasoning_options` (`effort` levels and `budget_tokens`) from ranked linked provider entries. Unambiguous provider aliases, date-stripped first-party base slugs, and standalone chat models are also indexed.
3. **Token limits**: The editor and generated JSON use **Context** (`contextWindow`) and **Output** (`maxOutputTokens`), where Output is capped at the upstream provider/canonical limits, `131072` tokens, and one quarter of Context.
4. **Protocol compatibility**:
   - Claude reasoning models automatically emit `thinkingBudget` (`<= 4.5`) or `adaptiveThinking: true` (`>= 4.6` / 5.x+) under the `messages` protocol; custom `messages` thinking models also receive an automatic adaptive or budget fallback so `thinking` is always sent.
   - `kimi-k3` models retain `modelOptions: { "top_p": 0.95 }` under `chatCompletions`.
5. **Multi-stage ID matching & fallback naming**: Preset lookup matches exact IDs, case-insensitive IDs, slash-stripped leaf IDs, tag-stripped IDs (`:free`, `@eu`), normalized version separators (`2-1` ↔ `2.1`), and vendor-prefixed slugs (`doubao-seed-2-1-pro` → `seed-2.1-pro`). Unmatched custom IDs automatically format into readable title-cased names.

Upstream attribution and the MIT license are in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
