import { ContextWindowDetection } from '../../types';

export const LITELLM_MODEL_CATALOG_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const FALLBACK_CONTEXT_TOKENS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface ModelCatalogEntry {
  id: string;
  provider?: string;
  maxInputTokens: number;
  maxOutputTokens?: number;
}

interface ModelCatalogCache {
  fetchedAt: number;
  entries: ModelCatalogEntry[];
}

export interface ModelCatalogStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export type CatalogFetch = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ModelContextResolution extends ContextWindowDetection {
  fromCache?: boolean;
}

const CACHE_KEY = 'aiwriter.modelCatalog.litellm.v1';

export class ModelCatalogService {
  constructor(
    private readonly storage: ModelCatalogStorage,
    private readonly fetcher: CatalogFetch = globalThis.fetch as CatalogFetch,
    private readonly now: () => number = Date.now
  ) {}

  async resolve(model: string, baseUrl?: string): Promise<ModelContextResolution> {
    const cached = this.storage.get<ModelCatalogCache>(CACHE_KEY);
    let entries = isUsableCache(cached, this.now()) ? cached!.entries : undefined;
    let fromCache = !!entries;

    if (!entries) {
      try {
        entries = await this.fetchCatalog();
        await this.storage.update(CACHE_KEY, { fetchedAt: this.now(), entries });
        fromCache = false;
      } catch (error) {
        if (cached?.entries?.length) {
          console.warn('[ModelCatalog] Refresh failed; using stale LiteLLM cache:', error);
          entries = cached.entries;
          fromCache = true;
        } else {
          console.warn('[ModelCatalog] LiteLLM catalog unavailable; using local inference:', error);
        }
      }
    }

    const matched = entries ? matchCatalogEntry(entries, model, baseUrl) : undefined;
    if (matched) {
      return {
        source: 'litellm',
        contextWindowTokens: matched.maxInputTokens,
        maxOutputTokens: matched.maxOutputTokens,
        matchedModel: matched.id,
        detectedAt: new Date(this.now()).toISOString(),
        fromCache,
      };
    }

    const inferred = inferContextFromModelName(model);
    if (inferred) {
      return {
        source: 'model_name',
        contextWindowTokens: inferred,
        matchedModel: model,
        detectedAt: new Date(this.now()).toISOString(),
        fromCache,
      };
    }

    return {
      source: 'fallback',
      contextWindowTokens: FALLBACK_CONTEXT_TOKENS,
      detectedAt: new Date(this.now()).toISOString(),
      fromCache,
    };
  }

  private async fetchCatalog(): Promise<ModelCatalogEntry[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // This public request intentionally sends no model API key, base URL,
      // prompt, file content, or other user data.
      const response = await this.fetcher(LITELLM_MODEL_CATALOG_URL, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const entries = parseLiteLLMCatalog(await response.json());
      if (entries.length === 0) {
        throw new Error('catalog contains no usable context-window entries');
      }
      console.log(`[ModelCatalog] Loaded ${entries.length} LiteLLM model entries`);
      return entries;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseLiteLLMCatalog(value: unknown): ModelCatalogEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const entries: ModelCatalogEntry[] = [];
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const item = raw as Record<string, unknown>;
    const maxInputTokens = positiveInteger(item.max_input_tokens);
    if (!maxInputTokens) {
      continue;
    }
    entries.push({
      id,
      provider: typeof item.litellm_provider === 'string' ? item.litellm_provider : undefined,
      maxInputTokens,
      maxOutputTokens: positiveInteger(item.max_output_tokens) || positiveInteger(item.max_tokens),
    });
  }
  return entries;
}

export function matchCatalogEntry(
  entries: readonly ModelCatalogEntry[],
  model: string,
  baseUrl?: string
): ModelCatalogEntry | undefined {
  const normalizedModel = normalizeModelIdentifier(model);
  if (!normalizedModel) {
    return undefined;
  }
  const provider = inferProviderFromBaseUrl(baseUrl);
  const candidates: string[] = [];
  if (provider && !normalizedModel.startsWith(`${provider}/`)) {
    candidates.push(`${provider}/${normalizedModel}`);
  }
  candidates.push(normalizedModel);

  const normalizedEntries = entries.map(entry => ({ entry, id: normalizeModelIdentifier(entry.id) }));
  for (const candidate of candidates) {
    const exact = normalizedEntries.find(item => item.id === candidate);
    if (exact) {
      return exact.entry;
    }
  }

  // Some catalogs keep a plain model ID and identify the provider in a field.
  if (provider) {
    return normalizedEntries.find(item =>
      item.id === normalizedModel && normalizeModelIdentifier(item.entry.provider || '') === provider
    )?.entry;
  }
  return undefined;
}

export function inferProviderFromBaseUrl(baseUrl?: string): string | undefined {
  const value = normalizeModelIdentifier(baseUrl || '');
  const providers: Array<[string, string]> = [
    ['openrouter.ai', 'openrouter'],
    ['api.openai.com', 'openai'],
    ['api.anthropic.com', 'anthropic'],
    ['generativelanguage.googleapis.com', 'gemini'],
    ['api.deepseek.com', 'deepseek'],
    ['api.mistral.ai', 'mistral'],
    ['api.groq.com', 'groq'],
    ['api.together.xyz', 'together_ai'],
    ['integrate.api.nvidia.com', 'nvidia_nim'],
    ['dashscope.aliyuncs.com', 'dashscope'],
    ['localhost:11434', 'ollama'],
    ['127.0.0.1:11434', 'ollama'],
  ];
  return providers.find(([host]) => value.includes(host))?.[1];
}

export function inferContextFromModelName(model: string): number | undefined {
  const normalized = normalizeModelIdentifier(model);
  const match = normalized.match(/(?:^|[-_])(\d+(?:\.\d+)?)(k|m)(?:[-_]|$|context)/i);
  if (!match) {
    return undefined;
  }
  const quantity = Number(match[1]);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return undefined;
  }
  return Math.floor(quantity * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000));
}

function isUsableCache(cache: ModelCatalogCache | undefined, now: number): boolean {
  return !!cache?.entries?.length
    && Number.isFinite(cache.fetchedAt)
    && now - cache.fetchedAt < CACHE_TTL_MS;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function normalizeModelIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}
