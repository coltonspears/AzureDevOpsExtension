// Bundles the extension host code (Node) and the webview UIs (browser) with esbuild.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });

/** Copies the codicon font + stylesheet so webviews can render VS Code icons. */
function copyCodicons() {
  const source = dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
  const target = join('dist', 'codicons');
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'codicon.css'), join(target, 'codicon.css'));
  cpSync(join(source, 'codicon.ttf'), join(target, 'codicon.ttf'));
}

const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webviews = {
  ...shared,
  entryPoints: {
    access: 'src/webview-ui/access.ts',
    workItem: 'src/webview-ui/workItem.ts',
    pullRequest: 'src/webview-ui/pullRequest.ts',
    createPullRequest: 'src/webview-ui/createPullRequest.ts',
    styles: 'src/webview-ui/styles.css',
  },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

copyCodicons();

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webviews)]);
  await Promise.all(contexts.map(c => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webviews)]);
}
