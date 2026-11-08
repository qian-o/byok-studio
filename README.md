# BYOK Studio

English | [简体中文](README.zh-CN.md)

Use your own API keys and model endpoints in GitHub Copilot Chat. BYOK Studio visually manages VS Code's official **Custom Endpoint** configuration. Official Copilot handles chat requests; the extension has no chat runtime of its own.

## Features

- Manage providers, API keys, endpoint URLs, and editable model capabilities in one place.
- Use **Chat Completions**, **Responses**, or **Messages**, with one protocol for all models or separate protocols per model.
- Discover models, add or edit them manually, and move selected models between protocol columns.
- The interface follows VS Code's display language: Chinese for `zh` locales, English otherwise. Model IDs, custom labels, and URLs remain unchanged.

## Get started

You need **VS Code 1.145 or later**, the official **GitHub Copilot Chat** extension enabled, and your provider's API key and endpoint URL.

1. Download the `.vsix` package from [Releases](https://github.com/qian-o/byok-studio/releases/latest). Run **Extensions: Install from VSIX…** in the Command Palette, select the package, then run **Developer: Reload Window**.
2. Run **BYOK Studio: Manage Models** and add a provider.
3. Enter the provider name and API key. Choose a unified protocol or split protocols, then enter the corresponding URLs. Split protocols share the provider's key.
4. Discover models or add and edit them manually. **Discovery replaces the current model list.** In split mode, select models and move them to the target protocol column.
5. Save the provider to apply the configuration. You can save even without changes; leaving an existing provider's key blank preserves its stored key.
6. Open Copilot Chat and select the provider's **Custom Endpoint** model in the model picker.

## Presets and context

Built-in presets cover **182 exact model IDs** and provide editable parameter references. A preset does not guarantee that a model is available or that every endpoint supports its capabilities. See [parameter sources](data/SOURCES.md) for evidence and known gaps.

Each model uses its configured maximum context as a single budget, reserving output space when input and output share a window. There is currently no native context-size picker. Official Copilot handles input processing, compaction, and usage display; pricing information is a reference, with actual charges set by your provider.

## Privacy and compatibility

- API keys use VS Code's encrypted secret storage. Exported presets do not contain keys. Configuration updates and deletions affect only entries managed by BYOK Studio.
- Chat networking is handled by official Copilot. Model and endpoint support depends on the provider and Copilot's protocol adapters. Reasoning levels are offered only when the official configuration can express them.
- The zero data retention (ZDR) setting cannot enforce a provider's data retention policy.
- External JSON includes and arbitrary request-body JSON are unsupported.

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
