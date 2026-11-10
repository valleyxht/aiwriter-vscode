const { spawnSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const report = join(root, '.aiwriter', 'evaluations');
mkdirSync(report, { recursive: true });
const live = process.argv.includes('--live');
const env = {
    ...process.env,
    AIWRITER_EVAL_LIVE: live ? '1' : '0',
    PROMPTFOO_DISABLE_TELEMETRY: '1',
    PROMPTFOO_DISABLE_UPDATE: '1',
};
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'exec', '--yes', '--package',
    'promptfoo@0.125.1', '--', 'promptfoo', 'eval', '-c', join(__dirname, 'promptfooconfig.json'),
    '--no-cache', '--max-concurrency', '1', '--output', join(report, `agent-${live ? 'live' : 'smoke'}.json`),
], { cwd: root, env, stdio: 'inherit' });
if (result.error) { console.error(result.error.message); }
process.exitCode = result.status ?? 1;
