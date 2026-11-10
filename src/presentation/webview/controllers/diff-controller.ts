import { DiffManager } from '../../../core/diff';
import { WebviewProtocol } from '../../../webview/protocol';

export class DiffController {
  constructor(
    private readonly diffs: DiffManager,
    private readonly protocol: WebviewProtocol
  ) {}

  register(): void {
    this.protocol.onMessage('diff/accept', async data => {
      await this.diffs.acceptDiff(data.filepath);
      this.protocol.sendMessage({
        type: 'diff/decision',
        data: { filepath: data.filepath, decision: 'accepted' }
      });
    });
    this.protocol.onMessage('diff/reject', async data => {
      await this.diffs.rejectDiff(data.filepath);
      this.protocol.sendMessage({
        type: 'diff/decision',
        data: { filepath: data.filepath, decision: 'rejected' }
      });
    });
  }
}
