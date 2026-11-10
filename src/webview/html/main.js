/*
 * AI Writer - VSCode 小说创作助手插件
 *
 * main.js - Webview 主逻辑文件
 * 功能：处理侧边栏的所有交互逻辑，包括：
 *   - 与 VSCode 扩展的消息通信
 *   - 会话管理（列表渲染、切换、删除）
 *   - 消息渲染和发送
 *   - 选中文本管理
 *   - AI 配置管理
 *   - 文件差异管理
*/
(function() {
    'use strict';

    const vscode = acquireVsCodeApi();

    let messages = [];
    let sessions = [];
    let selections = [];
    let activeSessionId = null;
    let branchPending = false;
    let isAiResponding = false;
    let isOrganizationRunning = false;
    let activeRequestId = null;
    let currentAiResponse = '';
    let currentProgressMsg = '';
    let streamRenderFrame = null;
    let fileApprovalPanel;
    let settingsController;

    function sendMessage(type, data) {
        vscode.postMessage({
            type,
            data,
            timestamp: new Date().toISOString()
        });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function parseMarkdown(text) {
        if (typeof marked !== 'undefined') {
            // 模型输出是不可信输入。先转义原始 HTML，再交给 Markdown 解析器。
            return marked.parse(escapeHtml(text), { breaks: true });
        }
        return escapeHtml(text);
    }

    function highlightCode(code, language) {
        return escapeHtml(code);
    }

    function isNearBottom(container) {
        return container.scrollHeight - container.scrollTop - container.clientHeight < 72;
    }

    function scrollToBottom(container, force) {
        if (force || isNearBottom(container)) {
            container.scrollTop = container.scrollHeight;
        }
    }

    function scheduleStreamRender() {
        if (streamRenderFrame !== null) {
            return;
        }
        streamRenderFrame = requestAnimationFrame(() => {
            streamRenderFrame = null;
            updateTypingMessageWithProgress(currentAiResponse, currentProgressMsg || null);
        });
    }

    function formatMessageContent(content) {
        const codeBlockRegex = /```(\w+)?\n([\s\S]*?)\n```/g;
        const parts = [];
        let lastIndex = 0;
        let match;

        while ((match = codeBlockRegex.exec(content)) !== null) {
            if (match.index > lastIndex) {
                parts.push({
                    type: 'text',
                    content: content.slice(lastIndex, match.index)
                });
            }

            const codeContent = match[2];
            const language = match[1] || 'text';

            parts.push({
                type: 'code',
                language,
                content: codeContent
            });

            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < content.length) {
            parts.push({
                type: 'text',
                content: content.slice(lastIndex)
            });
        }

        return parts.map(part => {
            if (part.type === 'text') {
                return parseMarkdown(part.content);
            } else {
                return `<pre class="code-block"><code class="language-${part.language}">${highlightCode(part.content, part.language)}</code></pre>`;
            }
        }).join('');
    }

    function renderMessages() {
        const container = document.getElementById('messages-container');
        container.innerHTML = '';

        if (messages.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">W</div>
                    <div class="empty-state-title">开始创作</div>
                    <div class="empty-state-copy">直接描述你的目标，AI 会自动拆解任务，并在需要时读取项目资料或调用工具。</div>
                </div>
            `;
        } else {
            let conversationRound = 0;
            messages.forEach((message, index) => {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + message.role;
                messageDiv.dataset.index = index;

                if (message.role === 'user') {
                    conversationRound++;
                    messageDiv.dataset.round = conversationRound;
                }

                const time = new Date(message.timestamp).toLocaleString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit'
                });

                const roleLabel = message.role === 'user' ? '你' :
                                  message.role === 'assistant' ? 'AI' : '系统';

                const roundIndicator = message.role === 'user' ?
                    `<span class="conversation-round">第 ${conversationRound} 轮</span>` : '';

                let actionsHtml = '';
                if (message.role === 'user') {
                    actionsHtml = `
                        <div class="message-actions">
                            <button class="message-action-btn edit" title="重新编辑并发送" data-index="${index}" data-round="${conversationRound}">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 20h9"></path>
                                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                                </svg>
                            </button>
                            <button class="message-action-btn restore" title="恢复到这轮对话状态" data-round="${conversationRound}">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="1 4 1 10 7 10"></polyline>
                                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                                </svg>
                            </button>
                        </div>
                    `;
                } else if (message.role === 'assistant' && message.content?.trim()
                    && (!message.requestStatus || message.requestStatus === 'COMPLETED')) {
                    actionsHtml = `
                        <div class="message-actions">
                            <button type="button" class="message-action-btn branch" title="从此处分支" aria-label="从此处分支" data-index="${index}">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                    <path d="M6 9v6m0 0c0-4 6-2 10-6"></path>
                                    <circle cx="6" cy="6" r="3"></circle>
                                    <circle cx="6" cy="18" r="3"></circle>
                                    <circle cx="18" cy="6" r="3"></circle>
                                </svg>
                            </button>
                        </div>
                    `;
                }

                messageDiv.innerHTML = `
                    ${actionsHtml}
                    <div class="message-content">${formatMessageContent(message.content)}</div>
                    <div class="message-time">
                        ${roleLabel} · ${time}${roundIndicator}
                    </div>
                `;

                container.appendChild(messageDiv);
            });
        }

        if (isAiResponding && currentAiResponse) {
            restoreTypingMessage();
        } else if (isAiResponding) {
            showThinkingMessage();
        }

        scrollToBottom(container, true);

        bindMessageActions();
    }

    function restoreTypingMessage() {
        const container = document.getElementById('messages-container');
        let typingDiv = document.getElementById('typing-message');
        if (!typingDiv) {
            typingDiv = document.createElement('div');
            typingDiv.id = 'typing-message';
            typingDiv.className = 'message assistant';
            container.appendChild(typingDiv);
        }
        updateTypingMessageWithProgress(currentAiResponse, null);
    }

    // 专门用于流式响应时更新最后一条 AI 消息，避免重绘整个列表
    function updateTypingMessage(content) {
        updateTypingMessageWithProgress(content, currentProgressMsg);
    }

    // 更新消息，包含进度提示（进度提示显示在内容下方，不顶掉内容）
    function updateTypingMessageWithProgress(content, progressMsg) {
        const container = document.getElementById('messages-container');
        const shouldFollow = isNearBottom(container);

        let typingDiv = document.getElementById('typing-message');

        if (!typingDiv) {
            typingDiv = document.createElement('div');
            typingDiv.id = 'typing-message';
            typingDiv.className = 'message assistant';
            container.appendChild(typingDiv);
        }

        const mainContent = content ? formatMessageContent(content) : '';
        let progressHtml = '';

        if (progressMsg) {
            progressHtml = `
                <div class="progress-indicator">
                    <span class="thinking-dots">
                        <span class="dot"></span>
                        <span class="dot"></span>
                        <span class="dot"></span>
                    </span>
                    <span class="progress-text"> ${escapeHtml(progressMsg)}</span>
                </div>
            `;
        }

        typingDiv.innerHTML = `
            <div class="message-content">${mainContent}${progressHtml}</div>
        `;

        scrollToBottom(container, shouldFollow);
    }

    function renderSessions() {
        const container = document.getElementById('sessions-list');
        if (!container) {
            return;
        }
        container.innerHTML = '';

        if (sessions.length === 0) {
            container.innerHTML = '<div class="empty-sessions">暂无会话，点击 + 新建</div>';
            return;
        }

        sessions.forEach(session => {
            const item = document.createElement('div');
            item.className = 'session-item' + (session.sessionId === activeSessionId ? ' active' : '');
            item.innerHTML = `
                <div class="session-item-title">${escapeHtml(session.title)}</div>
                <div class="session-item-meta">
                    <span>${session.messageCount} 条消息</span>
                    <div class="session-item-actions">
                        <button class="session-action-btn delete" title="删除" data-session-id="${session.sessionId}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                </div>
            `;

            const deleteBtn = item.querySelector('.delete');
            deleteBtn.onclick = function(e) {
                e.stopPropagation();
                sendMessage('session/delete', { sessionId: session.sessionId });
            };

            item.onclick = function(e) {
                if (!e.target.closest('.session-action-btn')) {
                    sendMessage('session/load', { sessionId: session.sessionId });
                    closeSessionsDropdown();
                }
            };

            container.appendChild(item);
        });

        updateActiveSessionTitle();
    }

    function updateActiveSessionTitle() {
        const title = document.getElementById('active-session-title');
        if (!title) {
            return;
        }
        const activeSession = sessions.find(session => session.sessionId === activeSessionId);
        title.textContent = activeSession ? activeSession.title : 'AI Writer';
        title.title = activeSession ? activeSession.title : '';
    }

    function showConfirmModal(title, onConfirm) {
        const overlay = document.getElementById('modal-overlay');
        const titleEl = document.getElementById('modal-title');
        const inputEl = document.getElementById('modal-input');
        const cancelBtn = document.getElementById('modal-cancel');
        const confirmBtn = document.getElementById('modal-confirm');

        if (!overlay || !titleEl || !cancelBtn || !confirmBtn) {
            console.log('[showConfirmModal] modal 元素未找到');
            onConfirm(true);
            return;
        }

        titleEl.textContent = title;
        inputEl.style.display = 'none';

        const cleanup = () => {
            overlay.classList.add('hidden');
            cancelBtn.onclick = null;
            confirmBtn.onclick = null;
        };

        cancelBtn.onclick = () => {
            cleanup();
            onConfirm(false);
        };

        confirmBtn.onclick = () => {
            cleanup();
            onConfirm(true);
        };

        overlay.classList.remove('hidden');
    }

    function toggleSessionsDropdown() {
        const dropdown = document.getElementById('sessions-dropdown');
        dropdown.classList.toggle('hidden');
    }

    function closeSessionsDropdown() {
        const dropdown = document.getElementById('sessions-dropdown');
        dropdown.classList.add('hidden');
    }

    function toggleProjectToolsMenu() {
        const menu = document.getElementById('project-tools-menu');
        const button = document.getElementById('project-tools-btn');
        if (!menu || !button) {
            return;
        }
        const willOpen = menu.classList.contains('hidden');
        menu.classList.toggle('hidden', !willOpen);
        button.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
            closeSessionsDropdown();
        }
    }

    function closeProjectToolsMenu() {
        const menu = document.getElementById('project-tools-menu');
        const button = document.getElementById('project-tools-btn');
        menu?.classList.add('hidden');
        button?.setAttribute('aria-expanded', 'false');
    }

    function updateOrganizationUi(state, message) {
        const action = document.getElementById('organize-project-btn');
        const status = document.getElementById('organization-status');
        if (action) {
            action.disabled = isOrganizationRunning || isAiResponding;
        }
        if (status && message) {
            status.textContent = message;
            status.classList.toggle('running', state === 'running');
            status.classList.toggle('error', state === 'error');
            status.classList.toggle('completed', state === 'completed');
        }
    }

    function startMarkdownOrganization() {
        if (isOrganizationRunning) {
            return;
        }
        if (isAiResponding) {
            updateOrganizationUi('idle', '请等待当前 AI 对话完成后再整理项目');
            return;
        }
        isOrganizationRunning = true;
        updateOrganizationUi('running', '整理 Agent 正在启动…');
        closeProjectToolsMenu();
        sendMessage('organization/start', undefined);
    }

    function renderSelections() {
        const panel = document.getElementById('selections-panel');
        const container = document.getElementById('selections-list');

        if (!panel || !container) {
            return;
        }

        if (selections.length === 0) {
            panel.classList.add('hidden');
            return;
        }

        panel.classList.remove('hidden');
        container.innerHTML = '';

        selections.forEach(selection => {
            const chip = document.createElement('div');
            chip.className = 'selection-chip';
            chip.innerHTML = `
                <span class="selection-chip-name" title="${escapeHtml(selection.displayName)}">${escapeHtml(selection.displayName)}</span>
                <button class="selection-chip-remove" data-selection-id="${selection.id}" title="移除">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            `;

            const removeBtn = chip.querySelector('.selection-chip-remove');
            removeBtn.onclick = function(e) {
                e.stopPropagation();
                sendMessage('selection/remove', { id: selection.id });
            };

            container.appendChild(chip);
        });
    }

    /**
     * 更新 token 统计显示
     */
    function updateTokenStats(stats) {
        console.log('[Token] Received stats:', stats);

        const tokenBar = document.getElementById('token-bar');
        const tokenCount = document.getElementById('token-count');
        const tokenUsage = document.getElementById('token-usage');

        if (!tokenBar || !tokenCount || !tokenUsage) {
            console.warn('[Token] Token bar elements not found');
            return;
        }

        // 格式化显示
        const totalTokens = stats.totalTokens || 0;
        const inputTokens = stats.inputTokens || 0;
        const outputTokens = stats.outputTokens || 0;
        const usage = stats.contextUsagePercent || 0;
        const shouldWarn = stats.shouldWarn || false;

        tokenCount.textContent = `${inputTokens}+${outputTokens}=${totalTokens} tokens`;
        if (stats.scope === 'request') {
            tokenCount.textContent += stats.usageComplete === false
                ? `（已知用量；${stats.unknownAttempts || 0} 次调用用量未完整返回）`
                : '（本次请求）';
        }
        tokenUsage.textContent = `Usage: ${usage.toFixed(1)}%`;

        // 更新样式
        tokenBar.classList.remove('warning', 'danger');
        if (usage >= 90) {
            tokenBar.classList.add('danger');
        } else if (usage >= 80) {
            tokenBar.classList.add('warning');
        }

        console.log(`[Token] Updated display: ${totalTokens} tokens, ${usage.toFixed(1)}%`);
    }

    function handleSend() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();

        if (!content) {
            return;
        }

        if (content === '/整理项目' || content.toLowerCase() === '/organize') {
            input.value = '';
            input.style.height = 'auto';
            startMarkdownOrganization();
            return;
        }

        if (isAiResponding || branchPending) {
            return;
        }

        input.value = '';
        input.style.height = 'auto';

        // 立即设置正在响应状态
        isAiResponding = true;
        currentAiResponse = '';
        currentProgressMsg = '正在思考中...';

        // 显示"正在思考"提示
        showThinkingMessage();

        sendMessage('ai/send', { content });
    }

    function handleStop() {
        if (!activeRequestId) {
            return;
        }
        sendMessage('ai/cancel', { requestId: activeRequestId });
    }

    function updateRequestButtons(running) {
        const sendBtn = document.getElementById('send-button');
        const stopBtn = document.getElementById('stop-button');
        const requestState = document.getElementById('request-state');
        if (sendBtn) {
            sendBtn.classList.toggle('hidden', running);
        }
        if (stopBtn) {
            stopBtn.classList.toggle('hidden', !running);
        }
        if (requestState) {
            requestState.textContent = running ? '生成中' : '就绪';
            requestState.classList.toggle('running', running);
        }
        updateOrganizationUi(isOrganizationRunning ? 'running' : 'idle');
    }

    function showThinkingMessage() {
        const container = document.getElementById('messages-container');
        const thinkingDiv = document.createElement('div');
        thinkingDiv.id = 'typing-message';
        thinkingDiv.className = 'message assistant';
        thinkingDiv.innerHTML = `
            <div class="message-content">
                <span class="thinking-dots">
                    <span class="dot"></span>
                    <span class="dot"></span>
                    <span class="dot"></span>
                </span>
                <span class="thinking-text"> ${escapeHtml(currentProgressMsg)}</span>
            </div>
        `;
        const existingTyping = document.getElementById('typing-message');
        if (existingTyping) {
            existingTyping.remove();
        }
        container.appendChild(thinkingDiv);
        scrollToBottom(container, true);
    }

    function autoResizeTextarea() {
        const textarea = document.getElementById('message-input');
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    }

    function restoreMessageInput(content) {
        const input = document.getElementById('message-input');
        if (!input) {
            return;
        }
        input.value = typeof content === 'string' ? content : '';
        autoResizeTextarea();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    function bindMessageActions() {
        const container = document.getElementById('messages-container');
        if (!container) {
            return;
        }

        container.querySelectorAll('.message-action-btn.branch').forEach(button => {
            button.onclick = event => {
                event.stopPropagation();
                const answer = messages[Number(button.dataset.index)];
                if (branchPending || isAiResponding || !activeSessionId || answer?.role !== 'assistant') {
                    return;
                }
                branchPending = true;
                sendMessage('session/branch', {
                    sessionId: activeSessionId,
                    timestamp: answer.timestamp,
                    requestId: answer.requestId,
                });
            };
        });

        const editBtns = container.querySelectorAll('.message-action-btn.edit');
        editBtns.forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const index = parseInt(btn.dataset.index);
                if (!isNaN(index) && messages[index] && messages[index].role === 'user') {
                    restoreMessageInput(messages[index].content);
                }
            };
        });

        const restoreBtns = container.querySelectorAll('.message-action-btn.restore');
        restoreBtns.forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const round = parseInt(btn.dataset.round);
                if (round) {
                    showConfirmModal(
                        `恢复到第 ${round} 轮对话的状态？\n之后的修改将被撤销。`,
                        (confirmed) => {
                            if (confirmed) {
                                sendMessage('conversation/restore', { conversationIndex: round - 1 });
                            }
                        }
                    );
                }
            };
        });
    }

    function init() {
        if (!window.AIWriterFileApproval || !window.AIWriterSettings) {
            throw new Error('Webview 功能模块加载失败，请重新编译插件后重试');
        }
        fileApprovalPanel = window.AIWriterFileApproval.create({ sendMessage, escapeHtml });
        settingsController = window.AIWriterSettings.create({ sendMessage, escapeHtml });

        const sendBtn = document.getElementById('send-button');
        const stopBtn = document.getElementById('stop-button');
        const input = document.getElementById('message-input');
        const sessionsBtn = document.getElementById('sessions-btn');
        const newSessionBtn = document.getElementById('new-session-btn');
        const projectToolsBtn = document.getElementById('project-tools-btn');
        document.querySelectorAll('[data-research-action]').forEach(button => {
            button.addEventListener('click', () => sendMessage('research/action', { action: button.dataset.researchAction }));
        });
        const organizeProjectBtn = document.getElementById('organize-project-btn');
        const clearSelectionsBtn = document.getElementById('clear-selections-btn');
        const diffCloseBtn = document.getElementById('diff-close-btn');

        if (sendBtn) {
            sendBtn.addEventListener('click', handleSend);
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', handleStop);
        }

        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                }
            });

            input.addEventListener('input', autoResizeTextarea);
            input.focus();
        }

        if (sessionsBtn) {
            sessionsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSessionsDropdown();
            });
        }

        if (newSessionBtn) {
            newSessionBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendMessage('session/create', {});
                closeSessionsDropdown();
            });
        }

        if (projectToolsBtn) {
            projectToolsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleProjectToolsMenu();
            });
        }

        if (organizeProjectBtn) {
            organizeProjectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                startMarkdownOrganization();
            });
        }

        settingsController.bind();

        if (clearSelectionsBtn) {
            clearSelectionsBtn.addEventListener('click', () => {
                sendMessage('selection/clear', undefined);
            });
        }

        if (diffCloseBtn) {
            diffCloseBtn.addEventListener('click', () => {
                fileApprovalPanel.rejectAll();
            });
        }

        renderMessages();
        updateRequestButtons(false);
        sendMessage('init', undefined);
        sendMessage('ai/get_config', undefined);
        sendMessage('ai/get_workflow_config', undefined);
        sendMessage('rag/get_status', undefined);
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || !message.type) {
            return;
        }

        switch (message.type) {
            case 'session/list':
                sessions = message.data;
                renderSessions();
                break;

            case 'session/active':
                if (message.data) {
                    activeSessionId = message.data.sessionId;
                    messages = message.data.history || [];
                    renderSessions();
                    renderMessages();
                }
                break;

            case 'session/created':
            case 'session/loaded':
                activeSessionId = message.data.sessionId;
                messages = message.data.history || [];
                // 重置 AI 响应状态
                isAiResponding = false;
                currentAiResponse = '';
                currentProgressMsg = '';
                // 移除正在输入的 typing message
                const typingDiv = document.getElementById('typing-message');
                if (typingDiv) {
                    typingDiv.remove();
                }
                // 新建会话才添加欢迎消息
                if (message.type === 'session/created') {
                    const welcomeMsg = {
                        role: 'system',
                        content: '会话 "' + message.data.title + '" 已创建。你可以开始写作了！',
                        timestamp: new Date().toISOString()
                    };
                    messages.push(welcomeMsg);
                }
                renderSessions();
                renderMessages();
                break;

            case 'session/branch_finished':
                branchPending = false;
                break;

            case 'session/deleted':
                renderSessions();
                break;

            case 'conversation/restored':
                restoreMessageInput(message.data && message.data.content);
                break;

            case 'selection/list':
                selections = message.data || [];
                renderSelections();
                break;

            case 'selection/added':
                selections.push(message.data);
                renderSelections();
                break;

            case 'selection/removed':
                selections = selections.filter(s => s.id !== message.data.id);
                renderSelections();
                break;

            case 'selection/cleared':
                selections = [];
                renderSelections();
                break;

            case 'diff/pending':
                fileApprovalPanel.addDiff(message.data.filepath);
                break;

            case 'diff/decision':
                fileApprovalPanel.removeDiff(message.data.filepath);
                if (message.data.decision === 'accepted') {
                    const acceptMsg = {
                        role: 'system',
                        content: '文件已修改: ' + message.data.filepath,
                        timestamp: new Date().toISOString()
                    };
                    messages.push(acceptMsg);
                    renderMessages();
                } else if (message.data.decision === 'rejected') {
                    const rejectMsg = {
                        role: 'system',
                        content: '编辑被用户拒绝: ' + message.data.filepath,
                        timestamp: new Date().toISOString()
                    };
                    messages.push(rejectMsg);
                    renderMessages();
                } else if (message.data.decision === 'dismissed') {
                    const dismissMsg = {
                        role: 'system',
                        content: '编辑超时自动保存: ' + message.data.filepath,
                        timestamp: new Date().toISOString()
                    };
                    messages.push(dismissMsg);
                    renderMessages();
                }
                break;

            case 'file/approval/request':
                fileApprovalPanel.addApproval(message.data);
                break;

            case 'file/approval/resolved':
                fileApprovalPanel.removeApproval(message.data.approvalId);
                break;

            case 'ai/config':
                settingsController.setAIConfig(message.data);
                break;

            case 'research/status':
                document.getElementById('research-status').textContent = message.data.message;
                break;
            case 'rag/status':
                settingsController.setRagStatus(message.data);
                break;

            case 'organization/status':
                isOrganizationRunning = message.data.state === 'running';
                updateOrganizationUi(message.data.state, message.data.message);
                break;

            case 'ai/workflow_config':
                settingsController.setWorkflowConfig(message.data);
                break;

            case 'ai/start':
                isAiResponding = true;
                activeRequestId = message.data.requestId;
                updateRequestButtons(true);
                break;

            case 'ai/status':
                if (message.data.status === 'RUNNING') {
                    activeRequestId = message.data.requestId;
                    isAiResponding = true;
                    updateRequestButtons(true);
                } else if (!activeRequestId || activeRequestId === message.data.requestId) {
                    if (streamRenderFrame !== null) {
                        cancelAnimationFrame(streamRenderFrame);
                        streamRenderFrame = null;
                    }
                    activeRequestId = null;
                    isAiResponding = false;
                    currentAiResponse = '';
                    currentProgressMsg = '';
                    updateRequestButtons(false);
                    const activeTypingDiv = document.getElementById('typing-message');
                    if (activeTypingDiv) {
                        activeTypingDiv.remove();
                    }
                }
                break;

            case 'ai/progress':
                const newProgressMsg = message.data.message;
                if (newProgressMsg && newProgressMsg !== currentProgressMsg) {
                    currentProgressMsg = newProgressMsg;
                    scheduleStreamRender();
                }
                break;

            case 'ai/stream':
                if (message.data.done) {
                    if (streamRenderFrame !== null) {
                        cancelAnimationFrame(streamRenderFrame);
                        streamRenderFrame = null;
                    }
                    isAiResponding = false;
                    currentAiResponse = '';
                    currentProgressMsg = '';
                    const typingDiv = document.getElementById('typing-message');
                    if (typingDiv) {
                        typingDiv.remove();
                    }
                    renderMessages();
                } else {
                    isAiResponding = true;
                    currentAiResponse += message.data.content;
                    currentProgressMsg = '';
                    scheduleStreamRender();
                }
                break;

            case 'message/appended':
                messages.push(message.data);
                if (message.data.role === 'assistant') {
                    isAiResponding = false;
                    currentAiResponse = '';
                    currentProgressMsg = '';
                }
                renderMessages();
                break;

            case 'ai/error':
                isAiResponding = false;
                activeRequestId = null;
                updateRequestButtons(false);
                currentAiResponse = '';
                currentProgressMsg = '';
                const errorMsg = {
                    role: 'system',
                    content: '错误: ' + message.data.message,
                    timestamp: new Date().toISOString()
                };
                messages.push(errorMsg);
                renderMessages();
                break;

            case 'token/stats':
                // 更新 token 统计显示
                updateTokenStats(message.data);
                break;
        }
    });

    function showStartupError(error) {
        console.error('[AI Writer Webview] Initialization failed', error);
        const container = document.querySelector('.app-container') || document.body;
        const notice = document.createElement('div');
        notice.className = 'startup-error';
        notice.textContent = `AI Writer 界面初始化失败：${error instanceof Error ? error.message : String(error)}`;
        container.prepend(notice);
    }

    function bootstrap() {
        try {
            init();
        } catch (error) {
            showStartupError(error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }

    // 点击页面其他地方关闭下拉菜单
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('sessions-dropdown');
        const sessionsBtn = document.getElementById('sessions-btn');
        if (!dropdown.contains(e.target) && !sessionsBtn.contains(e.target)) {
            closeSessionsDropdown();
        }
        const toolsMenu = document.getElementById('project-tools-menu');
        const toolsBtn = document.getElementById('project-tools-btn');
        if (toolsMenu && toolsBtn && !toolsMenu.contains(e.target) && !toolsBtn.contains(e.target)) {
            closeProjectToolsMenu();
        }
    });
})();
