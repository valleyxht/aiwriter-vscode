import * as assert from 'assert';
import { AIMessageChunk } from '../ai/messages';
import { extractVisibleText } from '../ai/runtime/agent-messages';

suite('Application message records', () => {
    test('keeps interleaved tool argument streams isolated by index', () => {
        const first = new AIMessageChunk({ content: '', tool_call_chunks: [
            { index: 0, id: 'a', name: 'readFile', args: '{"filepath":' },
            { index: 1, id: 'b', name: 'readFile', args: '{"filepath":"b' },
        ] });
        const combined = first.concat(new AIMessageChunk({ content: '', tool_call_chunks: [
            { index: 1, args: '.md"}' }, { index: 0, args: '"a.md"}' },
        ] }));
        assert.deepStrictEqual(combined.tool_calls.map(call => [call.id, call.args.filepath]), [['a', 'a.md'], ['b', 'b.md']]);
        assert.strictEqual(first.tool_calls.length, 0);
        assert.strictEqual(first.tool_call_chunks[0].args, '{"filepath":');
    });
    test('never repairs malformed JSON into an executable tool call', () => {
        const message = new AIMessageChunk({ content: '', tool_call_chunks: [
            { index: 0, id: 'a', name: 'modifyFile', args: '{"filepath":"a.md",' },
        ] });
        assert.deepStrictEqual(message.tool_calls, []);
        assert.deepStrictEqual(message.concat(new AIMessageChunk('')).tool_calls, []);
    });
    test('preserves mixed content and protocol metadata without exposing reasoning', () => {
        const first = new AIMessageChunk({ content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '正文' }] });
        const combined = first.concat(new AIMessageChunk({ content: '继续', response_metadata: { finish_reason: 'stop' },
            additional_kwargs: { ai_sdk_content: [{ type: 'reasoning', text: 'hidden' }] } }));
        assert.strictEqual(extractVisibleText(combined.content), '正文继续');
        assert.strictEqual(combined.response_metadata.finish_reason, 'stop');
        assert.strictEqual(combined.additional_kwargs.ai_sdk_content[0].text, 'hidden');
    });
});
