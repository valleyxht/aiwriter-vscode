const fs = require('fs');
const path = require('path');

const sourceDir = path.join(__dirname, '..', 'src', 'webview', 'html');
const targetDir = path.join(__dirname, '..', 'out', 'webview');
const vendorFiles = [
  {
    source: path.join(__dirname, '..', 'node_modules', 'marked', 'lib', 'marked.umd.js'),
    target: path.join(targetDir, 'vendor', 'marked.umd.js')
  }
];

function copyRecursiveSync(source, target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const entries = fs.readdirSync(source);

  for (const entry of entries) {
    const sourcePath = path.join(source, entry);
    const targetPath = path.join(target, entry);

    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
      copyRecursiveSync(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

try {
  console.log('Copying webview files from', sourceDir, 'to', targetDir);
  copyRecursiveSync(sourceDir, targetDir);
  for (const vendorFile of vendorFiles) {
    fs.mkdirSync(path.dirname(vendorFile.target), { recursive: true });
    fs.copyFileSync(vendorFile.source, vendorFile.target);
  }
  console.log('Webview files copied successfully');
} catch (error) {
  console.error('Error copying webview files:', error);
  process.exit(1);
}
