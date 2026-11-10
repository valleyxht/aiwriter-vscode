# 本地 RAG + 云端 LangSmith

## 本机 Ollama

1. 安装 [Ollama for Windows](https://ollama.com/download/windows)，启动 Ollama。
2. 在终端运行 `ollama pull qwen3-embedding:0.6b` 下载模型。
3. 插件设置中启用「故事检索」，Embedding 服务选择「本地 Ollama」。
4. 本地地址保留 `http://127.0.0.1:11434`，本地模型填 `qwen3-embedding:0.6b`，保存设置，再到顶部「创作工具」点「选择文件并构建索引」。勾选需要检索的文件后确认；取消勾选会移除旧索引，不改动原文。不需要 Embedding API Key。
5. 等索引就绪，再询问小说已有情节、人物关系，检查是否引用了相关内容。

本地模式使用 `/api/embed`，每批一段，禁止静默截断，拒绝远程地址和 HTTP 重定向。Embedding 和向量索引在本机处理，不继承主模型的地址或密钥。索引位于工作区 `.aiwriter/vector-index`，含原文，应排除 Git 同步。切换服务、模型或地址后重建索引。

本地模式关闭模型查询改写和 HyDE，避免检索前把查询发给云端。检索后的片段仍会进入你配置的写作模型，也会被完整 LangSmith 追踪记录；本地 RAG 不等于整个写作链路离线。

Ollama 未启动、模型未下载或输入超过模型上限会报错，不自动切换云端 Embedding。已有检索层可能降级为关键词检索；请同时查看索引状态和请求中的降级原因。远程 VS Code / WSL 中的「本机」指扩展运行所在的环境。

## 云端 LangSmith

在插件设置填写 LangSmith API Key、Project 和账户对应的 Endpoint，启用 LangSmith 和 Tracing，然后保存。US Endpoint 为 `https://api.smith.langchain.com`，EU 为 `https://eu.api.smith.langchain.com`；多工作区密钥按账户要求填写 Workspace ID。密钥通过插件现有 SecretStorage 保存，不写入项目配置。

发送一次写作请求后，在对应项目寻找 `aiwriter.request`。父记录用 `requestId` 关联请求，内部 LangChain 调用记录提示词、模型完整输出、工具调用和服务端返回的用量。这里明确保留内容，不启用输入输出隐藏。API Key 不属于追踪输入。

本地 Ollama 原生 Embedding 目前不单独创建 LangSmith 子记录；请求统计可记录其尝试次数，但不把缺失的 Token 数估算成实际账单。模型用量是否齐全仍取决于供应商响应。追踪只能帮助观察；检索质量需另外运行已有 RAG 评测。

完成安装及账户设置后的联调：构建索引 → 查询已知剧情 → 写作并审校 → 检查同一父记录下的模型输入输出 → 关闭 Ollama 再查询，确认无云端 Embedding 回退。

索引范围按工作区保存在 `.aiwriter/rag-scope.json`。再次打开文件选择器时恢复勾选；之后保存未选中文件也不会自动加入索引。新增文件需要再次勾选。取消选择器不会修改范围；确认空选择会清空索引。
