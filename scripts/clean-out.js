const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.resolve(projectRoot, 'out');

if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== 'out') {
  throw new Error(`Refusing to clean unexpected output directory: ${outputDirectory}`);
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
