# BYOK Studio

[English](README.md) | 简体中文

用于编辑 `chatLanguageModels.json` 中 Copilot **Custom Endpoint** 配置的可视化管理器。

![配置页面](docs/images/configuration-zh-CN.png)

## 配置内容

- 供应商名称、端点地址和 API Key。
- **Chat Completions**、**Responses** 或 **Messages** 协议配置，可统一设置或按模型分配。
- 模型列表、显示名称、Context、Output、能力声明和推理档位。

模型预设在线同步自 [models.dev](https://models.dev) 并在本地缓存。在 **模型设置** 中调整参数。[参数来源与匹配规则](docs/SOURCES.md)。

Context 和 Output 直接写入官方 JSON 的 `contextWindow` 和 `maxOutputTokens`。保存供应商时会清除该供应商旧模型中的 `maxInputTokens`、`zeroDataRetentionEnabled` 和 `statefulResponses`；未操作的供应商保持不变。

## 使用

需要 **VS Code 1.145+** 和 **GitHub Copilot Chat**。

1. 在命令面板执行 **BYOK Studio: 管理模型**。
2. 添加供应商，填写地址、API Key，并选择 **统一协议** 或 **区分协议**。
3. 刷新或手动添加模型，调整设置。
4. 点击 **保存供应商** 写入原生配置并刷新 Copilot Chat 的模型列表，然后选择对应的 **Custom Endpoint** 模型。

扩展按命令激活，直接读取 `chatLanguageModels.json` 中的 `customendpoint` 分组。启动 VS Code、打开面板或读取配置均不写入数据。只有显式保存、导入或删除供应商时才修改对应供应商的官方配置。

**统一协议** 模式下所有模型使用同一个协议和地址。**区分协议** 模式下没有供应商默认协议：GPT / OpenAI 系列（含 Codex）归入 **Responses**，Claude 归入 **Messages**，其余模型归入 **Chat Completions**。可在模型设置的 **请求协议** 中单独修改，或勾选模型后批量移动到其他协议列。切换模式会保留已有的手动分配。

**刷新** 会替换模型列表，并将协议分配重置为上述模型系列规则。同 ID 模型保留名称、Token 覆盖和推理设置；端点地址及 API Key 保持不变，模型按发现顺序排列。刷新失败不会改变草稿。

勾选模型后，**刷新** 左侧显示 **删除**。取消全部勾选后隐藏；可使用统一列表或协议列的 **全选**。模型删除只修改草稿，保存供应商后生效。保存完成后显示绿色提示，失败时显示错误。

点击 **导出**，选择供应商（默认全选），复制到剪贴板或保存为 JSON 文件，始终包含已保存的 API Key。点击 **导入**，从剪贴板或 JSON 文件读取并选择供应商后保存；同 ID 或同名供应商会更新覆盖。两个弹窗均可通过右上角关闭按钮或 Esc 退出。跨设备迁移通过手动导入、导出完成。

命令 **BYOK Studio: 打开官方模型配置** 可查看写入的 JSON。每个供应商对应一个 `customendpoint` 分组。官方配置使用受保护的密钥引用；导出的迁移 JSON 包含明文 API Key。

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

## 开发

运行 `node scripts/preview-ui.cjs` 可预览界面，数据仅保存在内存。

- `src/` — 扩展与配置逻辑
- `resources/` — 页面与共享模块
- `scripts/` — 本地界面预览工具
- `docs/` — 截图与参数来源

```powershell
npm ci
npm run build
npm run package
```

## 许可证

[MIT](LICENSE)。
