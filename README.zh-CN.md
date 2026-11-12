# BYOK Studio

[English](README.md) | 简体中文

用于编辑 `chatLanguageModels.json` 中 Copilot **Custom Endpoint** 配置的可视化管理器。

![配置页面](docs/images/configuration-zh-CN.png)

## 配置内容

- 供应商名称、端点地址和 API Key。
- **Chat Completions**、**Responses** 或 **Messages** 协议配置，可统一设置或按模型分配。
- 模型列表、显示名称、Token 限制、能力声明和默认推理档位。

模型预设来自 [models.dev](https://models.dev)。点击页面顶部的 **更新预设库**，在具体模型的 **高级选项** 中调整参数；更新会保留模型的手动覆盖。[参数来源](docs/SOURCES.md)。

BYOK Studio 不再生成或管理 `zeroDataRetentionEnabled` 和 `statefulResponses`。官方 JSON 中保留模型的已有字段值会原样保留；新模型使用 Copilot 默认行为，也可自行编辑 JSON。

## 使用

需要 **VS Code 1.145+** 和 **GitHub Copilot Chat**。

1. 在命令面板执行 **BYOK Studio: 管理模型**。
2. 添加供应商，填写地址、API Key，并选择 **统一协议** 或 **区分协议**。
3. 刷新或手动添加模型，调整设置。
4. 点击 **保存供应商** 写入原生配置并刷新 Copilot Chat 的模型列表，然后选择对应的 **Custom Endpoint** 模型。

**统一协议** 模式下所有模型使用同一个协议和地址。**区分协议** 模式下没有供应商默认协议：GPT / OpenAI 系列（含 Codex）归入 **Responses**，Claude 归入 **Messages**，其余模型归入 **Chat Completions**。可在模型设置的 **请求协议** 中单独修改，或勾选模型后批量移动到其他协议列。切换模式会保留已有的手动分配。

**刷新** 会替换模型列表，并将协议分配重置为上述模型系列规则。同 ID 模型保留名称、Token 覆盖和推理设置；端点地址及 API Key 保持不变，模型按发现顺序排列。刷新失败不会改变草稿。

两种模式都可勾选模型并点击 **删除所选**，确认数量后批量删除。可 **全选** 统一列表或某一协议列，也可清除选择。删除只修改当前草稿，保存供应商后才生效。原生配置写入和 Chat 模型列表刷新均完成后显示绿色提示，失败时仍显示错误。

点击 **导出**，选择供应商（默认全选），复制到剪贴板或保存为 JSON 文件，始终包含已保存的 API Key。点击 **导入**，从剪贴板或 JSON 文件读取并选择供应商后保存；同 ID 或同名供应商会更新覆盖。两个弹窗均可通过右上角关闭按钮或 Esc 退出。跨设备迁移通过手动导入、导出完成。

保存完成后显示 **供应商已保存。**，导入完成后显示 **已导入 N 个供应商。**。命令面板中的 **BYOK Studio: 打开官方模型配置** 可查看实际写入的 `chatLanguageModels.json`。每个供应商对应一个 `customendpoint` 分组，每个模型记录自己的请求地址、协议和能力参数。官方 JSON 使用 `${input:chat.lm.secret.…}` 引用受保护的密钥；导出的迁移 JSON 则包含明文 API Key。

<details>
<summary>配置示例</summary>

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

## 开发

浏览器预览使用进程内存保存测试配置，不会写入 VS Code 官方配置；验证 Chat 模型列表联动需要启动扩展开发宿主。

- `src/` — 扩展与配置逻辑
- `resources/` — 页面、共享模块及运行时参数库
- `scripts/` — 开发工具与参数库维护资料
- `test/` — 回归测试
- `docs/` — 截图与参数来源

```powershell
npm ci
npm test
npm run package
```

## 许可证

[MIT](LICENSE)。
