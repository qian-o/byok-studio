# Model data

Model presets are fetched online at runtime from [models.dev](https://models.dev) via [`https://models.dev/catalog.json`](https://models.dev/catalog.json), which combines canonical model metadata (`models.json`) and provider records (`api.json`) while omitting specialized non-chat model types by default. Upstream data is not labeled as independently verified by this project.

- [Catalog builder](../src/catalogBuilder.ts): fetches, validates, and converts online `models.dev` data into chat model presets.
- [Shared routing & matching](../resources/shared/routing.js): protocol assignment, non-chat exclusion, normalized preset lookup, and fallback display name formatting.

## Online sync & caching

When opening BYOK Studio or refreshing provider models, the extension loads its local cache (`models-catalog.json` in VS Code `globalStorageUri`) and refreshes from `https://models.dev/catalog.json` when the cache is missing or expired (6 hours on open, 15 minutes on manual model refresh). If `models.dev` is temporarily unreachable, the extension falls back to the cached snapshot or conservative default parameters so provider configuration continues to work offline.

Provider configurations live directly in `chatLanguageModels.json`, while API keys for model discovery and manual export are stored in VS Code's `SecretStorage`.

## Filtering & conversion rules

1. **Chat-only filtering**: Only models whose `type` is `chat`, `text`, or omitted, whose `modalities.input` includes `text`, whose `modalities.output` is strictly `["text"]`, and whose ID does not match non-chat exclusion patterns (image, video, audio, TTS, transcription, embeddings, reranking, moderation, realtime) are retained.
2. **Canonical + provider aggregation**: All valid canonical chat models in `models` are indexed alongside their leaf IDs and enriched with `reasoning_options` (`effort` levels and `budget_tokens`) from ranked linked provider entries. Unambiguous provider aliases, date-stripped first-party base slugs, and standalone chat models are also indexed.
3. **Token limits**: The editor and generated JSON use **Context** (`contextWindow`) and **Output** (`maxOutputTokens`), where Output is capped at the upstream provider/canonical limits, `131072` tokens, and one quarter of Context.
4. **Protocol compatibility**:
   - Claude reasoning models automatically emit `thinkingBudget` (`<= 4.5`) or `adaptiveThinking: true` (`>= 4.6` / 5.x+) under the `messages` protocol; custom `messages` thinking models also receive an automatic adaptive or budget fallback so `thinking` is always sent.
   - `kimi-k3` models retain `modelOptions: { "top_p": 0.95 }` under `chatCompletions`.
5. **Multi-stage ID matching & fallback naming**: Preset lookup matches exact IDs, case-insensitive IDs, slash-stripped leaf IDs, tag-stripped IDs (`:free`, `@eu`), normalized version separators (`2-1` ↔ `2.1`), and vendor-prefixed slugs (`doubao-seed-2-1-pro` → `seed-2.1-pro`). Unmatched custom IDs automatically format into readable title-cased names.

Upstream attribution and the MIT license are in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
