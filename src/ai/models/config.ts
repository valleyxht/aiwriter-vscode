/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * ai/config.ts - AI 配置管理器
 * 功能：管理 AI 相关配置的存储和加载
 * 包含：
 *   - API Key、模型、温度等配置
 *   - 配置持久化存储
 *   - 工作流配置（解析模型等）
*/
import * as vscode from 'vscode';
import { AIConfig, DEFAULT_AI_CONFIG, WorkflowConfig, DEFAULT_PARSER_CONFIG, DEFAULT_WEB_SEARCH_CONFIG } from '../../types';
import { ModelCatalogService, ModelContextResolution } from './model-catalog';

const CONFIG_KEY = 'aiwriter.aiConfig';
const WORKFLOW_CONFIG_KEY = 'aiwriter.workflowConfig';
const AI_API_KEY_SECRET = 'aiwriter.secret.aiApiKey';
const PARSER_API_KEY_SECRET = 'aiwriter.secret.parserApiKey';
const LANGSMITH_API_KEY_SECRET = 'aiwriter.secret.langsmithApiKey';
const RAG_EMBEDDING_API_KEY_SECRET = 'aiwriter.secret.ragEmbeddingApiKey';
const WEB_SEARCH_API_KEY_SECRET = 'aiwriter.secret.webSearchApiKey';
export const SECRET_MASK = '********';

export interface ModelContextResolver {
  resolve(model: string, baseUrl?: string): Promise<ModelContextResolution>;
}

export class AIConfigManager {
  private _config: AIConfig;
  private _workflowConfig: WorkflowConfig;
  private _context: vscode.ExtensionContext;
  private _legacyConfig?: AIConfig;
  private _legacyWorkflowConfig?: WorkflowConfig;
  private readonly _modelCatalog: ModelContextResolver;

  constructor(context: vscode.ExtensionContext, modelCatalog?: ModelContextResolver) {
    this._context = context;
    this._modelCatalog = modelCatalog || new ModelCatalogService(this._context.globalState);
    this._legacyConfig = this._context.globalState.get<AIConfig>(CONFIG_KEY);
    this._legacyWorkflowConfig = this._context.globalState.get<WorkflowConfig>(WORKFLOW_CONFIG_KEY);
    this._config = this.loadConfig(this._legacyConfig);
    this._workflowConfig = this.loadWorkflowConfig(this._legacyWorkflowConfig);
  }

  async initialize(): Promise<void> {
    const [storedApiKey, storedParserKey, storedLangSmithKey, storedRagEmbeddingKey, storedWebSearchKey] = await Promise.all([
      this._context.secrets.get(AI_API_KEY_SECRET),
      this._context.secrets.get(PARSER_API_KEY_SECRET),
      this._context.secrets.get(LANGSMITH_API_KEY_SECRET),
      this._context.secrets.get(RAG_EMBEDDING_API_KEY_SECRET),
      this._context.secrets.get(WEB_SEARCH_API_KEY_SECRET)
    ]);

    const legacyApiKey = this._legacyConfig?.apiKey;
    const legacyParserKey = this._legacyWorkflowConfig?.parserModel?.apiKey;
    const legacyLangSmithKey = this._legacyConfig?.langsmith?.apiKey;
    const legacyRagEmbeddingKey = this._legacyConfig?.rag?.embeddingApiKey;
    const legacyWebSearchKey = this._legacyConfig?.webSearch?.apiKey;

    this._config.apiKey = storedApiKey || legacyApiKey || '';
    this._workflowConfig.parserModel.apiKey = storedParserKey || legacyParserKey || '';
    if (this._config.langsmith) {
      this._config.langsmith.apiKey = storedLangSmithKey || legacyLangSmithKey;
    }
    if (this._config.rag) {
      this._config.rag.embeddingApiKey = storedRagEmbeddingKey || legacyRagEmbeddingKey || '';
    }
    if (this._config.webSearch) {
      this._config.webSearch.apiKey = storedWebSearchKey || legacyWebSearchKey || '';
    }

    await Promise.all([
      this._migrateSecret(AI_API_KEY_SECRET, storedApiKey, legacyApiKey),
      this._migrateSecret(PARSER_API_KEY_SECRET, storedParserKey, legacyParserKey),
      this._migrateSecret(LANGSMITH_API_KEY_SECRET, storedLangSmithKey, legacyLangSmithKey),
      this._migrateSecret(RAG_EMBEDDING_API_KEY_SECRET, storedRagEmbeddingKey, legacyRagEmbeddingKey),
      this._migrateSecret(WEB_SEARCH_API_KEY_SECRET, storedWebSearchKey, legacyWebSearchKey)
    ]);
    await this._resolveContextWindow();
    await this._persistConfig();
    await this._persistWorkflowConfig();
    this._legacyConfig = undefined;
    this._legacyWorkflowConfig = undefined;
  }

  private loadConfig(saved?: AIConfig): AIConfig {
    return {
      ...DEFAULT_AI_CONFIG,
      ...saved,
      apiKey: '',
      contextWindowMode: saved?.contextWindowMode || 'auto',
      contextWindowDetection: saved?.contextWindowDetection || DEFAULT_AI_CONFIG.contextWindowDetection,
      langsmith: {
        ...DEFAULT_AI_CONFIG.langsmith!,
        ...saved?.langsmith,
        apiKey: undefined
      },
      rag: {
        ...DEFAULT_AI_CONFIG.rag!,
        ...saved?.rag,
        embeddingApiKey: ''
      },
      webSearch: {
        ...DEFAULT_WEB_SEARCH_CONFIG,
        ...saved?.webSearch,
        apiKey: ''
      },
    };
  }

  private loadWorkflowConfig(saved?: WorkflowConfig): WorkflowConfig {
    return {
      parserModel: { ...DEFAULT_PARSER_CONFIG, ...saved?.parserModel, apiKey: '' },
      enableIcebergPrompting: true,
      ...saved,
      defaultWritingExecutionPrompt: saved?.defaultWritingExecutionPrompt
        || saved?.defaultWriterSystemPrompt
        || '',
      defaultWriterSystemPrompt: undefined,
      ...(saved?.parserModel ? { parserModel: { ...DEFAULT_PARSER_CONFIG, ...saved.parserModel, apiKey: '' } } : {})
    };
  }

  private async _migrateSecret(key: string, stored: string | undefined, legacy: string | undefined): Promise<void> {
    if (!stored && legacy) {
      await this._context.secrets.store(key, legacy);
    }
  }

  private async _updateSecret(key: string, value: string): Promise<void> {
    if (value) {
      await this._context.secrets.store(key, value);
    } else {
      await this._context.secrets.delete(key);
    }
  }

  private async _persistConfig(): Promise<void> {
    const { apiKey: _apiKey, ...configWithoutApiKey } = this._config;
    const langsmith = configWithoutApiKey.langsmith
      ? (() => {
          const { apiKey: _langsmithKey, ...rest } = configWithoutApiKey.langsmith!;
          return rest;
        })()
      : undefined;
    const rag = configWithoutApiKey.rag
      ? (() => {
          const { embeddingApiKey: _embeddingApiKey, ...rest } = configWithoutApiKey.rag!;
          return rest;
        })()
      : undefined;
    const webSearch = configWithoutApiKey.webSearch
      ? (() => {
          const { apiKey: _webSearchKey, ...rest } = configWithoutApiKey.webSearch!;
          return rest;
        })()
      : undefined;
    await this._context.globalState.update(CONFIG_KEY, { ...configWithoutApiKey, langsmith, rag, webSearch });
  }

  private async _persistWorkflowConfig(): Promise<void> {
    const { apiKey: _parserKey, ...parserModel } = this._workflowConfig.parserModel;
    const { defaultWriterSystemPrompt: _legacyPrompt, ...workflowConfig } = this._workflowConfig;
    await this._context.globalState.update(WORKFLOW_CONFIG_KEY, {
      ...workflowConfig,
      parserModel
    });
  }

  get config(): AIConfig {
    return { ...this._config };
  }

  get workflowConfig(): WorkflowConfig {
    return {
      parserModel: { ...this._workflowConfig.parserModel },
      enableIcebergPrompting: this._workflowConfig.enableIcebergPrompting,
      defaultWritingExecutionPrompt: this._workflowConfig.defaultWritingExecutionPrompt
    };
  }

  get displayConfig(): AIConfig {
    return {
      ...this._config,
      apiKey: this._config.apiKey ? SECRET_MASK : '',
      langsmith: this._config.langsmith
        ? { ...this._config.langsmith, apiKey: this._config.langsmith.apiKey ? SECRET_MASK : undefined }
        : undefined,
      rag: this._config.rag
        ? {
            ...this._config.rag,
            embeddingApiKey: this._config.rag.embeddingApiKey ? SECRET_MASK : ''
          }
        : undefined,
      webSearch: this._config.webSearch
        ? { ...this._config.webSearch, apiKey: this._config.webSearch.apiKey ? SECRET_MASK : '' }
        : undefined
    };
  }

  get displayWorkflowConfig(): WorkflowConfig {
    return {
      ...this.workflowConfig,
      parserModel: {
        ...this._workflowConfig.parserModel,
        apiKey: this._workflowConfig.parserModel.apiKey ? SECRET_MASK : ''
      }
    };
  }

  async updateConfig(updates: Partial<AIConfig>): Promise<void> {
    const { apiKey, langsmith, rag, webSearch, ...rest } = updates;
    if (apiKey !== undefined && apiKey !== SECRET_MASK) {
      this._config.apiKey = apiKey;
      await this._updateSecret(AI_API_KEY_SECRET, apiKey);
    }
    if (langsmith) {
      const { apiKey: langsmithApiKey, ...langsmithRest } = langsmith;
      this._config.langsmith = { ...this._config.langsmith!, ...langsmithRest };
      if (langsmithApiKey !== undefined && langsmithApiKey !== SECRET_MASK) {
        this._config.langsmith.apiKey = langsmithApiKey;
        await this._updateSecret(LANGSMITH_API_KEY_SECRET, langsmithApiKey);
      }
    }
    if (rag) {
      const { embeddingApiKey, ...ragRest } = rag;
      this._config.rag = { ...DEFAULT_AI_CONFIG.rag!, ...this._config.rag, ...ragRest };
      if (embeddingApiKey !== undefined && embeddingApiKey !== SECRET_MASK) {
        this._config.rag.embeddingApiKey = embeddingApiKey;
        await this._updateSecret(RAG_EMBEDDING_API_KEY_SECRET, embeddingApiKey);
      }
    }
    if (webSearch) {
      const { apiKey: webSearchApiKey, ...webSearchRest } = webSearch;
      this._config.webSearch = { ...DEFAULT_WEB_SEARCH_CONFIG, ...this._config.webSearch, ...webSearchRest };
      if (webSearchApiKey !== undefined && webSearchApiKey !== SECRET_MASK) {
        this._config.webSearch.apiKey = webSearchApiKey;
        await this._updateSecret(WEB_SEARCH_API_KEY_SECRET, webSearchApiKey);
      }
    }
    this._config = { ...this._config, ...rest };
    await this._resolveContextWindow();
    await this._persistConfig();
  }

  private async _resolveContextWindow(): Promise<void> {
    if (this._config.contextWindowMode === 'manual') {
      const contextWindowTokens = Math.max(1_000, Math.floor(this._config.contextWindowSize * 1_000));
      this._config.contextWindowSize = Math.max(1, Math.floor(contextWindowTokens / 1_000));
      this._config.contextWindowDetection = {
        source: 'manual',
        contextWindowTokens,
      };
      return;
    }

    let resolved: ModelContextResolution;
    try {
      resolved = await this._modelCatalog.resolve(this._config.model, this._config.baseUrl);
    } catch (error) {
      console.warn('[AIConfig] Context window detection failed; using the safe 20k fallback:', error);
      resolved = {
        source: 'fallback',
        contextWindowTokens: 20_000,
        detectedAt: new Date().toISOString(),
      };
    }
    this._config.contextWindowSize = Math.max(1, Math.floor(resolved.contextWindowTokens / 1_000));
    this._config.contextWindowDetection = {
      source: resolved.source,
      contextWindowTokens: resolved.contextWindowTokens,
      maxOutputTokens: resolved.maxOutputTokens,
      matchedModel: resolved.matchedModel,
      detectedAt: resolved.detectedAt,
    };
    console.log(
      `[AIConfig] Context window resolved: ${resolved.contextWindowTokens} tokens (${resolved.source}${resolved.matchedModel ? `, ${resolved.matchedModel}` : ''})`
    );
  }

  async updateWorkflowConfig(updates: Partial<WorkflowConfig>): Promise<void> {
    const { parserModel, ...rest } = updates;
    this._workflowConfig = { ...this._workflowConfig, ...rest };
    if (parserModel) {
      const { apiKey, ...parserRest } = parserModel;
      this._workflowConfig.parserModel = { ...this._workflowConfig.parserModel, ...parserRest };
      if (apiKey !== undefined && apiKey !== SECRET_MASK) {
        this._workflowConfig.parserModel.apiKey = apiKey;
        await this._updateSecret(PARSER_API_KEY_SECRET, apiKey);
      }
    }
    await this._persistWorkflowConfig();
  }

  async resetConfig(): Promise<void> {
    this._config = { ...DEFAULT_AI_CONFIG };
    await Promise.all([
      this._context.secrets.delete(AI_API_KEY_SECRET),
      this._context.secrets.delete(LANGSMITH_API_KEY_SECRET),
      this._context.secrets.delete(RAG_EMBEDDING_API_KEY_SECRET),
      this._context.secrets.delete(WEB_SEARCH_API_KEY_SECRET)
    ]);
    await this._context.globalState.update(CONFIG_KEY, undefined);
  }

  async resetWorkflowConfig(): Promise<void> {
    this._workflowConfig = {
      parserModel: { ...DEFAULT_PARSER_CONFIG },
      enableIcebergPrompting: true,
      defaultWritingExecutionPrompt: ''
    };
    await this._context.secrets.delete(PARSER_API_KEY_SECRET);
    await this._context.globalState.update(WORKFLOW_CONFIG_KEY, undefined);
  }

  isConfigured(): boolean {
    return this._config.apiKey.trim().length > 0 && this._config.model.trim().length > 0;
  }

  isParserConfigured(): boolean {
    return this._workflowConfig.parserModel.enabled &&
           this._workflowConfig.parserModel.apiKey.trim().length > 0 &&
           this._workflowConfig.parserModel.model.trim().length > 0;
  }
}
