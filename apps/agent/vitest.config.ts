import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const ciPath = resolve(
  __dirname,
  'node_modules/bedrock-agentcore/dist/src/tools/code-interpreter/index.js',
)

export default defineConfig({
  test: { globals: true, environment: 'node' },
  resolve: {
    alias: {
      // bedrock-agentcore@0.2.4 has a broken root export (dist/src/index.js is missing).
      // Alias both the root and subpath imports to the code-interpreter entry point,
      // so that vi.mock('bedrock-agentcore', ...) and subpath imports all resolve.
      'bedrock-agentcore/code-interpreter': ciPath,
      'bedrock-agentcore': ciPath,
    },
  },
})
