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
// for an executor run (#66). Bundles the MCP SDK so it runs from dist/ alone, with
// no node_modules beside it. Run via the extension host's Node (Electron as
// node), so it needs no separate Node on PATH.
await esbuild.build({
  ...common,
  entryPoints: ['../src/executor/permission-mcp-server.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/permission-mcp-server.js',
});

// Delegation MCP server: a second standalone Node process Claude Code spawns for
// an executor run (#93). Like the permission server, it bundles the MCP SDK so it
// runs from dist/ alone and is launched via the extension host's Node.
await esbuild.build({
  ...common,
  entryPoints: ['../src/executor/delegation-mcp-server.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/delegation-mcp-server.js',
});

// Compaction MCP server: a third standalone Node process Claude Code spawns for the
// orchestrator (#165). Exposes mcp__compact__request so the orchestrator can request
// a context rotation at task boundaries. Bundled like the other MCP servers.
await esbuild.build({
  ...common,
  entryPoints: ['../src/executor/compaction-mcp-server.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/compaction-mcp-server.js',
});

// Webview: browser bundle that pulls in mermaid.
await esbuild.build({
  ...common,
  entryPoints: ['src/webview/main.ts'],
  format: 'iife',
  platform: 'browser',
  outfile: 'dist/webview.js',
});
