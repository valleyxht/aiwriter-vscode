/** Local-only Ollama transport. Never inherits the writing model's credentials. */
export function ollamaEndpoint(baseUrl = 'http://127.0.0.1:11434'): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash
    || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('Ollama 地址必须是本机 HTTP 地址，例如 http://127.0.0.1:11434');
  }
  url.pathname = '/api/embed';
  return url.toString();
}

export class OllamaEmbeddings {
  private readonly endpoint: string;
  constructor(baseUrl: string | undefined, private readonly model: string) {
    this.endpoint = ollamaEndpoint(baseUrl);
    if (!model.trim() || /cloud/i.test(model)) {
      throw new Error('请选择已下载的本地 Ollama Embedding 模型');
    }
  }

  async embedDocuments(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { controller.abort(); }
    const timer = setTimeout(cancel, 120000);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input, truncate: false }),
      });
      if (!response.ok) {
        throw new Error(`Ollama Embedding 失败（HTTP ${response.status}），请检查服务和已下载模型；未切换云端。`);
      }
      const data = await response.json() as { embeddings?: number[][] };
      const vectors = data.embeddings;
      const dimension = vectors?.[0]?.length;
      if (!Array.isArray(vectors) || vectors.length !== input.length || !dimension
        || vectors.some(v => !Array.isArray(v) || v.length !== dimension || v.some(n => typeof n !== 'number' || !Number.isFinite(n)))) {
        throw new Error('Ollama 返回了无效的向量');
      }
      return vectors;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async embedQuery(input: string, signal?: AbortSignal): Promise<number[]> {
    return (await this.embedDocuments([input], signal))[0];
  }
}
