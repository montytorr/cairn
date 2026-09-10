import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
  test: {
    // jsdom, because Tiptap's Editor needs a DOM even headless.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
