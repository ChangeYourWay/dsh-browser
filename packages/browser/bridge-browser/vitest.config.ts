import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

/**
 * Standalone test runner. The plugin lives OUTSIDE the DeepSeek Harness SDK
 * workspace (independent-repository layout, see the root README); all
 * @deepseek-ai/dsh-* / @cordisjs/* / cordis imports resolve to the HOST SDK's
 * source through the HOST tsconfig.base.json paths (vite-tsconfig-paths
 * resolves paths relative to the projects file, not along the extends chain,
 * so the base file itself is the project root — identical to the host's own
 * vitest config).
 */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['../../../../tsconfig.base.json'] })],
  test: {
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/setup-invariant.ts'],
  },
})
