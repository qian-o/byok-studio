# BYOK Studio

[English](README.md) | 简体中文

把自己的 API Key 和模型端点接入 GitHub Copilot Chat。BYOK Studio 是 VS Code 官方 **Custom Endpoint** 配置的可视化管理器。聊天请求由官方 Copilot 处理，扩展不提供独立的聊天运行时。

## 功能

- 在一个界面中管理供应商、API Key、端点地址及可编辑的模型能力参数。
- 支持 **Chat Completions**、**Responses** 和 **Messages**，可统一协议，也可按模型区分协议。
- 发现模型、手动添加或编辑模型，并在协议栏之间移动选中的模型。
- 界面自动跟随 VS Code 显示语言：`zh` 语言使用中文，其余使用英文。原始模型 ID、自定义名称和 URL 保持原样。

## 快速开始

需要 **VS Code 1.145 或更新版本**、已启用的官方 **GitHub Copilot Chat** 扩展，以及供应商的 API Key 和端点地址。

1. 从 [Releases](https://github.com/qian-o/byok-studio/releases/latest) 下载 `.vsix` 安装包。在命令面板中执行 **扩展: 从 VSIX 安装…**，选择安装包，然后执行 **开发人员: 重新加载窗口**。
2. 执行 **BYOK Studio: 管理模型**，添加供应商。
3. 填写供应商名称和 API Key，选择统一协议或区分协议，再填写相应地址。区分协议时共用供应商的 Key。
4. 发现模型，或手动添加、编辑模型。**发现会替换当前模型列表。** 区分协议时，勾选模型并移到目标协议栏。
5. 保存供应商以应用配置。即使没有改动也可以保存；编辑已有供应商时，Key 留空会保留已存储的密钥。
6. 打开 Copilot Chat，在模型选择器中选择该供应商的 **Custom Endpoint** 模型。

## 参数预设与上下文

内置预设覆盖 **182 个精确模型 ID**，提供可编辑的参数参考。存在预设不代表模型一定可用，也不保证所有端点都支持其能力。证据和已知缺口见[参数来源](data/SOURCES.md)。

每个模型使用配置的最高上下文额度，只有一个预算；输入与输出共用窗口时会预留输出空间。目前尚无原生上下文大小选择器。输入处理、压缩和用量显示由官方 Copilot 负责；价格信息仅供参考，实际费用以供应商规则为准。

## 隐私与兼容性

- API Key 使用 VS Code 加密密钥存储，导出的预设不包含 Key。配置更新和删除仅影响 BYOK Studio 管理的条目。
- 聊天网络请求由官方 Copilot 处理。模型和端点的支持情况取决于供应商及 Copilot 的协议适配器。推理档位只提供官方配置能准确表达的选项。
- 零数据保留（ZDR）设置无法强制改变供应商的数据保留政策。
- 不支持引用外部 JSON 文件或填写任意请求体 JSON。

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
