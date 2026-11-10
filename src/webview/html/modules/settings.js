(function(global) {
    'use strict';

    global.AIWriterSettings = {
        create({ sendMessage, escapeHtml }) {
            let aiConfig = null;
            let ragStatus = null;
            let workflowConfig = null;
            let registeredWorkers = [];

            const element = id => document.getElementById(id);
            const value = id => element(id)?.value || '';
            const checked = id => element(id)?.checked ?? true;
            const setValue = (id, next) => { const node = element(id); if (node) {node.value = next ?? '';} };
            const toggleGroup = (selector, enabled) => {
                document.querySelectorAll(selector).forEach(node => node.classList.toggle('hidden', !enabled));
            };

            function open() {
                element('settings-panel')?.classList.remove('hidden');
                populate();
            }

            function close() {
                element('settings-panel')?.classList.add('hidden');
            }

            function populate() {
                if (!aiConfig) {return;}
                setValue('api-key-input', aiConfig.apiKey);
                setValue('base-url-input', aiConfig.baseUrl);
                setValue('model-input', aiConfig.model);
                setValue('temperature-input', aiConfig.temperature ?? 0.7);
                setValue('context-window-input', aiConfig.contextWindowSize || 20);
                const contextAuto = element('context-window-auto');
                if (contextAuto) {contextAuto.checked = aiConfig.contextWindowMode !== 'manual';}
                renderContextWindow();

                const web = aiConfig.webSearch || {};
                const webEnabled = element('web-search-enabled');
                if (webEnabled) {webEnabled.checked = web.enabled === true;}
                toggleGroup('.web-search-settings', web.enabled === true);
                setValue('web-search-api-key-input', web.apiKey);
                setValue('web-search-depth-select', web.searchDepth || 'advanced');
                setValue('web-search-max-results-input', web.maxResults || 5);
                setValue('web-search-domains-input', (web.allowedDomains || []).join(', '));

                const rag = aiConfig.rag || {};
                setValue('rag-provider-input', rag.embeddingProvider || 'openai-compatible');
                setValue('rag-ollama-url-input', rag.ollamaBaseUrl || 'http://127.0.0.1:11434');
                setValue('rag-ollama-model-input', rag.ollamaModel || 'qwen3-embedding:0.6b');
                const ragEnabled = element('rag-enabled');
                if (ragEnabled) {ragEnabled.checked = rag.enabled === true;}
                toggleGroup('.rag-settings', rag.enabled === true);
                setValue('rag-embedding-api-key-input', rag.embeddingApiKey);
                setValue('rag-embedding-base-url-input', rag.embeddingBaseUrl);
                setValue('rag-embedding-model-input', rag.embeddingModel || 'text-embedding-3-small');
                setValue('rag-embedding-batch-size-input', rag.embedBatchSize || 10);

                const langsmith = aiConfig.langsmith || {};
                const langsmithEnabled = element('langsmith-enabled');
                if (langsmithEnabled) {langsmithEnabled.checked = langsmith.enabled === true;}
                setValue('langsmith-api-key-input', langsmith.apiKey);
                setValue('langsmith-endpoint-input', langsmith.endpoint);
                setValue('langsmith-project-input', langsmith.project);
                setValue('langsmith-workspace-input', langsmith.workspaceId);
                const tracing = element('langsmith-tracing-input');
                if (tracing) {tracing.checked = langsmith.tracingEnabled ?? true;}
                const background = element('langsmith-background-input');
                if (background) {background.checked = langsmith.callbacksBackground ?? true;}
                toggleGroup('.langsmith-settings', langsmith.enabled === true);
                populateWorkflow();
                renderRagStatus();
            }

            function renderContextWindow() {
                const auto = checked('context-window-auto');
                const input = element('context-window-input');
                const status = element('context-window-status');
                if (input) {input.disabled = auto;}
                if (!status) {return;}
                if (!auto) {
                    status.textContent = '手动模式：该值将直接用于 Token 预算';
                    return;
                }
                const detection = aiConfig?.contextWindowDetection;
                const configurationChanged = value('model-input') !== (aiConfig?.model || '')
                    || value('base-url-input') !== (aiConfig?.baseUrl || '');
                if (configurationChanged || detection?.source === 'manual') {
                    status.textContent = '保存设置后将从免费 LiteLLM 模型目录重新识别';
                    return;
                }
                if (!detection) {
                    status.textContent = '保存后将从免费 LiteLLM 模型目录自动识别';
                    return;
                }
                const sourceLabels = {
                    litellm: 'LiteLLM 模型目录', model_name: '模型名称',
                    fallback: '保守默认值', manual: '手动配置'
                };
                const parts = [
                    `检测到 ${formatTokens(detection.contextWindowTokens)}`,
                    `来源：${sourceLabels[detection.source] || detection.source}`
                ];
                if (detection.matchedModel) {parts.push(`匹配：${detection.matchedModel}`);}
                if (detection.maxOutputTokens) {parts.push(`模型最大输出：${formatTokens(detection.maxOutputTokens)}`);}
                status.textContent = parts.join(' · ');
            }

            function formatTokens(tokens) {
                const value = Number(tokens) || 0;
                if (value >= 1000000) {return `${(value / 1000000).toFixed(value % 1000000 ? 2 : 0)}m tokens`;}
                if (value >= 1000) {return `${(value / 1000).toFixed(value % 1000 ? 1 : 0)}k tokens`;}
                return `${value} tokens`;
            }

            function populateWorkflow() {
                const enabled = element('workflow-enabled');
                if (enabled) {enabled.checked = workflowConfig?.enableIcebergPrompting !== false;}
                const workerList = element('registered-workers-list');
                if (workerList) {
                    workerList.innerHTML = registeredWorkers.map(worker =>
                        `<span class="command-chip" title="${escapeHtml(worker.description || '')}">${escapeHtml(worker.id)}</span>`
                    ).join('');
                }
                const parser = workflowConfig?.parserModel || {};
                const parserEnabled = element('parser-enabled');
                if (parserEnabled) {parserEnabled.checked = parser.enabled !== false;}
                setValue('parser-provider-select', parser.provider || 'openai');
                setValue('parser-api-key-input', parser.apiKey);
                setValue('parser-base-url-input', parser.baseUrl || 'https://api.openai.com/v1');
                setValue('parser-model-input', parser.model || '');
                setValue('parser-temperature-input', parser.temperature ?? 0.1);
                toggleGroup('.parser-settings', parser.enabled !== false);
            }

            function renderRagStatus() {
                const panel = element('rag-status-panel');
                const label = element('rag-status-label');
                const detail = element('rag-status-detail');
                const qualityDetail = element('rag-quality-detail');
                const buildButton = element('rag-build-index-btn');
                if (!panel || !label || !detail || !qualityDetail || !buildButton) {return;}
                const status = ragStatus?.status || 'DISABLED';
                const labels = {
                    DISABLED: '未启用', NOT_CONFIGURED: '未配置', EMPTY: '尚未构建',
                    BUILDING: '正在构建', READY: '已就绪', STALE: '需要重建', FAILED: '构建失败'
                };
                panel.dataset.status = status;
                label.textContent = labels[status] || status;
                const parts = [];
                if (ragStatus && (ragStatus.files || ragStatus.chunks)) {
                    parts.push(`${ragStatus.files || 0} 个文件 · ${ragStatus.chunks || 0} 个片段`);
                }
                if (ragStatus?.lastUpdated) {parts.push(`更新于 ${new Date(ragStatus.lastUpdated).toLocaleString()}`);}
                if (ragStatus?.error) {parts.push(ragStatus.error);}
                if (!parts.length) {parts.push(status === 'DISABLED' ? '请先到设置启用故事检索并保存' : '尚无索引数据');}
                detail.textContent = parts.join(' · ');
                const quality = ragStatus?.quality;
                if (quality?.totalChunks > 0) {
                    const warning = quality.warnings?.length ? ` · ${quality.warnings.join('；')}` : ' · 未发现明显异常';
                    qualityDetail.textContent = `片段质量：平均 ${Math.round(quality.averageChunkSize)} 字 · 最小 ${quality.minChunkSize} · 最大 ${quality.maxChunkSize}${warning}`;
                    qualityDetail.classList.remove('hidden');
                } else {
                    qualityDetail.textContent = '';
                    qualityDetail.classList.add('hidden');
                }
                buildButton.disabled = ['DISABLED', 'NOT_CONFIGURED', 'BUILDING'].includes(status);
                buildButton.textContent = status === 'BUILDING' ? '构建中…'
                    : '选择文件并构建索引';
            }

            function showError(message) {
                const node = document.createElement('div');
                node.className = 'settings-error';
                node.textContent = message;
                const content = document.querySelector('.settings-content');
                if (content) {
                    content.insertBefore(node, content.firstChild);
                    setTimeout(() => node.remove(), 3000);
                }
            }

            function save() {
                const webEnabled = checked('web-search-enabled');
                const parserEnabled = checked('parser-enabled');
                if (webEnabled && !value('web-search-api-key-input')) {
                    showError('启用外部检索时必须提供 Tavily API Key');
                    return;
                }
                if (parserEnabled && !value('parser-api-key-input')) {
                    showError('启用解析模型时必须提供 API Key');
                    return;
                }
                const langsmithEnabled = checked('langsmith-enabled');
                const contextWindowMode = checked('context-window-auto') ? 'auto' : 'manual';
                sendMessage('ai/update_config', {
                    apiKey: value('api-key-input'),
                    baseUrl: value('base-url-input') || undefined,
                    model: value('model-input'),
                    temperature: parseFloat(value('temperature-input')) || 0.7,
                    // Retained only as an internal context-reserve hint for
                    // backwards-compatible configuration. It is not sent to providers.
                    maxTokens: aiConfig?.maxTokens || 4096,
                    contextWindowMode,
                    contextWindowSize: parseInt(value('context-window-input')) || 20,
                    webSearch: {
                        enabled: webEnabled, provider: 'tavily', apiKey: value('web-search-api-key-input'),
                        searchDepth: value('web-search-depth-select') === 'basic' ? 'basic' : 'advanced',
                        maxResults: Math.min(5, Math.max(1, parseInt(value('web-search-max-results-input')) || 5)),
                        allowedDomains: value('web-search-domains-input').split(',').map(item => item.trim()).filter(Boolean)
                    },
                    rag: {
                        ...(aiConfig?.rag || {}), enabled: checked('rag-enabled'),
                        embeddingProvider: value('rag-provider-input'),
                        ollamaBaseUrl: value('rag-ollama-url-input'),
                        ollamaModel: value('rag-ollama-model-input'),
                        embeddingApiKey: value('rag-embedding-api-key-input'),
                        embeddingBaseUrl: value('rag-embedding-base-url-input'),
                        embeddingModel: value('rag-embedding-model-input') || 'text-embedding-3-small',
                        embedBatchSize: Math.max(1, parseInt(value('rag-embedding-batch-size-input'), 10) || 10)
                    },
                    langsmith: {
                        enabled: langsmithEnabled,
                        apiKey: langsmithEnabled ? value('langsmith-api-key-input') || undefined : undefined,
                        endpoint: langsmithEnabled ? value('langsmith-endpoint-input') || undefined : undefined,
                        project: langsmithEnabled ? value('langsmith-project-input') || undefined : undefined,
                        workspaceId: langsmithEnabled ? value('langsmith-workspace-input') || undefined : undefined,
                        tracingEnabled: checked('langsmith-tracing-input'),
                        callbacksBackground: checked('langsmith-background-input')
                    }
                });
                sendMessage('ai/update_workflow_config', {
                    enableIcebergPrompting: checked('workflow-enabled'),
                    parserModel: {
                        enabled: parserEnabled,
                        provider: value('parser-provider-select') || 'openai',
                        apiKey: value('parser-api-key-input'),
                        baseUrl: value('parser-base-url-input') || undefined,
                        model: value('parser-model-input'),
                        temperature: parseFloat(value('parser-temperature-input')) || 0.1,
                        maxTokens: workflowConfig?.parserModel?.maxTokens || 512
                    }
                });
                close();
            }

            function bind() {
                element('settings-btn')?.addEventListener('click', open);
                element('close-settings-btn')?.addEventListener('click', close);
                element('save-settings-btn')?.addEventListener('click', save);
                element('context-window-auto')?.addEventListener('change', renderContextWindow);
                element('model-input')?.addEventListener('input', renderContextWindow);
                element('base-url-input')?.addEventListener('input', renderContextWindow);
                element('rag-build-index-btn')?.addEventListener('click', () => sendMessage('rag/build_index', undefined));
                element('langsmith-enabled')?.addEventListener('change', event => toggleGroup('.langsmith-settings', event.target.checked));
                element('parser-enabled')?.addEventListener('change', event => toggleGroup('.parser-settings', event.target.checked));
                element('rag-enabled')?.addEventListener('change', event => toggleGroup('.rag-settings', event.target.checked));
                element('web-search-enabled')?.addEventListener('change', event => toggleGroup('.web-search-settings', event.target.checked));
            }

            return {
                bind,
                setAIConfig(config) { aiConfig = config; },
                setRagStatus(status) { ragStatus = status; renderRagStatus(); },
                setWorkflowConfig(data) {
                    workflowConfig = data?.workflowConfig || null;
                    registeredWorkers = data?.registeredWorkers || [];
                }
            };
        }
    };
})(window);
