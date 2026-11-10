import * as assert from 'assert';
import { FileApprovalService } from '../features/file-approval';

suite('File approval service', () => {
  test('publishes a request and resolves the matching approval', async () => {
    const service = new FileApprovalService();
    let approvalId = '';
    const unsubscribe = service.onApprovalRequested(request => {
      approvalId = request.approvalId;
      assert.strictEqual(request.filepath, 'chapter.md');
      assert.strictEqual(request.action, 'create');
      assert.strictEqual(request.originalCharacters, 0);
      assert.strictEqual(request.proposedCharacters, 7);
    });

    const resultPromise = service.confirmFileWrite('chapter.md', 'create', '', 'content');

    assert.ok(approvalId);
    assert.strictEqual(service.getPendingApprovals().length, 1);
    service.resolveApproval(approvalId, true);
    assert.strictEqual(await resultPromise, true);
    assert.deepStrictEqual(service.getPendingApprovals(), []);
    unsubscribe();
  });

  test('rejects immediately when the operation is already aborted', async () => {
    const service = new FileApprovalService();
    const controller = new AbortController();
    controller.abort();

    const approved = await service.confirmFileWrite('chapter.md', 'edit', 'old', 'new', controller.signal);

    assert.strictEqual(approved, false);
    assert.deepStrictEqual(service.getPendingApprovals(), []);
  });

  test('rejects and clears a pending approval when the operation is aborted', async () => {
    const service = new FileApprovalService();
    const controller = new AbortController();
    let resolvedApproval: { id: string; approved: boolean } | undefined;
    service.onApprovalResolved((id, approved) => {
      resolvedApproval = { id, approved };
    });

    const resultPromise = service.confirmFileWrite('chapter.md', 'edit', 'old', 'new', controller.signal);
    const [request] = service.getPendingApprovals();
    controller.abort();

    assert.strictEqual(await resultPromise, false);
    assert.deepStrictEqual(resolvedApproval, { id: request.approvalId, approved: false });
    assert.deepStrictEqual(service.getPendingApprovals(), []);
  });

});
