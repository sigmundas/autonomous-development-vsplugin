import { build, context } from 'esbuild';
import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const dist = join(here, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/** Extension host bundle: CommonJS, Node platform, vscode external. */
const hostOptions = {
  entryPoints: [join(here, 'src/extension.ts')],
  bundle: true,
  outfile: join(dist, 'extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info'
};

/** Dashboard webview bundle: browser IIFE, no Node/VS Code access. */
const webviewOptions = {
  entryPoints: [join(here, 'src/dashboard/webview/main.ts')],
  bundle: true,
  outfile: join(dist, 'webview', 'main.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info'
};

/** Configuration webview bundle: separate output directory. */
const configWebviewOptions = {
  entryPoints: [join(here, 'src/config/webview/main.ts')],
  bundle: true,
  outfile: join(dist, 'configWebview', 'main.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info'
};

function copyStaticAssets() {
  mkdirSync(join(dist, 'webview'), { recursive: true });
  copyFileSync(join(here, 'src/dashboard/webview/styles.css'), join(dist, 'webview', 'styles.css'));
  mkdirSync(join(dist, 'configWebview'), { recursive: true });
  copyFileSync(
    join(here, 'src/config/webview/styles.css'),
    join(dist, 'configWebview', 'styles.css')
  );
}

if (watch) {
  const hostCtx = await context(hostOptions);
  const webviewCtx = await context(webviewOptions);
  const configCtx = await context(configWebviewOptions);
  copyStaticAssets();
  await Promise.all([hostCtx.watch(), webviewCtx.watch(), configCtx.watch()]);
  console.log('[esbuild] watching…');
} else {
  await Promise.all([build(hostOptions), build(webviewOptions), build(configWebviewOptions)]);
  copyStaticAssets();
  console.log('[esbuild] build complete');
}
