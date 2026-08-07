import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/mcp/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist/mcp',
  noExternal: ['@modelcontextprotocol/sdk', 'zod']
});
