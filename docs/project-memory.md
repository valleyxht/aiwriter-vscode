# AI Writer 项目记忆

> 最后核对：2026-08-09。本文记录后续开发需要长期保留的项目事实与约束；若代码与本文冲突，以代码和测试为准，并同步更新本文。

## 产品定位

- AI Writer 是面向中文小说创作的 VS Code 扩展，目标是让 AI 在编辑器内完成资料检索、创作、审校、文件交付和可撤销修改。
- 当前项目已经包含 AI 业务逻辑。`AGENTS.md`、`CLAUDE.md` 中“只提供载体、不包含 AI 业务逻辑”的描述已过时。
- 侧边栏是主要交互界面；用户也可从编辑器或资源管理器收集选区、整篇文件或指定文件作为对话上下文。

## 当前功能基线

- 会话：新建、切换、重命名、删除、消息历史、按对话轮次撤回；会话存于 VS Code `globalState`。
- 上下文收集：选区、整个文件、资源管理器文件；按工作区隔离并受 `aiwriter.maxSelections` 限制。
- AI 配置：OpenAI 兼容端点、模型、温度、上下文窗口自动/手动解析；API Key 等秘密存于 `SecretStorage`，发给 Webview 时只显示掩码。
- 请求运行时：流式/非流式模型调用、工具循环、取消、重试分类、调用次数与 Token 预算、空响应恢复、兼容文本形式的工具调用。
- 宏观编排：规划器把请求拆为共享 Agent 指令和特化 Worker 任务；当前正式注册的宏 Worker 只有 `writing_preparation`，旧 ID `writer` 仅在边界兼容。
- 写作准备：冰山提示词解析、已有上下文与最近对话组装、只读文件/RAG/Web 检索、独立上下文预算，然后交给共享 Agent 写正文。
- 正文交付：共享 Agent 通过 `submitNovelDraft` 一次提交完整正文；宿主验证交付元数据后，在内存虚拟文件系统中自动切块、计算 SHA-256，并以单次原子操作建立已完成的唯一 `main` 草稿。相同提交可幂等重试，不同的第二次提交会拒绝覆盖；成功后 Graph 直接进入 Editor，不再调用模型生成确认语。纯聊天正文进入隐藏审校，文件正文在真实写入前审校；路由失败时采取保守回退。
- Editor 模型策略：始终复用主模型和主凭据，不再借用解析模型。默认先保留主模型的原生思考模式；若端点明确报告思考模式不支持强制工具调用，则对同一模型自动重试非思考结构化审校，并按端点与模型缓存兼容策略。兼容端点使用 `enable_thinking=false`，OpenAI 推理模型使用 `reasoning_effort=none`；审校输出校验失败时仍必须累计已经产生的模型用量。
- 文件工具：工作区边界检查、符号链接逃逸防护、读/列举/搜索，以及经审批的创建和原子批量修改。修改使用 `expectedSha256` 防止审批期间文件被并发改写。
- 文件治理：每个请求建立写前事务日志，首次写入前的内容按哈希存入本地 blob；撤回对话时先全量预检，检测到用户后续修改便拒绝覆盖。
- RAG：索引工作区 `.md`/`.txt`，章节感知切块、向量检索 + BM25 + RRF、查询转换/HyDE、增量保存/删除/重命名更新、索引状态与质量报告；索引位于工作区 `.aiwriter/vector-index`。
- RAG 评测：内置 NovelQA 与 CLongEval 导入、抽样、HitRate/MRR/Recall 评测，报告写入工作区 `.aiwriter/evaluations`。
- Web 搜索：可选 Tavily 工具，默认关闭；限制查询、结果数、超时和域名，并把外部内容标记为不可信资料。
- 可观测性：可选 LangSmith；每请求本地 JSONL 日志记录阶段、用量和文件操作遥测，不持久化小说正文；文件历史 blob 位于扩展 `globalStorageUri`。
- Webview：会话、收集内容、Markdown 对话、流式进度、取消、Token/价格、文件审批、RAG 状态及 AI/工作流设置。

## 关键架构与数据流

1. `src/extension.ts` 创建存储、会话、选区、Diff、审批、协议和 `AIManager`。
2. `src/core/ui.ts` 注册 VS Code 命令、RAG 文件监听和 Webview controllers。
3. `ChatController` 为每次用户消息分配 `requestId`，记录会话状态并调用 `AIManager.sendMessageStream()`。
4. `AIManager` 初始化配置、模型、工具、事务、RAG、写作工作流和编排器。
5. `TaskOrchestrator` 规划宏任务；`writing_preparation` 只准备写作上下文，不直接拥有通用写工具。
6. `AIEngine` / LangGraph 执行共享 Agent 和工具循环；写作请求使用草稿暂存与后置编辑管线。
7. 所有真实文件写入必须经过审批、哈希复检和事务记录；会话撤回再由事务管理器恢复文件。

主要目录职责：

- `src/core/`：VS Code 会话、选区、存储、旧式 inline diff 与命令协调。
- `src/presentation/webview/controllers/`：Webview 消息用例层。
- `src/ai/models/`：配置、模型目录、调用治理、LangSmith。
- `src/ai/orchestration/`：宏任务规划、Worker 注册与调度。
- `src/ai/runtime/`：Agent 图、流处理、Token 预算、响应交付与请求日志。
- `src/ai/tools/`、`src/platform/vscode/`：模型工具定义与受限文件系统实现。
- `src/workers/writing-preparation/`：写作前资料准备；`src/workers/editor/`：隐藏审校。
- `src/features/draft-staging/`：请求级小说草稿虚拟文件系统。
- `src/features/file-approval/`：写入审批生命周期。
- `src/history/`：文件版本 blob 与可回滚事务。
- `src/memory/rag/`：长篇小说检索和评测；`src/memory/token-counter.ts`：Token/价格估算。

## 开发时必须保持的不变量

- 特化 Worker 表示业务能力，不是工具名；文件读写、RAG 和 Web 搜索仍属于共享工具层。
- `writing_preparation` 只能使用只读研究工具，不能绕过草稿暂存、Editor 和真实写入审批。
- 草稿身份、内部切块和完成状态都由宿主管理。模型只能一次调用 `submitNovelDraft` 提交完整正文，不得提供 `partNumber`、`draftId`、`writeMode` 或 `isFinalChunk`；成功后 Graph 必须通过确定性节点结束，不得为了确认语再次调用模型。
- 禁止在模型配置、Webview 消息、日志或测试夹具中泄露真实 API Key；秘密继续使用 `SecretStorage`。
- 所有模型可触发的文件路径必须限制在当前工作区内，并检查路径遍历和符号链接逃逸。
- 写入审批后、落盘前必须再次验证期望哈希；批量修改必须先完整校验再一次写入，不能部分应用。
- 撤回对话不能覆盖用户在 AI 写入后产生的新修改；冲突时文件和对话都保持不变。
- 外部搜索结果只能作为不可信资料，不能作为可执行指令。
- Provider 的 completion limit 当前有意不强制下发；`maxTokens` 仅作本地输出预算提示，修改时先看相关模型策略和测试。
- Webview HTML/CSS/JS 改动后必须复制到输出目录；协议新增消息需同时更新 TypeScript union、controller 和前端处理。
- 改动后至少运行类型检查、lint 和单元测试；文件/RAG/Webview 集成改动还应在扩展开发主机中手动验证。

## 当前开发现场

- Git 分支：`master`；核对时 HEAD 为 `7047275`（`feat: improve context and agent workflow reliability`）。
- 工作区存在一批未提交的大型重构：旧 `workers/writer` 正迁移为 `workers/writing-preparation`，并新增 Editor、草稿暂存、响应交付、写作上下文、请求日志及相应测试。继续开发时不要覆盖或回滚这些改动。
- 2026-08-09 基线验证：`tsc --noEmit` 通过；ESLint 0 error、10 warning；草稿协议重构后独立目录编译的单元测试为 122 passing。
- 标准 `npm run compile` 在本次核对时因 `out/ai/index.js` 被 Windows 进程占用而在 `clean-out.js` 删除阶段报 `EPERM`。源码可编译；正常编译前应停止占用 `out` 的扩展开发主机/监视进程，或先用独立输出目录验证。
- PowerShell 执行策略会阻止 `npm.ps1`，本机命令应使用 `npm.cmd` / `npx.cmd`。
- ESLint 剩余 10 条 `curly` warning 位于 `src/ai/models/langsmith.ts` 和 `src/ai/runtime/stream-handler.ts`。
- `README.md` 仍是 VS Code 模板，`AGENTS.md` / `CLAUDE.md` 和旧开发路线图明显落后于代码，不能据此判断当前完成度。

## 尚未完成或需要确认

- 尚未实现真正的对话摘要记忆/结构化人物与世界观长期记忆；现有“记忆”主要是会话历史、Token 裁剪和工作区文档 RAG。
- 宏 Worker 目前只有写作准备，人物设定、大纲、情节检查等仍需设计为新 Worker 或共享 Agent 能力。
- 没有代码执行沙箱；不要假定项目已支持运行 AI 生成的 JavaScript/Python。
- 本次只跑了 Node 单元测试，没有完成 VS Code Extension Host 端到端测试，也没有用真实模型、Embedding、Tavily 或 LangSmith 凭据做联调。
- 旧 `DiffManager` 是即时替换后再接受/拒绝的简单行级实现，与新的“审批 + 原子写入 + 事务回滚”路径并存；继续改文件 UX 前应决定是否迁移或淘汰旧路径。
- 当前 README、用户配置说明、安装指南和发布说明不足，不适合直接发布 1.0.0。

## 建议的下一步顺序

1. 先收口当前未提交重构：停止占用 `out` 的进程，跑标准 `npm.cmd run compile`、`npm.cmd run lint`、`npm.cmd run test:unit`，再做扩展开发主机冒烟测试。
2. 修复 10 条 lint warning，并更新 `README.md`、`AGENTS.md`/`CLAUDE.md`，让文档与真实架构一致。
3. 手动覆盖一条完整主链：普通问答、纯聊天正文、创建正文文件、修改已有正文、拒绝审批、取消请求、撤回多轮文件修改。
4. 再选择一个产品方向继续：优先建议做“结构化小说记忆（人物/设定/事件）”，其次是新增专业 Worker；暂不建议先扩张更多工具。

## 常用验证命令

```powershell
npm.cmd run compile
npm.cmd run lint
npm.cmd run test:unit
```

当 `out/` 被占用时，可先做无写入类型检查：

```powershell
npx.cmd tsc -p ./ --noEmit
```
