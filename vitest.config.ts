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
  },
})
