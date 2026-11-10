# AI Writer — 小说创作助手

面向中文小说创作的 VS Code 扩展，在编辑器中提供资料检索、AI 写作、审校和文件交付。

## 当前能力

- 侧边栏对话、会话历史、从已完成回答新建分支、选区和文件上下文收集。
- OpenAI 兼容模型配置，通过本地 Vercel AI SDK 适配直连供应商，支持流式响应、取消、工具调用与 Token 预算。
- 基于 Vercel AI SDK 的 Agent 工具循环；主 Agent 按需委托资料检索、场景拆解和写作审核。
- 章节感知 RAG：向量检索、中文 BM25、RRF 融合、查询转换和增量索引。
- 文件审批、期望哈希检查与事务撤回；遗留 Diff 路径仍需迁移。
- 项目说明与写作偏好记忆，以及 NovelQA / CLongEval 检索评测入口。

## 开发与运行

需要 Node.js、npm 和 VS Code（最低版本见 package.json）。首次运行安装依赖，然后编译：

```powershell
npm install
npm run compile
npm run lint
npm run test:unit
```

按 F5 启动扩展开发主机，在新窗口打开小说测试工作区，点击 AI Writer 侧边栏，在设置界面配置模型服务。API Key 保存在 VS Code SecretStorage，不应写入仓库。RAG 需要单独配置 Embedding，Web 搜索为可选功能。

模型配置仍只需 API Key、API 地址和模型名。常见 OpenAI、DeepSeek、Moonshot/Kimi 和 DashScope 官方地址使用 SDK 专用适配包，其他地址使用通用 OpenAI 兼容适配；请求直接发送到配置的地址，不经过 AI Gateway。新供应商只要符合 OpenAI 兼容协议即可接入，特殊协议能力仍取决于相应适配包支持。SDK 只负责模型通信，文件审批、工具执行与并发额度仍由插件管理。Embedding 保留独立配置，OpenAI 兼容向量化使用本地 AI SDK，Ollama 继续直连本机接口。

必要的推理协议字段保存在本地会话上下文中，用于同一地址、同一模型的后续请求，不进入聊天界面。切换地址或模型后不复用这些字段。历史会话缺少此类字段时仍按原有文本历史加载。

`npm test` 启动 VS Code 测试主机，首次可能下载测试版本。`npm run watch` 只监听 TypeScript；修改 Webview 后请重新执行 compile 并重新加载开发主机。

## 开源许可

本项目采用 [MIT 许可证](LICENSE)。
