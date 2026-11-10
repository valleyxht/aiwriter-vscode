const { randomUUID } = require('node:crypto');
require('../out/test/node-vscode-stub');

const { AIMessageChunk, HumanMessage } = require('../out/ai/messages');
const { createWritingAssistantAgent, getVisibleMessageText } = require('../out/ai/runtime/agent');
const { RequestTelemetry } = require('../out/ai/runtime/request-telemetry');
const { ResponseDelivery } = require('../out/ai/runtime/response-delivery');
const { createFileTools } = require('../out/ai/tools/tools');
const { TokenCounter } = require('../out/memory/token-counter');
const { DEFAULT_AI_CONFIG } = require('../out/types');

// The fixture filesystem exposes only these files and never accesses the host disk.
const chapter = '第三章.md';
const fixtures = {
    '第一章.md': '夜里，守门人把铜钥匙藏进蓝瓷罐。\n',
    '第二章.md': '能打开北门的铁钥匙留在旧钟楼。\n',
    [chapter]: '她走到窗前。\n桌上放着一盏油灯。\n',
};

function scriptedModel(turns) {
    let turn = 0;
    const model = {
        bind: () => model,
        async *stream() {
            const step = turns[turn++];
            if (!step) { throw new Error('脚本模型收到未预期的额外调用'); }
            if (step.text) { yield new AIMessageChunk(step.text); }
            if (step.tools) {
                yield new AIMessageChunk({ content: '', tool_call_chunks: step.tools.map(([name, args], index) => ({
                    id: `eval-${turn}-${index}`, name, args: JSON.stringify(args), index,
                })) });
            }
        },
    };
    return () => model;
}

function modelConfig(live) {
    if (!live) { return { model: 'aiwriter-fixture', apiKey: 'fixture', baseUrl: 'http://localhost' }; }
    const model = process.env.AIWRITER_EVAL_MODEL?.trim();
    const baseUrl = process.env.AIWRITER_EVAL_BASE_URL?.trim();
    const apiKey = process.env.AIWRITER_EVAL_API_KEY;
    if (!model || !baseUrl || !apiKey || !/^https?:\/\//i.test(baseUrl)) {
        throw new Error('真实评测需要配置 AIWRITER_EVAL_MODEL、AIWRITER_EVAL_BASE_URL 和 AIWRITER_EVAL_API_KEY');
    }
    return { model, baseUrl, apiKey };
}

module.exports = class AIWriterProvider {
    id() { return process.env.AIWRITER_EVAL_LIVE === '1' ? 'aiwriter:live' : 'aiwriter:scripted'; }

    async callApi(prompt, context) {
        const live = process.env.AIWRITER_EVAL_LIVE === '1';
        const { script, approve } = context.vars;
        const connection = modelConfig(live);
        const config = { ...DEFAULT_AI_CONFIG, ...connection, temperature: 0, webSearch: undefined };
        const files = new Map(Object.entries(fixtures));
        const writes = [];
        let approvals = 0;
        const fileSystem = {
            async readFile(path) {
                return files.has(path) ? { success: true, content: files.get(path) }
                    : { success: false, message: '合成资料中没有该文件' };
            },
            async validatePath(path) {
                return files.has(path) ? { success: true, content: path } : { success: false };
            },
            async editFile(path, content) {
                if (!files.has(path)) { return { success: false }; }
                writes.push(path);
                files.set(path, content);
                return { success: true, content };
            },
        };
        const approver = { confirmFileWrite: async () => { approvals++; return approve === true; } };
        const events = [];
        const logger = { write: async (_root, _id, event) => { events.push(event); } };
        const telemetry = new RequestTelemetry(randomUUID(), undefined, logger);
        const delivery = new ResponseDelivery(() => {});
        const counter = new TokenCounter(config.model, config.contextWindowSize);
        try {
            const tools = createFileTools(fileSystem, approver).filter(tool => ['readFile', 'modifyFile'].includes(tool.name));
            const agent = createWritingAssistantAgent(config, fileSystem, approver,
                { handleLLMNewToken: async text => delivery.push(text) }, undefined, undefined, counter,
                undefined, undefined, live ? undefined : scriptedModel(script), undefined, logger, { tools });
            const state = await telemetry.run(() => agent.invoke({
                messages: [new HumanMessage(prompt)], requestId: telemetry.requestId,
            }, { signal: AbortSignal.timeout(90_000) }));
            await telemetry.complete({ status: 'COMPLETED' });
            const summary = events.find(event => event.event === 'request_summary').data;
            return { output: {
                answer: getVisibleMessageText(state.messages.at(-1)).trim(),
                tools: state.toolResults.map(({ tool, args, result }) => ({
                    name: tool, path: args?.filepath, status: result.status,
                })),
                approvals,
                writes,
                chapter: files.get(chapter),
                metrics: {
                    model: config.model,
                    firstVisibleMs: summary.firstVisibleMs,
                    finalAnswerStartMs: summary.finalAnswerStartMs,
                    elapsedMs: summary.elapsedMs,
                    modelTurns: state.agentTurns,
                    toolCalls: state.toolCallCount,
                    usageComplete: summary.usageComplete,
                    inputTokens: summary.usageComplete ? summary.inputTokens : null,
                    outputTokens: summary.usageComplete ? summary.outputTokens : null,
                    carriedEvidenceTokens: events.filter(event => event.event === 'model_input')
                        .map(event => event.data.carriedEvidenceTokens),
                },
            } };
        } finally {
            counter.dispose();
        }
    }
};
