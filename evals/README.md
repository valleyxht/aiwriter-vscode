# AI Writer Agent 评测

在仓库根目录运行 `npm run eval:agent`。需要 Node.js 22.22.0 或更新的兼容版本。首次运行会通过 npm 下载固定版本的 Promptfoo，评测用脚本模型响应，无需 API Key。

三条用例覆盖跨章读证据、批准局部修改、拒绝修改后保持原文。调用真实 Agent 循环和读写工具，文件和审批由合成环境提供。脚本结果用于验证链路和断言，不能当作模型质量或性能基线。

真实模型评测先通过环境变量设置 `AIWRITER_EVAL_MODEL`、`AIWRITER_EVAL_BASE_URL` 和 `AIWRITER_EVAL_API_KEY`，再运行 `npm run eval:agent -- --live`。仍使用合成文件和自动审批，模型走插件原有的直连接口，可能产生 API 费用。此入口只启用 `readFile` 和 `modifyFile`，不加载 RAG、专业 Agent 或 VS Code 界面。

本地报告在 `.aiwriter/evaluations/agent-smoke.json` 或 `.aiwriter/evaluations/agent-live.json`，包含工具结果、首次正文、最终回答起始、总耗时和模型轮次。供应商未提供完整实际用量时 Token 字段为 `null`。脚本模式的耗时只供调试。对比前后版本时先另存报告，因为同一模式会覆盖上次报告。
