/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * memory/rag/query-transform.ts - 查询改写与 HyDE
 *
 * 【RAG 技术点：Query Transformation + HyDE】—— RAG 效果的最大杠杆
 *
 * 问题：用户说"帮我把这段改得更紧张"，直接拿这句话去做 embedding 检索几乎无用——
 *       它不含任何可匹配原文的语义特征（角色、场景、意象）。
 *
 * 两种改写策略：
 * 1. Query Transformation：用小模型从"选段 + 意图"中抽取角色/场景/情绪等关键要素，
 *    生成 2-3 条真正可检索的查询。
 * 2. HyDE（Hypothetical Document Embeddings，假设性文档嵌入）：
 *    让小模型先"假想"一段符合意图的答案文本，用这段假想文本去检索。
 *    原理：假想的续写片段与库中真实片段在向量空间中更接近（都是"小说正文"形态），
 *    比一句指令更容易命中。对"找相似写法/风格"尤其有效。
 *
 * 复用 workflow.ts 里的 parserModel（小模型），失败时优雅降级为使用原始文本。
 */
import { SystemMessage, HumanMessage } from '../../ai/messages';
import { ParserModelConfig } from '../../types';
import { TransformedQuery } from './types';
import {
  createChatModel,
  createModelRunConfig,
  executeChatModelCall,
  MODEL_POLICY,
} from '../../ai/models/model-policy';

const QUERY_EXTRACT_PROMPT = `你是小说检索查询生成器。根据用户提供的【选段】和【意图】，抽取用于在小说全文中检索相关片段的关键要素。

请严格输出 JSON，不要多余内容：
{
  "queries": ["查询1", "查询2", "查询3"]
}

要求：
- 每条查询是一个短语或短句，聚焦一个要素：出场角色、地点场景、关键物件、情绪基调、动作事件
- 生成 2-3 条，覆盖不同角度
- 用中文，贴近小说正文的措辞，不要出现"检索""查询"等元词`;

const HYDE_PROMPT = `你是小说续写模拟器。根据用户的【选段】和【意图】，写一小段（100-200字）符合该意图的假想小说正文片段。

要求：
- 直接输出正文，不要任何解释、标题或引号
- 风格贴近中文网络小说
- 这段文字用于在小说库中检索风格/情节相似的真实片段，因此要尽量"像正文"`;

export class QueryTransformer {
  private _model: ReturnType<typeof createChatModel> | null = null;

  constructor(config: ParserModelConfig) {
    if (!config.apiKey || !config.enabled) {
      return;
    }
    try {
      this._model = createChatModel({
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        temperature: 0.3,
        streaming: false,
        timeoutMs: MODEL_POLICY.parserTimeoutMs,
      });
    } catch (error) {
      console.error('[QueryTransformer] 初始化失败:', error);
      this._model = null;
    }
  }

  /**
   * 综合改写：生成检索查询 + 可选 HyDE 文档。
   * @param selection 用户选中/待润色的原文
   * @param intent 用户意图（如"改得更紧张"），可为空
   * @param useHyde 是否生成 HyDE 假想文档
   */
  async transform(
    selection: string,
    intent: string,
    useHyde: boolean,
    signal?: AbortSignal
  ): Promise<TransformedQuery> {
    // 没有小模型时降级：直接用选段本身作为唯一查询
    if (!this._model) {
      return { queries: [selection.slice(0, 200)] };
    }

    const [queries, hydeDocument] = await Promise.all([
      this._extractQueries(selection, intent, signal),
      useHyde ? this._generateHyde(selection, intent, signal) : Promise.resolve(undefined),
    ]);

    return { queries, hydeDocument };
  }

  private async _extractQueries(selection: string, intent: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const userContent = `【选段】\n${selection}\n\n【意图】\n${intent || '（未指定，找语义/情节相关的片段）'}`;
      const resp = await executeChatModelCall(
        () => this._model!.invoke(
          [new SystemMessage(QUERY_EXTRACT_PROMPT), new HumanMessage(userContent)],
          createModelRunConfig('rag.query_transform', undefined, signal)
        ),
        { operation: 'rag.query_transform', signal }
      );
      const content = resp.content as string;
      const parsed = this._safeParseQueries(content);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      console.warn('[QueryTransformer] 查询抽取失败，降级为原文:', error);
    }
    return [selection.slice(0, 200)];
  }

  private async _generateHyde(selection: string, intent: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const userContent = `【选段】\n${selection}\n\n【意图】\n${intent || '延续该片段的风格与情节'}`;
      const resp = await executeChatModelCall(
        () => this._model!.invoke(
          [new SystemMessage(HYDE_PROMPT), new HumanMessage(userContent)],
          createModelRunConfig('rag.hyde', undefined, signal)
        ),
        { operation: 'rag.hyde', signal }
      );
      const doc = (resp.content as string).trim();
      return doc || undefined;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      console.warn('[QueryTransformer] HyDE 生成失败:', error);
      return undefined;
    }
  }

  private _safeParseQueries(content: string): string[] {
    // 尝试完整 JSON
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.queries)) {
        return parsed.queries.filter((q: any) => typeof q === 'string' && q.trim()).map((q: string) => q.trim());
      }
    } catch {
      // 尝试从数组片段提取
      const match = content.match(/"queries"\s*:\s*\[([\s\S]*?)\]/);
      if (match) {
        const items = match[1].match(/"([^"]+)"/g);
        if (items) {
          return items.map((s) => s.replace(/^"|"$/g, '').trim()).filter(Boolean);
        }
      }
    }
    return [];
  }
}
