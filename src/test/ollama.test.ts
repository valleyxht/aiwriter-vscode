import * as assert from 'assert';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { OllamaEmbeddings, ollamaEndpoint } from '../memory/rag/ollama';

suite('Local Ollama embeddings', () => {
  test('rejects remote hosts, credentials and paths', () => {
    for (const url of ['https://example.com', 'http://192.168.1.1:11434', 'http://user:pass@localhost', 'http://localhost/proxy']) {
      assert.throws(() => ollamaEndpoint(url));
    }
    assert.strictEqual(ollamaEndpoint('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/api/embed');
    assert.throws(() => new OllamaEmbeddings(undefined, 'model:cloud'));
  });

  test('sends text only to local native endpoint, validates vectors and never redirects', async () => {
    const requests: any[] = [];
    let mode = 'ok';
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const part of req) { body += part; }
      requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      if (mode === 'redirect') { res.writeHead(302, { Location: 'https://example.com' }); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ embeddings: mode === 'ok' ? [[1, 0], [0, 1]] : [[1]] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new OllamaEmbeddings(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'qwen3-embedding:0.6b');
      assert.deepStrictEqual(await client.embedDocuments(['人物', '伏笔']), [[1, 0], [0, 1]]);
      assert.strictEqual(requests[0].auth, undefined);
      assert.strictEqual(requests[0].path, '/api/embed');
      assert.strictEqual(requests[0].body.truncate, false);
      mode = 'invalid';
      await assert.rejects(client.embedDocuments(['a', 'b']), /无效/);
      mode = 'redirect';
      await assert.rejects(client.embedQuery('a'));
      assert.strictEqual(requests.length, 3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
