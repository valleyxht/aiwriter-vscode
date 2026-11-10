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

## 验证与项目说明

- [AI SDK Agent 执行循环重构与验证](docs/agent-runtime-refactor.md)

- [本地 Ollama RAG 与云端 LangSmith 配置](docs/local-rag-langsmith.md)
- [项目记忆与历史开发记录](docs/project-memory.md)
- [NovelQA 评测](docs/novelqa-rag-evaluation.md)
- [CLongEval 评测](docs/clongeval-rag-evaluation.md)
- [Promptfoo Agent 评测](evals/README.md)

当前未实现执行中断点续跑、独立模型 reranker 或完整的人物/事件状态库。自动化测试不替代真实模型与界面联调，不据此宣称生成质量或线上规模。


### 章节摘要

在顶部「创作工具」点击「生成 / 更新摘要」：默认选择「补齐缺失摘要」，已有摘要不覆盖；需要改写时选择「选择章节生成 / 更新」，勾选要覆盖的章节。取消可使用生成进度通知中的取消按钮。

摘要是普通 Markdown 文件，例如 `.aiwriter/research/summaries/正文合集.md/第二章 雨夜.md`。正文可以直接手动编辑；文件头保存来源文件、章节及生成时的正文指纹，供 Agent 区分已核对版本与未核对摘要。没有文件头的手写摘要放在对应的可读路径下也会被识别，但不会被标为已核对。删除、修改或补写摘要并保存后会自动同步，不会自动调用模型。

`catalog.json` 只作为可重建的章节导航索引，不保存生成失败、待更新等任务状态。正文变化不会自动覆盖摘要；Agent 按需读取摘要时核对来源版本，需要细节和引文时仍读取原文。旧 UUID 文件名会在扫描时迁移为可读文件名，原文件备份在 `.aiwriter/research/legacy-summaries/`；未关联的手写文件不会自动删除。

调试控制台可搜索 `[ResearchSummary]` 查看逐章生成、耗时、结束原因、输出长度和 Token 用量；日志不包含正文和 API Key。


### 响应观测与资料复用

请求日志新增 `first_visible_output`（后端首次向侧边栏发送非空正文）和 `final_answer_start`（最终回答轮次首次输出正文），最终 `request_summary` 同时记录 `firstVisibleMs`、`finalAnswerStartMs`。它们都从请求接收时开始计时；最终回答事件在该轮确认不含工具调用后补记实际开始时间。它们不代表前端已经完成渲染，也不把隐藏推理当作可见响应。

每个请求保留一份原文证据缓存，各 Agent 单独维护自己实际可见的片段。委派专业 Agent 时自动携带已有证据，优先匹配已知来源，再选近期片段；交接前校验当前正文版本，默认最多约 4,000 Token，小窗口会进一步收缩。未实际传入的资料不计为已读，变更版本仍可补查。

每轮原文携带预算默认约 12,000 Token，且不超过模型窗口的四分之一；最新一次读取完整保留，必要时可临时超过该资料预算并记入日志。较早、重复或重叠的片段替换为可重新读取的定位信息，原文仍在请求缓存中。用户原始要求、附件、助手推理、工具调用参数和写入回执不作这种裁剪。该预算不限制整个任务能够读取的总资料量，也不增加模型压缩调用。

`model_input` 记录各 Agent 每轮估算输入量、实际携带的原文证据量及省略数量，`evidence_handoff` 记录专业 Agent 的证据交接数量；服务商实际用量仍以 `request_summary` 为准。效果需用相同任务、模型和资料继续对照测试。

## 开源许可

本项目采用 [MIT 许可证](LICENSE)。
