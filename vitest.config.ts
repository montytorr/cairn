import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
  test: {
    // jsdom, because Tiptap's Editor needs a DOM even headless.
    environment: 'jsdom',
    // .tsx too: the icon tests server-render JSX to catch the hoistable
    // `<title>` trap, which is only observable through the renderer.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The CLI tests inherit this environment; run from a Herdr pane, they would
    // label or clear that real pane.
    env: { HERDR_PANE_ID: '', HC_TERMINAL_ID: '' },
  },
})
