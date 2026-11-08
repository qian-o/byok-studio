# BYOK Studio

English | [简体中文](README.zh-CN.md)

BYOK Studio is a visual editor for the **Custom Endpoint** entries in VS Code's `chatLanguageModels.json`. It saves provider and model settings to that file. Official GitHub Copilot handles chat requests.

![Configuration page with example endpoints and real model names](docs/images/configuration-en.png)

*Demo data: placeholder endpoint URLs, no API key.*

## Configuration

- Provider names, endpoint URLs, and API keys.
- **Chat Completions**, **Responses**, or **Messages** protocol settings, shared by all models or assigned per model.
- Model lists, display names, token limits, capability declarations, and reasoning defaults.

Model presets supply editable reference values. See [parameter sources](data/SOURCES.md) for their sources and known gaps. Declaring a capability does not add it to a model or to Copilot.

## Usage

Requires **VS Code 1.145 or later** with **GitHub Copilot Chat** enabled. After installing BYOK Studio:

1. Run **BYOK Studio: Manage Models** from the Command Palette.
2. Add a provider and enter its URL, API key, and protocol settings.
3. Refresh or manually add models, then adjust their settings as needed. Refreshing replaces the draft model list while retaining settings for matching IDs.
4. Click **Save provider** to write the configuration. Select the corresponding **Custom Endpoint** model in Copilot Chat.

The extension updates only the entries it manages and stores API keys through VS Code's secret storage. Leaving an existing provider's key blank keeps the saved key. Model availability and request behavior depend on the provider and official Copilot.

<details>
<summary>Generated configuration (one-model excerpt)</summary>

The following entry is generated from the example above; the other models are omitted.

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
        "supportsReasoningEffort": [
          "low",
          "high",
          "max"
        ],
        "modelOptions": {
          "top_p": 0.95
        }
      }
    ]
  }
]
```

</details>

## Development

With Node.js and npm installed, run from the project directory:

```powershell
npm ci
npm test
npm run package
```

Packaged VSIX files are written to `releases/`. For host integration tests, set `VSCODE_EXECUTABLE` to your VS Code executable and `VSCODE_COPILOT_EXTENSION` to your official Copilot extension directory, then run `npm run test:host`.

## License

[MIT](LICENSE).
