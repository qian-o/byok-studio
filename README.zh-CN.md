# BYOK Studio

[English](README.md) | 简体中文

BYOK Studio 是 VS Code 的 `chatLanguageModels.json` 中 **Custom Endpoint** 配置项的可视化编辑器。它将供应商和模型设置保存到该文件，聊天请求由官方 GitHub Copilot 处理。

## 配置内容

- 供应商名称、端点地址和 API Key。
- **Chat Completions**、**Responses** 或 **Messages** 协议配置，可统一设置或按模型分配。
- 模型列表、显示名称、Token 限制、能力声明和默认推理档位。

模型预设提供可编辑的参数参考，来源与已知缺口见[参数来源](data/SOURCES.md)。填写能力声明不会为模型或 Copilot 增加相应能力。

## 使用

需要 **VS Code 1.145 或更新版本**，并启用 **GitHub Copilot Chat**。安装 BYOK Studio 后：

1. 在命令面板执行 **BYOK Studio: 管理模型**。
2. 添加供应商，填写地址、API Key 和协议配置。
3. 刷新或手动添加模型，按需调整设置。刷新会替换草稿中的模型列表，保留相同 ID 模型的设置。
4. 点击 **保存供应商** 写入配置，然后在 Copilot Chat 中选择对应的 **Custom Endpoint** 模型。

扩展只更新自己管理的配置项，API Key 通过 VS Code 的密钥存储保存。编辑已有供应商时，Key 留空会保留已存密钥。模型是否可用及请求行为取决于供应商和官方 Copilot。

## 开发

安装 Node.js 和 npm 后，在项目目录中执行：

```powershell
npm ci
npm test
npm run package
```

VSIX 安装包输出到 `releases/`。运行宿主集成测试时，将 `VSCODE_EXECUTABLE` 设为本机 VS Code 可执行文件路径，将 `VSCODE_COPILOT_EXTENSION` 设为官方 Copilot 扩展目录，然后执行 `npm run test:host`。

## 许可证

[MIT](LICENSE)。
