import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

// Extension host: Node/CommonJS, with the vscode module provided by the runtime.
await esbuild.build({
  ...common,
  entryPoints: ['src/extension.ts'],
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
  outfile: 'dist/extension.js',
});

// Webview: browser bundle that pulls in mermaid.
await esbuild.build({
  ...common,
  entryPoints: ['src/webview/main.ts'],
  format: 'iife',
  platform: 'browser',
  outfile: 'dist/webview.js',
});
