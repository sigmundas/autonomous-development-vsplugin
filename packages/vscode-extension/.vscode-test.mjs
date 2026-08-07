import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.spec.js',
  version: 'stable',
  launchArgs: [
    '--user-data-dir',
    path.join(os.tmpdir(), 'autodev-vscode-test-user-data')
  ],
  mocha: {
    ui: 'bdd',
    timeout: 60000
  }
});
