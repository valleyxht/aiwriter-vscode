(function(global) {
    'use strict';

    global.AIWriterFileApproval = {
        create({ sendMessage, escapeHtml }) {
            let pendingDiffs = [];
            let pendingApprovals = [];

            function render() {
                const panel = document.getElementById('diff-panel');
                const list = document.getElementById('diff-list');
                if (!panel || !list) {return;}
                if (!pendingDiffs.length && !pendingApprovals.length) {
                    panel.classList.add('hidden');
                    return;
                }
                panel.classList.remove('hidden');
                list.innerHTML = '';

                pendingApprovals.forEach(approval => {
                    const item = document.createElement('div');
                    item.className = 'diff-item file-approval-item';
                    const actionLabel = approval.action === 'create' ? '新建文件' : '修改文件';
                    const summary = approval.action === 'create'
                        ? `${approval.proposedLines} 行 · ${approval.proposedCharacters} 字符`
                        : `${approval.originalLines} → ${approval.proposedLines} 行 · ${approval.originalCharacters} → ${approval.proposedCharacters} 字符`;
                    item.innerHTML = `
                        <div class="file-approval-info">
                            <div class="file-approval-title-row">
                                <span class="file-approval-badge">${escapeHtml(actionLabel)}</span>
                                <span class="diff-filepath" title="${escapeHtml(approval.filepath)}">${escapeHtml(approval.displayPath)}</span>
                            </div>
                            <div class="file-approval-summary">AI 请求写入 · ${escapeHtml(summary)}</div>
                        </div>
                        <div class="diff-actions">
                            <button class="diff-btn file-approval-reject" data-approval-id="${escapeHtml(approval.approvalId)}">拒绝</button>
                            <button class="diff-btn diff-btn-accept file-approval-accept" data-approval-id="${escapeHtml(approval.approvalId)}">允许一次</button>
                        </div>`;
                    list.appendChild(item);
                });

                pendingDiffs.forEach(diff => {
                    const item = document.createElement('div');
                    item.className = 'diff-item';
                    const filename = diff.filepath.split(/[/\\]/).pop();
                    item.innerHTML = `
                        <span class="diff-filepath" title="${escapeHtml(diff.filepath)}">${escapeHtml(filename)}</span>
                        <div class="diff-actions">
                            <button class="diff-btn diff-btn-accept" data-filepath="${escapeHtml(diff.filepath)}">接受</button>
                            <button class="diff-btn diff-btn-reject" data-filepath="${escapeHtml(diff.filepath)}">拒绝</button>
                        </div>`;
                    list.appendChild(item);
                });

                list.querySelectorAll('.diff-btn-accept[data-filepath]').forEach(button => {
                    button.onclick = event => decideDiff(event.currentTarget.dataset.filepath, true);
                });
                list.querySelectorAll('.diff-btn-reject').forEach(button => {
                    button.onclick = event => decideDiff(event.currentTarget.dataset.filepath, false);
                });
                list.querySelectorAll('.file-approval-accept').forEach(button => {
                    button.onclick = event => decideApproval(event.currentTarget.dataset.approvalId, true);
                });
                list.querySelectorAll('.file-approval-reject').forEach(button => {
                    button.onclick = event => decideApproval(event.currentTarget.dataset.approvalId, false);
                });
            }

            function decideDiff(filepath, accepted) {
                sendMessage(accepted ? 'diff/accept' : 'diff/reject', { filepath });
                pendingDiffs = pendingDiffs.filter(item => item.filepath !== filepath);
                render();
            }

            function decideApproval(approvalId, approved) {
                sendMessage('file/approval/respond', { approvalId, approved });
                pendingApprovals = pendingApprovals.filter(item => item.approvalId !== approvalId);
                render();
            }

            return {
                addDiff(filepath) {
                    if (filepath && !pendingDiffs.some(item => item.filepath === filepath)) {
                        pendingDiffs.push({ filepath });
                    }
                    render();
                },
                removeDiff(filepath) {
                    pendingDiffs = pendingDiffs.filter(item => item.filepath !== filepath);
                    render();
                },
                addApproval(approval) {
                    if (!pendingApprovals.some(item => item.approvalId === approval.approvalId)) {
                        pendingApprovals.push(approval);
                    }
                    render();
                },
                removeApproval(approvalId) {
                    pendingApprovals = pendingApprovals.filter(item => item.approvalId !== approvalId);
                    render();
                },
                rejectAll() {
                    pendingApprovals.forEach(item => {
                        sendMessage('file/approval/respond', { approvalId: item.approvalId, approved: false });
                    });
                    pendingApprovals = [];
                    pendingDiffs = [];
                    render();
                }
            };
        }
    };
})(window);
