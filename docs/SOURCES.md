# Bundled model catalog sources

This catalog is a metadata snapshot, not a guarantee of availability on a proxy. Request IDs remain exact and unchanged. Display names never identify or route a model.

## Snapshot

- Community snapshot retrieved: 2026-11-07T17:43:20.020Z; source: https://models.dev/api.json; SHA-256: 5c52dac52706eb70c5172ca167aae97e39143f34bfa8fa0b266dbf908051f408.
- Catalog: 182 exact IDs; 21 records carry a complete verification date; 13 explicit alias presets.
- Coverage: **158 known release dates**; **24 unknown dates**. These are not model verification dates. An absent release date is unknown. Its release date is not officially verified solely by catalog retrieval.
- Every exact catalog ID is accounted for in [catalog-audit.json](catalog-audit.json). Read its field evidence, uncertainty and lifecycle together with the model source; partial verification is not a claim of fully verified limits.

## K3 sampling review — 2026-11-08

The [official parameter reference](https://platform.kimi.ai/docs/api/models-overview.md) fixes K3-series `top_p` at `0.95` and `temperature` at `1.0`, recommends omission, and applies the same constraints to K3.1 Pro and Highspeed. The [Messages schema](https://platform.kimi.ai/docs/api/messages.md) uses `output_config.effort`; `reasoning.effort` belongs to Responses.

For VS Code commit `c4453f8ea430795f941c1b2ff6c9321135a74a02`, [services.ts](https://github.com/microsoft/vscode/blob/c4453f8ea430795f941c1b2ff6c9321135a74a02/extensions/copilot/src/extension/extension/vscode/services.ts#L127) defaults to `topP: 1`, and [OpenAIEndpoint](https://github.com/microsoft/vscode/blob/c4453f8ea430795f941c1b2ff6c9321135a74a02/extensions/copilot/src/extension/byok/node/openAIEndpoint.ts#L293) forwards it for Custom Endpoint Chat Completions. Its `modelOptions` override fixes this to `0.95`; its thinking-model interceptor omits `temperature`. Responses and Messages builders do not inject these sampling defaults, so their profiles need no sampling override. This was verified from pinned source and configuration tests, without a paid inference call.

[The 0.7.1 migration](../resources/catalog/migrations.json) (`0.7.1-k3-sampling`) updates unmodified K3 profiles while retaining user-maintained profile fields.

## Context capacity and pricing — 2026-11-08

Model capacity and price boundaries are separate. The [GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) lists 1,050,000 total context, 922,000 maximum input and 128,000 maximum output; its 272,000 input pricing threshold is not the model's context limit. The dedicated [Grok 4.5](https://docs.x.ai/developers/models/grok-4.5), [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6) and [Grok 4.7](https://docs.x.ai/developers/models/grok-4.7) pages each confirm a 500,000-token window. These exact IDs should not be assigned 1M merely because another Grok variant supports it. Their independent output ceilings remain unverified; this review does not promote the existing local output budget to an official maximum.

The configuration manager uses the full available input allocation after reserving output. Since 0.7.3, pricing thresholds remain reference data without a budget picker; retired `contextSize` caps are removed during state normalization. Multiple budget configurations are deferred until native Context switching is supported. No catalog-capacity migration is required for the GPT and Grok entries above: their stored capacity was correct; the earlier generator incorrectly defaulted to the first pricing boundary.

## Declarative configuration

[overrides.json](../scripts/catalog/overrides.json) holds checked model facts; [rules.json](../resources/catalog/rules.json) holds routing recommendations and non-chat exclusions; [generation.json](../scripts/catalog/generation.json) holds source-selection and historical evidence. Runtime code interprets protocol configuration without recognizing model IDs or manufacturers.

Physical output capacity is distinct from the default generation budget. Native input and output reservations must fit together, even for models whose independently documented output capacity equals the whole window. Unknown physical limits remain labeled rather than inferred from a model name.

| Request ID | Context | Output ceiling / disclosed starting limit | Default output budget | Effort enum | Provenance |
| --- | ---: | ---: | --- | --- | --- |
| `GLM-5.3` | 1000000 | 131072 | bounded by remaining context | low, high, max | preset from `glm-5.3` |
| `GLM-5.3-Flash` | 1000000 | 131072 | bounded by remaining context | low, high, max | preset from `glm-5.3-flash` |
| `claude-fable-5` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | partially verified; see source |
| `claude-fable-5-1` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | official |
| `claude-haiku-4-5` | 200000 | 64000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `claude-haiku-4-5-20251001` | 200000 | 64000 | bounded by remaining context | budget / server default; see source | official |
| `claude-haiku-5-5` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | partially verified; see source |
| `claude-opus-4-5` | 200000 | 64000 | bounded by remaining context | low, medium, high | partially verified; see source |
| `claude-opus-4-5-20251101` | 200000 | 64000 | bounded by remaining context | low, medium, high | partially verified; see source |
| `claude-opus-4-6` | 1000000 | 128000 | bounded by remaining context | low, medium, high, max | official |
| `claude-opus-4-7` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | official |
| `claude-opus-4-8` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | official |
| `claude-opus-5` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | official |
| `claude-opus-5-5` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | partially verified; see source |
| `claude-sonnet-4-5` | 200000 | 64000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `claude-sonnet-4-5-20250929` | 200000 | 64000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `claude-sonnet-4-6` | 1000000 | 128000 | bounded by remaining context | low, medium, high, max | official |
| `claude-sonnet-5` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | official |
| `claude-sonnet-5-5` | 1000000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | official |
| `codex-auto-review` | 128000 | 16000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `deepseek-flash` | 1048576 | 393216 | 65536 | none, low, high, max | partially verified; see source |
| `deepseek-v4-flash` | 1048576 | 393216 | 65536 | none, low, high, max | preset from `deepseek-flash` |
| `deepseek-v4-flash-vision-exp` | 1048576 | 393216 | 65536 | none, low, high, max | preset from `deepseek-flash` |
| `deepseek-v4-pro` | 1048576 | 393216 | 65536 | none, low, high, max | partially verified; see source |
| `deepseek-v4.1-flash` | 1048576 | 393216 | 65536 | none, low, high, max | preset from `deepseek-flash` |
| `deepseek-v4.1-flash-1017` | 1048576 | 393216 | 65536 | none, low, high, max | preset from `deepseek-flash` |
| `doubao-seed-1-6-251015` | 256000 | 64000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `doubao-seed-1-6-flash-250828` | 256000 | 32000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `doubao-seed-1-6-vision-250815` | 256000 | 32000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `doubao-seed-1-8-251228` | 256000 | 64000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `doubao-seed-2-0-code-preview-260215` | 262144 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `doubao-seed-2-0-lite-260428` | 256000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `doubao-seed-2-0-mini-260428` | 256000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `doubao-seed-2-0-pro-260215` | 256000 | 128000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `doubao-seed-2-1-pro` | 1024000 | 256000 | 65536 | none, minimal, low, medium, high, xhigh, max | preset from `doubao-seed-2-1-pro-260915` |
| `doubao-seed-2-1-pro-260628` | 256000 | 256000 | 65536 | none, minimal, low, medium, high, xhigh, max | partially verified; see source |
| `doubao-seed-2-1-pro-260915` | 1024000 | 256000 | 65536 | none, minimal, low, medium, high, xhigh, max | partially verified; see source |
| `doubao-seed-2-1-turbo` | 256000 | 256000 | 65536 | none, minimal, low, medium, high, xhigh, max | preset from `doubao-seed-2-1-turbo-260628` |
| `doubao-seed-2-1-turbo-260628` | 256000 | 256000 | 65536 | none, minimal, low, medium, high, xhigh, max | partially verified; see source |
| `gemini-2.5-computer-use-preview-10-2025` | 128000 | 64000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gemini-2.5-flash` | 1048576 | 65536 | bounded by remaining context | none, minimal, low, medium, high | partially verified; see source |
| `gemini-2.5-flash-lite` | 1048576 | 65536 | bounded by remaining context | none, minimal, low, medium, high | partially verified; see source |
| `gemini-2.5-pro` | 1048576 | 65536 | bounded by remaining context | minimal, low, medium, high | partially verified; see source |
| `gemini-3-flash-preview` | 1048576 | 65536 | bounded by remaining context | minimal, low, medium, high | partially verified; see source |
| `gemini-3.1-flash-lite` | 1048576 | 65536 | bounded by remaining context | minimal, low, medium, high | official |
| `gemini-3.1-flash-lite-preview` | 1048576 | 65536 | bounded by remaining context | minimal, low, medium, high | partially verified; see source |
| `gemini-3.1-pro-preview` | 1048576 | 65536 | bounded by remaining context | low, medium, high | partially verified; see source |
| `gemini-3.1-pro-preview-customtools` | 1048576 | 65536 | bounded by remaining context | low, medium, high | partially verified; see source |
| `gemini-3.5-flash` | 1048576 | 65536 | bounded by remaining context | minimal, low, medium, high | preset from `gemini-3.6-flash` |
| `gemini-3.5-flash-lite` | 1048576 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gemini-3.6-flash` | 1048576 | 65536 | bounded by remaining context | minimal, low, medium, high | partially verified; see source |
| `gemini-3.7-flash` | 1048576 | 65536 | bounded by remaining context | low, medium, high | preset from `gemini-3.8-flash` |
| `gemini-3.8-flash` | 1048576 | 65536 | bounded by remaining context | low, medium, high | official |
| `gemini-4-argon` | 1048576 | 65536 | bounded by remaining context | minimal, low, medium, high | official |
| `gemini-flash-latest` | 1048576 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gemini-flash-lite-latest` | 1048576 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gemini-pro-latest` | 1048576 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gemma-4-26b-a4b-it` | 262144 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gemma-4-31b-it` | 262144 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.5` | 131072 | 98304 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.5-air` | 131072 | 98304 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.5-flash` | 131072 | 98304 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.5v` | 64000 | 16384 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.6` | 204800 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.6v` | 128000 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.6v-flash` | 128000 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.7` | 204800 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.7-flash` | 200000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-4.7-flashx` | 200000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-5` | 204800 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-5-turbo` | 200000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-5.1` | 200000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `glm-5.2` | 1000000 | 131072 | bounded by remaining context | none, minimal, low, medium, high, xhigh, max | partially verified; see source |
| `glm-5.3` | 1000000 | 131072 | bounded by remaining context | low, high, max | partially verified; see source |
| `glm-5.3-flash` | 1000000 | 131072 | bounded by remaining context | low, high, max | partially verified; see source |
| `glm-5.3-flashx` | 1000000 | 131072 | bounded by remaining context | low, high, max | partially verified; see source |
| `glm-5v-turbo` | 200000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-3.5-turbo` | 16385 | 4096 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4-turbo` | 128000 | 4096 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4.1` | 1047576 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4.1-mini` | 1047576 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4.1-nano` | 1047576 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4o` | 128000 | 16384 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4o-2024-05-13` | 128000 | 4096 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4o-2024-08-06` | 128000 | 16384 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4o-2024-11-20` | 128000 | 16384 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-4o-mini` | 128000 | 16384 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-5` | 400000 | 128000 | bounded by remaining context | minimal, low, medium, high | partially verified; see source |
| `gpt-5-mini` | 400000 | 128000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-5-nano` | 400000 | 128000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-5-pro` | 400000 | 272000 | bounded by remaining context | high | partially verified; see source |
| `gpt-5.1` | 400000 | 128000 | bounded by remaining context | none, low, medium, high | partially verified; see source |
| `gpt-5.2` | 400000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh | partially verified; see source |
| `gpt-5.2-pro` | 400000 | 128000 | bounded by remaining context | medium, high, xhigh | partially verified; see source |
| `gpt-5.3-codex` | 400000 | 128000 | bounded by remaining context | low, medium, high, xhigh | partially verified; see source |
| `gpt-5.3-codex-spark` | 128000 | 32000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `gpt-5.4` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh | partially verified; see source |
| `gpt-5.4-mini` | 400000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh | partially verified; see source |
| `gpt-5.4-nano` | 400000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh | partially verified; see source |
| `gpt-5.4-pro` | 1050000 | 128000 | bounded by remaining context | medium, high, xhigh | partially verified; see source |
| `gpt-5.5` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh | partially verified; see source |
| `gpt-5.5-pro` | 1050000 | 128000 | bounded by remaining context | medium, high, xhigh | partially verified; see source |
| `gpt-5.6` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh, max | preset from `gpt-5.6-sol` |
| `gpt-5.6-luna` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh, max | official |
| `gpt-5.6-sol` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh, max | official |
| `gpt-5.6-terra` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh, max | official |
| `gpt-6-astra` | 1050000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | partially verified; see source |
| `gpt-6-luna` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh, max | official |
| `gpt-6-sol` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh, max | official |
| `gpt-6.1-sol` | 1050000 | 128000 | bounded by remaining context | low, medium, high, xhigh, max | official |
| `gpt-6.1-terra` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh, max | official |
| `gpt-daybreak-blue-latest` | 1050000 | 128000 | bounded by remaining context | none, low, medium, high, xhigh, max | preset from `gpt-5.6-sol` |
| `gpt-daybreak-red-latest` | 400000 | 128000 | bounded by remaining context | budget / server default; see source | preset from `gpt-5.6-cyber` |
| `grok-4.20-0309-non-reasoning` | 1000000 | 30000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `grok-4.20-0309-reasoning` | 1000000 | 30000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `grok-4.20-multi-agent-0309` | 1000000 | 30000 | bounded by remaining context | low, high | partially verified; see source |
| `grok-4.3` | 1000000 | 30000 | bounded by remaining context | none, low, medium, high, xhigh | partially verified; see source |
| `grok-4.5` | 500000 | 16000 | 16000 | low, medium, high | partially verified; see source |
| `grok-4.6` | 500000 | 16000 | 16000 | low, medium, high, xhigh | partially verified; see source |
| `grok-4.7` | 500000 | 16000 | 16000 | low, medium, high, xhigh | partially verified; see source |
| `grok-build-0.1` | 256000 | 16000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `kimi-k2.6` | 262144 | 262144 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `kimi-k2.7-code` | 262144 | 262144 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `kimi-k2.7-code-highspeed` | 262144 | 262144 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `kimi-k3` | 1048576 | 1048576 | 131072 | low, high, max | partially verified; see source |
| `kimi-k3.1-pro` | 1048576 | 1048576 | 131072 | low, high, max | official |
| `kimi-k3.1-pro-highspeed` | 1048576 | 1048576 | 131072 | low, high, max | official |
| `o1` | 200000 | 100000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `o1-pro` | 200000 | 100000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `o3` | 200000 | 100000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `o3-mini` | 200000 | 100000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `o3-pro` | 200000 | 100000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `o4-mini` | 200000 | 100000 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qvq-max` | 131072 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-deep-research` | 1000000 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-doc-turbo` | 131072 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-flash` | 1000000 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-long` | 10000000 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-math-plus` | 4096 | 3072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-math-turbo` | 4096 | 3072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-max` | 32768 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-mt-plus` | 16384 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-mt-turbo` | 16384 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-plus` | 1000000 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-plus-character` | 32768 | 4096 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-plus-character-ja` | 8192 | 512 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-turbo` | 1000000 | 16384 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-vl-max` | 131072 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-vl-ocr` | 34096 | 4096 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen-vl-plus` | 131072 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-14b` | 131072 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-235b-a22b` | 131072 | 16384 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-32b` | 131072 | 16384 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-8b` | 131072 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-coder-30b-a3b-instruct` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-coder-480b-a35b-instruct` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-coder-flash` | 1000000 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-coder-plus` | 1048576 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-max` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-next-80b-a3b-instruct` | 131072 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-next-80b-a3b-thinking` | 131072 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-vl-235b-a22b` | 131072 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-vl-30b-a3b` | 131072 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3-vl-plus` | 262144 | 32768 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.5-122b-a10b` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.5-27b` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.5-35b-a3b` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.5-397b-a17b` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.5-flash` | 1000000 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.5-plus` | 1000000 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.6-27b` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.6-35b-a3b` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.6-flash` | 1000000 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.6-max-preview` | 262144 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.6-plus` | 1000000 | 65536 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.7-flash` | 1000000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.7-max` | 1000000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.7-plus` | 1000000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.8-flash` | 1000000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.8-max` | 1000000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwen3.8-omni-flash` | 1000000 | 131072 | bounded by remaining context | budget / server default; see source | partially verified; see source |
| `qwq-plus` | 131072 | 8192 | bounded by remaining context | budget / server default; see source | partially verified; see source |

## Context pricing

[pricing.json](../scripts/catalog/pricing.json) contains input ceilings inclusive of the lower price band, optional output-dependent bands, currency, rates per million tokens, sources and dates. Null is an open-ended last band. Service tiers, time-of-day tariffs, promotions, cache duration and region are separate from context-length tiers and are described in each policy. Unknown is never treated as flat. Original API prices need not match a proxy's prices.

## Source selection

Only text-input/text-output models from the configured sources are eligible. Explicit ID filters, exclusions and source precedence are data. Removed or retired IDs can remain as proxy presets with honest lifecycle information. No request ID is rewritten. An absent effort enum may mean budget/toggle control or missing evidence; consult the declared controls.

| Source | Source key |
| --- | --- |
| OpenAI | `openai` |
| Claude / Anthropic | `anthropic` |
| Grok / xAI | `xai` |
| Gemini / Google | `google` |
| Doubao / Volcengine | `volcengine` |
| DeepSeek | `deepseek` |
| GLM / Z.AI | `zai` |
| GLM (China; additional IDs only) | `zhipuai` |
| Kimi / Moonshot AI | `moonshotai` |
| Qwen (international; other manufacturer) | `alibaba` |
| Qwen (China; additional IDs only) | `alibaba-cn` |

Historical required-ID evidence (superseded by a later explicit audit):

| Exact IDs | Checked on | Source | Values / evidence |
| --- | --- | --- | --- |
| `gpt-5.6-luna` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | Reasoning.effort supports: none, low, medium (default), high, xhigh, and max. |
| `gpt-5.6-sol` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | Reasoning.effort supports: none, low, medium (default), high, xhigh, and max. |
| `gpt-5.6-terra` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | Reasoning.effort supports: none, low, medium (default), high, xhigh, and max. |
| `gpt-6-astra` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/gpt-6-astra) | `reasoning.effort` supports `low`, `medium`, `high`, `xhigh`, and `max`. |
| `gpt-6-sol` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/gpt-6-sol) | `reasoning.effort` supports `none`, `low`, `medium` (default), `high`, `xhigh`, and `max`. |
| `gpt-6.1-sol` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | `reasoning.effort` supports `low`, `medium` (default), `high`, `xhigh`, and `max`. |
| `gpt-6.1-terra` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/gpt-6.1-terra) | `reasoning.effort` supports `none`, `low`, `medium` (default), `high`, `xhigh`, and `max`. |
| `gpt-5` | 2026-11-07 | [Primary source](https://developers.openai.com/api/docs/models/gpt-5) | minimal / low / medium / high |
| `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5` | 2026-11-07 | [Primary source](https://platform.claude.com/docs/en/build-with-claude/effort) | low / medium / high / xhigh / max |
| `claude-opus-4-6`, `claude-sonnet-4-6` | 2026-11-07 | [Primary source](https://platform.claude.com/docs/en/build-with-claude/effort) | low / medium / high / max |
| `claude-opus-4-5-20251101` | 2026-11-07 | [Primary source](https://platform.claude.com/docs/en/build-with-claude/effort) | low / medium / high |
| `deepseek-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` | 2026-11-07 | [Primary source](https://api-docs.deepseek.com/guides/thinking_mode/) | low / high / max |
| `gemini-4-argon`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite`, `gemini-3.1-flash-lite-preview` | 2026-11-08 | [Primary source](https://aistudio.google.com/docs/openai) | OpenAI reasoning_effort minimal / low / medium / high maps to Argon thinking_level low / low / medium / high, and to the identically named Gemini 3 Flash / 3.1 Flash-Lite levels. |
| `gemini-3.8-flash` | 2026-11-08 | [Primary source](https://aistudio.google.com/docs/openai) | The Chat Completions example explicitly sends model="gemini-3.8-flash", reasoning_effort="low". Other wire values are not asserted from native thinking levels. |
| `gemini-2.5-pro` | 2026-11-08 | [Primary source](https://aistudio.google.com/docs/openai) | The Gemini 2.5 compatibility column maps minimal / low / medium / high to budgets 1024 / 1024 / 8192 / 24576; thinking cannot be disabled for 2.5 Pro. |
| `gemini-2.5-flash`, `gemini-2.5-flash-lite` | 2026-11-08 | [Primary source](https://aistudio.google.com/docs/openai) | For 2.5 models reasoning_effort="none" disables thinking, except for 2.5 Pro. The remaining wire levels use the documented 2.5 budget mapping. |
| `grok-4.5` | 2026-11-08 | [Primary source](https://docs.x.ai/developers/model-capabilities/text/reasoning) | grok-4.5 supports low / medium / high. xhigh is treated as high rather than a distinct supported level. |
| `grok-4.6`, `grok-4.7` | 2026-11-08 | [Primary source](https://docs.x.ai/developers/model-capabilities/text/reasoning) | grok-4.6 and grok-4.7 support low / medium / high / xhigh. Reasoning cannot be disabled. |
| `kimi-k3`, `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed` | 2026-11-08 | [Primary source](https://platform.kimi.ai/docs/api/models-overview.md) | K3 series supports top-level reasoning_effort low / high / max. K3.1 Pro and its highspeed variant explicitly have the same parameter constraints as K3. K2.x does not support reasoning_effort. |
| `glm-5.3` | 2026-11-08 | [Primary source](https://docs.z.ai/guides/llm/glm-5.3) | The glm-5.3 API supports reasoning_effort low / high / max; thinking.type must be enabled. |
| `glm-5.3-flash`, `glm-5.3-flashx` | 2026-11-08 | [Primary source](https://docs.z.ai/guides/vlm/glm-5.3-flash) | The listed lowercase Flash/FlashX Model Codes use the same text parameters as GLM-5.3, whose documented reasoning_effort values are low / high / max. |
| `doubao-seed-2-1-pro-260915`, `doubao-seed-2-1-lite-260915`, `doubao-seed-2-1-pro-260628`, `doubao-seed-2-1-turbo-260628`, `doubao-seed-2-0-lite-260428`, `doubao-seed-2-0-mini-260428`, `doubao-seed-2-0-pro-260215`, `doubao-seed-2-0-lite-260215`, `doubao-seed-2-0-mini-260215`, `doubao-seed-2-0-code-preview-260215` | 2026-11-08 | [Primary source](https://docs.volcengine.com/docs/zh/ark/deep-thinking.md) | The enumerated models accept all seven Chat API reasoning_effort values; none maps to minimal (thinking off), and xhigh / max map to high. |

Historical source conflicts remain explicit in the generation rules:

- `doubao-seed-evolving`: models.dev reports 256000 context, while the primary model list now reports 1024k; exact numeric limits need reconciliation.
- `doubao-seed-character-260628`: models.dev reports 256000 context/output, while the primary model list reports 128k context, 96k input and 32k answer; exact numeric limits need reconciliation.

## Maintenance

Run `node scripts/catalog/update.cjs --check` after a catalog change. Generation never changes the user's stored database. Installed upgrades use declarative migration records and preserve manual model settings. Dates are recorded only when explicitly present; unknown/future dates are not invented from IDs.

Runtime data lives in [models.json](../resources/catalog/models.json), [rules.json](../resources/catalog/rules.json) and [migrations.json](../resources/catalog/migrations.json). The migration document is a plain JSON object: `legacyProfiles` retains the protocol defaults needed to validate pre-0.6 configurations, and `updates` is an ordered array of records with unchanged `id` and `kind` values and an inline `payload` when needed. Date and pricing migrations use the current model seed. The names migration also supplies the generator's display-name map. [release-dates.json](../scripts/catalog/release-dates.json) is historical authoring evidence, not a runtime migration input. Authoring evidence in `scripts/catalog/` and the source and audit documents in `docs/` are not runtime resources. Historical model `source` strings are retained verbatim, including old paths.
