import * as assert from 'assert';
import { AIManager } from '../ai';

suite('AIManager lifecycle', () => {
  test('serializes simultaneous saves instead of rejecting the workflow settings', async () => {
    const manager = Object.create(AIManager.prototype) as any;
    manager._activeRequests = new Map();
    const events: string[] = [];
    let finish!: () => void;
    const first = manager._runConfigurationChange(async () => {
      events.push('main');
      await new Promise<void>(resolve => { finish = resolve; });
      events.push('saved');
    });
    const second = manager._runConfigurationChange(async () => { events.push('workflow'); });
    assert.deepStrictEqual(events, ['main']);
    finish();
    await Promise.all([first, second]);
    assert.deepStrictEqual(events, ['main', 'saved', 'workflow']);
  });
  test('releases the previous engine when configuration becomes unavailable', () => {
    let disposeCalls = 0;
    const manager = Object.create(AIManager.prototype) as any;
    manager._engine = { dispose: () => disposeCalls++ };
    manager._configManager = { isConfigured: () => false };

    manager._initEngine();

    assert.strictEqual(manager._engine, undefined);
    assert.strictEqual(disposeCalls, 1);
  });

  test('rejects configuration changes while a request is active', async () => {
    const manager = Object.create(AIManager.prototype) as any;
    manager._disposed = false;
    manager._configurationChangeInProgress = false;
    manager._activeRequests = new Map([['request-1', new AbortController()]]);

    await assert.rejects(
      manager._runConfigurationChange(async () => undefined),
      /正在运行的 AI 请求/
    );
  });

  test('blocks new requests until a configuration change finishes', async () => {
    const manager = Object.create(AIManager.prototype) as any;
    manager._disposed = false;
    manager._configurationChangeInProgress = false;
    manager._activeRequests = new Map();

    let finish!: () => void;
    const pending = manager._runConfigurationChange(
      () => new Promise<void>(resolve => { finish = resolve; })
    );

    assert.match(manager._requestUnavailableReason(), /配置正在更新/);
    finish();
    await pending;
    assert.strictEqual(manager._requestUnavailableReason(), undefined);
  });
});
