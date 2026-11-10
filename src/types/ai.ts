import { DEFAULT_RAG_CONFIG, RagConfig } from './rag';

export interface LangSmithConfig {
  enabled: boolean;
  apiKey?: string;
  endpoint?: string;
  project?: string;
  workspaceId?: string;
  tracingEnabled: boolean;
  callbacksBackground: boolean;
}

export interface ParserModelConfig {
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'custom';
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export const DEFAULT_PARSER_CONFIG: ParserModelConfig = {
  enabled: true,
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  temperature: 0.1,
  maxTokens: 1024
};

export interface WorkflowConfig {
  parserModel: ParserModelConfig;
  enableIcebergPrompting: boolean;
  defaultWritingExecutionPrompt: string;
  /** @deprecated Read only while migrating previously persisted settings. */
  defaultWriterSystemPrompt?: string;
}

export interface WebSearchConfig {
  enabled: boolean;
  provider: 'tavily';
  apiKey?: string;
  searchDepth: 'basic' | 'advanced';
  maxResults: number;
  allowedDomains: string[];
}

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  enabled: false,
  provider: 'tavily',
  apiKey: '',
  searchDepth: 'advanced',
  maxResults: 5,
  allowedDomains: [],
};

export interface AIConfig {
  provider: 'openai' | 'anthropic' | 'custom';
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** Legacy output-budget hint used for local planning; never sent as a provider completion limit. */
  maxTokens: number;
  temperature: number;
  contextWindowMode: 'auto' | 'manual';
  contextWindowSize: number;
  contextWindowDetection?: ContextWindowDetection;
  langsmith?: LangSmithConfig;
  workflow?: WorkflowConfig;
  rag?: RagConfig;
  webSearch?: WebSearchConfig;
}

export interface ContextWindowDetection {
  source: 'litellm' | 'model_name' | 'manual' | 'fallback';
  contextWindowTokens: number;
  maxOutputTokens?: number;
  matchedModel?: string;
  detectedAt?: string;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  maxTokens: 4096,
  temperature: 0.7,
  contextWindowMode: 'auto',
  contextWindowSize: 20,
  contextWindowDetection: {
    source: 'fallback',
    contextWindowTokens: 20_000,
  },
  langsmith: {
    enabled: false,
    tracingEnabled: true,
    callbacksBackground: true,
    endpoint: 'https://api.smith.langchain.com',
    project: 'aiwriter'
  },
  workflow: {
    parserModel: DEFAULT_PARSER_CONFIG,
    enableIcebergPrompting: true,
    defaultWritingExecutionPrompt: ''
  },
  rag: { ...DEFAULT_RAG_CONFIG },
  webSearch: { ...DEFAULT_WEB_SEARCH_CONFIG }
};
