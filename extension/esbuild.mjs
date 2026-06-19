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

// Permission-prompt MCP server: a standalone Node process Claude Code spawns
// for a worker run (#66). Bundles the MCP SDK so it runs from dist/ alone, with
// no node_modules beside it. Run via the extension host's Node (Electron as
// node), so it needs no separate Node on PATH.
await esbuild.build({
  ...common,
  entryPoints: ['../src/worker/permission-mcp-server.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/permission-mcp-server.js',
});

// Webview: browser bundle that pulls in mermaid.
await esbuild.build({
  ...common,
  entryPoints: ['src/webview/main.ts'],
  format: 'iife',
  platform: 'browser',
  outfile: 'dist/webview.js',
});
