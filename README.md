# BYOK Studio

English | [简体中文](README.zh-CN.md)

A visual editor for Copilot's **Custom Endpoint** configuration in `chatLanguageModels.json`.

![Configuration page](docs/images/configuration-en.png)

## Configuration

- Provider names, endpoint URLs, and API keys.
- **Chat Completions**, **Responses**, or **Messages** protocol settings, shared by all models or assigned per model.
- Model lists, display names, token limits, capability declarations, and reasoning defaults.

Model presets come from [models.dev](https://models.dev). Click **Update presets** at the top of the page, then adjust individual models in **Advanced options**. Per-model overrides are retained. [Parameter sources](docs/SOURCES.md).

BYOK Studio does not generate or manage `zeroDataRetentionEnabled` or `statefulResponses`. Existing values in the official JSON are preserved for retained models; new models use Copilot's defaults unless you edit the JSON yourself.

## Usage

Requires **VS Code 1.145+** and **GitHub Copilot Chat**.

1. Run **BYOK Studio: Manage Models** from the Command Palette.
2. Add a provider, enter its URL and API key, and choose **One protocol** or **Per-model protocols**.
3. Refresh or manually add models and adjust their settings.
4. Click **Save provider** to write the native configuration and refresh Copilot Chat's model list. Select the corresponding **Custom Endpoint** model in Copilot Chat.

**One protocol** mode uses a single protocol and URL for all models. **Per-model protocols** mode has no provider default: GPT / OpenAI models (including Codex) go to **Responses**, Claude models go to **Messages**, and other models go to **Chat Completions**. Change an individual model's **Request protocol**, or select models and move them to another protocol column. Switching modes preserves manual assignments.

**Refresh** replaces the model list and resets protocol assignments using these model family rules. Matching IDs keep their names, token overrides, and reasoning settings; endpoint URLs and the API key are retained. Models follow discovery order. Failed refreshes leave the draft unchanged.

Select models in either mode to **Delete selected**, then confirm the count. Use **Select all** for the unified list or an individual protocol column, or clear the selection. Deletion changes only the current draft until you save the provider. A green confirmation appears after writing the native configuration and refreshing the Chat model list both complete; failures remain visible as errors.

Use **Export** to select providers (all selected by default), then copy them to the clipboard or save a JSON file. Saved API keys are always included. **Import** reads from the clipboard or a JSON file and saves the selected providers; matching IDs or names update existing providers. Close either dialog using its top-right close button or Esc. Transfer configurations between devices with manual import and export.

Successful saves show **Provider saved.** and successful imports show **Imported N providers.** Run **BYOK Studio: Open Official Model Configuration** to inspect the actual `chatLanguageModels.json`. Each provider becomes a `customendpoint` group, with request URLs, protocols, and capabilities on each model. The official JSON references protected keys using `${input:chat.lm.secret.…}`; exported transfer JSON contains plaintext API keys.

<details>
<summary>Configuration example</summary>

```json
[
  {
    "name": "Example Gateway",
    "vendor": "customendpoint",
    "byokStudioId": "demo-provider",
    "models": [
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "url": "https://chat.example.com/v1/chat/completions",
        "apiType": "chat-completions",
        "toolCalling": true,
        "vision": true,
        "maxInputTokens": 917504,
        "maxOutputTokens": 131072,
        "thinking": true,
        "supportsReasoningEffort": ["low", "high", "max"],
        "modelOptions": { "top_p": 0.95 }
      }
    ]
  }
]
```

</details>

## Development

The browser preview stores test configuration in process memory and does not write VS Code's official configuration. Use the extension development host to verify Chat model-list updates.

- `src/` — extension and configuration logic
- `resources/` — webview, shared modules, and runtime catalog
- `scripts/` — development tools and catalog maintenance
- `test/` — regression tests
- `docs/` — screenshots and parameter sources

```powershell
npm ci
npm test
npm run package
```

## License

[MIT](LICENSE).
