#!/usr/bin/env node
/**
 * Fails when any page scrolls sideways at a phone width.
 *
 * Run against a running instance with some data in it:
 *   CAIRN_BASE_URL=http://localhost:3000 CAIRN_OPERATOR_EMAIL=... \
 *   CAIRN_OPERATOR_PASSWORD=... npm run check:overflow
 *
 * Boards, tables and the knowledge map scroll inside their own container; the
 * page itself must not. Playwright is not a dependency of the app: install it
 * where you run this (`npm i -D playwright` or a global copy).
 */
const base = process.env.CAIRN_BASE_URL || 'http://localhost:3000'
const email = process.env.CAIRN_OPERATOR_EMAIL
const password = process.env.CAIRN_OPERATOR_PASSWORD
const WIDTHS = (process.env.OVERFLOW_WIDTHS || '320,375').split(',').map(Number)
const PAGES = [
  '/', '/board', '/projects', '/knowledge', '/knowledge/graph', '/search?q=a', '/sessions',
  '/activity', '/settings', '/settings/keys', '/users', '/vitals', '/api-docs', '/changelog',
  ...(process.env.OVERFLOW_EXTRA_PAGES || '').split(',').filter(Boolean),
]

if (!email || !password) {
  console.error('Set CAIRN_OPERATOR_EMAIL and CAIRN_OPERATOR_PASSWORD.')
  process.exit(2)
}

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error('playwright is not installed. Run `npm i -D playwright` first.')
  process.exit(2)
}

const browser = await chromium.launch()
const failures = []
for (const width of WIDTHS) {
  const context = await browser.newContext({ viewport: { width, height: 800 } })
  const login = await context.request.post(`${base}/api/auth/login`, {
    data: { email, password },
    headers: { origin: base },
  })
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`)
  for (const path of PAGES) {
    const page = await context.newPage()
    await page.goto(base + path, { waitUntil: 'networkidle' }).catch(() => {})
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    if (overflow > 0) failures.push(`${path} at ${width}px: ${overflow}px too wide`)
    await page.close()
  }
  await context.close()
}
await browser.close()

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`no page overflow at ${WIDTHS.join(', ')}px across ${PAGES.length} pages`)
