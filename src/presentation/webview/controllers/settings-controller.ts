import * as vscode from 'vscode';
import { AIManager } from '../../../ai';
import { WebviewProtocol } from '../../../webview/protocol';

export class SettingsController {
  constructor(
    private readonly ai: AIManager,
    private readonly protocol: WebviewProtocol,
    private readonly buildRagIndex: () => Promise<void>
  ) {}

  register(): void {
    this.protocol.onMessage('ai/get_config', async () => this.sendAIConfig());
    this.protocol.onMessage('ai/update_config', async data => {
      await this.ai.updateConfig(data);
      this.sendAIConfig();
      vscode.window.showInformationMessage('AI 配置已更新');
    });
    this.protocol.onMessage('rag/get_status', async () => {
      this.protocol.sendMessage({ type: 'rag/status', data: this.ai.rag.status });
    });
    this.protocol.onMessage('rag/build_index', async () => this.buildRagIndex());
    this.protocol.onMessage('ai/get_workflow_config', async () => this.sendWorkflowConfig());
    this.protocol.onMessage('ai/update_workflow_config', async data => {
      await this.ai.updateWorkflowConfig(data);
      this.sendWorkflowConfig();
      vscode.window.showInformationMessage('工作流配置已更新');
    });
  }

  private sendAIConfig(): void {
    this.protocol.sendMessage({ type: 'ai/config', data: this.ai.displayConfig });
  }

  private sendWorkflowConfig(): void {
    this.protocol.sendMessage({
      type: 'ai/workflow_config',
      data: {
        workflowConfig: this.ai.displayWorkflowConfig,
        registeredWorkers: this.ai.getRegisteredWorkers(),
        isParserConfigured: this.ai.isParserConfigured
      }
    });
  }
}
