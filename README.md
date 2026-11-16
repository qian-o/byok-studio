# BYOK Studio

English | [简体中文](README.zh-CN.md)

A visual editor for Copilot's **Custom Endpoint** configuration in `chatLanguageModels.json`.

![Configuration page](docs/images/configuration-en.png)

## Configuration

- Provider names, with an independent API key, endpoint URLs, and model list for each group.
- **Chat Completions**, **Responses**, or **Messages** protocol settings, shared by all models or assigned per model.
- Model lists, display names, Context, Output, capabilities, and reasoning defaults.

Model presets are fetched online from [models.dev](https://models.dev) and cached locally by the extension. Adjust parameters in **Model settings**. [Parameter sources and matching rules](docs/SOURCES.md).

Context and Output are written directly as `contextWindow` and `maxOutputTokens` in the official JSON. Saving a group removes its old `maxInputTokens`, `zeroDataRetentionEnabled`, and `statefulResponses` model fields. Groups outside that operation remain unchanged.

## Usage

Requires **VS Code 1.145+** and **GitHub Copilot Chat**.

1. Run **BYOK Studio: Manage Models** from the Command Palette, or click the settings button at the bottom-right of Chat input.
2. Add a provider, enter its URL and API key, and choose **One protocol** or **Per-model protocols**. **Add group** creates independent keys, URLs, and models under the same provider.
3. Refresh or manually add models and adjust their settings.
4. Click **Save group** to write the native configuration and refresh Copilot Chat's model list. Select the corresponding **Custom Endpoint** model in Copilot Chat.

Groups are created inline without a separate dialog. Switching providers or groups preserves unsaved drafts. Click the edit icon beside the active provider tab to rename it inline; Enter finishes editing and Esc cancels. Click **Save group** to apply the name change. Edit group names in the right-hand form. The tab's delete icon removes the entire provider after confirmation, including all its groups, models, saved API keys, and unsaved drafts; **Delete group** in the right-hand form removes only the current group.

The extension activates on command and reads `customendpoint` groups directly from `chatLanguageModels.json`. Starting VS Code, opening the panel, and reading configuration never write data. Only explicitly saving, importing, or deleting groups updates their corresponding official configuration groups.

Each Studio group becomes a native `customendpoint` group. Named groups appear as **Provider · Group**; the default group keeps the provider name. Renaming a provider or group changes native model identifiers, so VS Code treats the models as new and their selection, hidden, and pinned states must be restored. Renaming a provider updates all its groups together.

**One protocol** mode uses a single protocol and URL for all models. **Per-model protocols** mode has no provider default: GPT / OpenAI models (including Codex) go to **Responses**, Claude models go to **Messages**, and other models go to **Chat Completions**. Change an individual model's **Request protocol**, or select models and move them to another protocol column. Switching modes preserves manual assignments.

**Refresh** replaces the model list and resets protocol assignments using these model family rules. Matching IDs keep their names, token overrides, and reasoning settings; endpoint URLs and the API key are retained. Models follow discovery order. Failed refreshes leave the draft unchanged.

Selecting models shows **Delete** immediately left of **Refresh**; deselecting all models hides it. **Select all** works on the unified list or an individual protocol column. Model deletion changes the draft until the group is saved. Completed saves show a green confirmation; failures show an error.

**Save group** is enabled only when the current configuration is valid and has unsaved changes. Ctrl+S (Cmd+S on macOS) also saves. Duplicate submissions are blocked during saving, and failures retain the draft for retry. Switching groups preserves model selection and scroll position. Repeating the same save does not rewrite configuration or create another key reference.

Use **Export** to select providers (all selected by default), then copy them to the clipboard or save a JSON file. Saved API keys are always included. **Import** reads from the clipboard or a JSON file and saves the selected providers; matching IDs or names update existing providers, and groups match by ID or provider-scoped name. Version 2 exports contain nested groups; version 1 exports and native configuration arrays remain supported. Close either dialog using its top-right close button or Esc. Transfer configurations between devices with manual import and export.

Run **BYOK Studio: Open Official Model Configuration** to inspect the generated JSON. Official configuration uses protected key references; exported transfer JSON contains plaintext API keys. Native VS Code key updates replace key references. If a native operation removes Studio metadata, the group remains readable as a standalone provider; re-enter its API key in Studio and save if needed.

<details>
<summary>Configuration example</summary>

```json
[
  {
    "name": "Example Gateway",
    "vendor": "customendpoint",
    "byokStudioId": "demo-group",
    "byokStudioProviderId": "demo-provider",
    "byokStudioProviderName": "Example Gateway",
    "byokStudioGroupName": "",
    "models": [
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "url": "https://chat.example.com/v1/chat/completions",
        "apiType": "chat-completions",
        "toolCalling": true,
        "vision": true,
        "contextWindow": 1048576,
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

Run `node scripts/preview-ui.cjs` to preview the UI with data stored only in memory.

- `src/` — extension and configuration logic
- `resources/` — webview and shared modules
- `scripts/` — local UI preview harness
- `docs/` — screenshots and parameter sources

```powershell
npm ci
npm run build
node --test scripts/configService.test.cjs
npm run package
```

## License

[MIT](LICENSE).
