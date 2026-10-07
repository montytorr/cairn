#!/usr/bin/env node
/**
 * Audits every form control in the product against one standard, and fails on
 * the ones that drift from it.
 *
 * Run against a running instance with some data in it (a project with tasks,
 * a knowledge entry, a session, a second user) and an empty project:
 *   CAIRN_BASE_URL=http://localhost:3000 CAIRN_OPERATOR_EMAIL=... \
 *   CAIRN_OPERATOR_PASSWORD=... npm run audit:controls
 *
 * For each page, and for each popover, dialog and editor that page opens, in
 * both themes and at a desktop and a phone width, it records every control's
 * computed height, font, border, background, appearance and padding, then
 * flags what breaks the standard:
 *
 *   - a field, select or button whose height is neither the standard (40-44px)
 *     nor the one compact size (36px)
 *   - a font family or size that is not the product's (a bare native control)
 *   - a dashed, dotted or missing border; a native select arrow
 *   - a disabled control whose text is under 4.5:1, or that has no reason
 *     written in it (an empty disabled select)
 *   - select text that is cut off with no ellipsis
 *   - controls in one row that do not share a height and a centre line
 *   - a checkbox or radio with a hit area under 24px
 *   - a field under 16px on a touch screen, which makes iOS zoom the page
 *
 * Environment:
 *   AUDIT_WIDTHS     "1440,375"   AUDIT_THEMES  "dark,light"
 *   AUDIT_OUT        write the full record as JSON to this path
 *   AUDIT_SHOTS      a directory: also save a screenshot of every state
 *   AUDIT_ONLY       only states whose name contains this text
 *
 * Playwright is not a dependency of the app: `npm i --no-save playwright`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const base = process.env.CAIRN_BASE_URL || 'http://localhost:3000'
const email = process.env.CAIRN_OPERATOR_EMAIL
const password = process.env.CAIRN_OPERATOR_PASSWORD
const WIDTHS = (process.env.AUDIT_WIDTHS || '1440,375').split(',').map(Number)
const THEMES = (process.env.AUDIT_THEMES || 'dark,light').split(',')
const OUT = process.env.AUDIT_OUT
const SHOTS = process.env.AUDIT_SHOTS
const ONLY = process.env.AUDIT_ONLY

if (!email || !password) {
  console.error('Set CAIRN_OPERATOR_EMAIL and CAIRN_OPERATOR_PASSWORD.')
  process.exit(2)
}

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error('playwright is not installed. Run `npm i --no-save playwright` first.')
  process.exit(2)
}

const STANDARD = { min: 39.5, max: 44.5 }
const COMPACT = { min: 35.5, max: 36.5 }
const MIN_HIT = 24
const MIN_CONTRAST = 4.5

const firstProjectKey = process.env.AUDIT_PROJECT || 'DEMO'
const emptyProjectKey = process.env.AUDIT_EMPTY_PROJECT || 'EMPTY'
const knowledgeSlug = process.env.AUDIT_KNOWLEDGE || 'fact-1'

/* ---------------------------------------------------------------------------
   States: a page, and what is opened on it. Every step is tolerant: a trigger
   that is not on this instance's data is reported, not fatal.
   ------------------------------------------------------------------------ */

const click = (name, opts = {}) => async (page) => {
  const target = opts.role === 'any' ? page.getByText(name, { exact: false }).first() : page.getByRole(opts.role || 'button', { name, exact: opts.exact ?? false }).first()
  await target.click({ timeout: 4000 })
  await page.waitForTimeout(350)
}
const press = (key) => async (page) => { await page.keyboard.press(key); await page.waitForTimeout(350) }
const selector = (css, opts = {}) => async (page) => {
  await page.locator(css).first().click({ timeout: 4000, ...opts })
  await page.waitForTimeout(350)
}
const choose = (css, value) => async (page) => {
  await page.locator(css).first().selectOption(value, { timeout: 4000 })
  await page.waitForTimeout(500)
}

// A pairing request, made when the state is reached: it expires in ten minutes.
const pairingPath = async () => {
  const res = await fetch(`${base}/api/v1/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'audit-laptop', runtimes: ['claude', 'codex'] }),
  }).catch(() => null)
  const code = res?.ok ? (await res.json()).data?.userCode : null
  return code ? `/connect/${code}` : '/connect'
}

const P = firstProjectKey
const E = emptyProjectKey
const STATES = [
  { name: 'login', path: '/login', anon: true },
  {
    name: 'login-error', path: '/login', anon: true,
    steps: [async (page) => {
      await page.locator('input[type=email], input[name=email]').first().fill('nobody@example.com')
      await page.locator('input[type=password]').first().fill('wrong-password-123')
      await page.locator('button[type=submit]').first().click()
      await page.waitForTimeout(900)
    }],
  },
  { name: 'home', path: '/' },
  { name: 'home-new-task', path: '/', steps: [click('New task')] },
  { name: 'home-new-task-open-fields', path: '/', steps: [click('New task'), async (page) => {
    for (const label of ['More', 'Options', 'Details']) await page.getByRole('button', { name: label }).first().click({ timeout: 800 }).catch(() => {})
    await page.waitForTimeout(300)
  }] },
  { name: 'home-filter-assignee', path: '/', steps: [click('Filter by Assignee')] },
  { name: 'home-labels', path: '/', steps: [click('Labels on')], wideOnly: true },
  { name: 'home-row-selected', path: '/', steps: [click('Select Task', { role: 'checkbox' })] },
  { name: 'home-command-palette', path: '/', steps: [press('Control+k')] },
  { name: 'home-mobile-nav', path: '/', steps: [click('navigation', { role: 'button' })], narrowOnly: true },
  { name: 'board', path: '/board' },
  { name: 'board-filter-project', path: '/board', steps: [click('Filter by Project')] },
  { name: 'board-filter-label', path: '/board', steps: [click('Filter by Label')] },
  { name: 'projects', path: '/projects' },
  { name: 'projects-new', path: '/projects', steps: [click('New project')] },
  { name: 'projects-rename', path: '/projects', steps: [click(`Rename ${P}`)] },
  { name: 'projects-change-key', path: '/projects', steps: [click(`Change key of ${P}`)] },
  { name: 'projects-delete-confirm', path: '/projects', steps: [click(`Delete ${P}`)] },
  { name: 'project-list', path: `/projects/${P}` },
  { name: 'project-actions', path: `/projects/${P}`, steps: [click('Project actions')] },
  { name: 'project-new-task', path: `/projects/${P}`, steps: [click('New task')] },
  { name: 'project-filter-assignee', path: `/projects/${P}`, steps: [click('Filter by Assignee')] },
  { name: 'project-board', path: `/projects/${P}?view=board` },
  { name: 'project-empty', path: `/projects/${E}` },
  { name: 'project-empty-new-task', path: `/projects/${E}`, steps: [click('New task')] },
  { name: 'task', path: `/projects/${P}/tasks/1` },
  { name: 'task-edit', path: `/projects/${P}/tasks/1`, steps: [click('Edit', { exact: true })] },
  { name: 'task-subtask', path: `/projects/${P}/tasks/1`, steps: [click('Add sub-task')] },
  // The properties column is not rendered on a phone, so these open nothing there.
  { name: 'task-labels', path: `/projects/${P}/tasks/1`, steps: [click('Labels on')], wideOnly: true },
  { name: 'task-due-date', path: `/projects/${P}/tasks/1`, steps: [click('Nov 2026')], wideOnly: true },
  { name: 'task-blocks', path: `/projects/${P}/tasks/1`, steps: [click('Add a task that blocks')], wideOnly: true },
  { name: 'task-comment-typed', path: `/projects/${P}/tasks/1`, steps: [async (page) => { await page.getByPlaceholder(/comment/i).first().fill('A comment being written') }] },
  { name: 'task-note-typed', path: `/projects/${P}/tasks/1`, steps: [async (page) => { await page.getByPlaceholder(/try, find/i).first().fill('A note being written') }] },
  { name: 'task-resolve', path: `/projects/${P}/tasks/1`, steps: [choose('select:has(option[value="done"])', 'done')], wideOnly: true },
  { name: 'knowledge', path: '/knowledge' },
  { name: 'knowledge-detail', path: `/knowledge/${knowledgeSlug}` },
  { name: 'knowledge-edit', path: `/knowledge/${knowledgeSlug}`, steps: [click('Edit', { exact: true })] },
  { name: 'knowledge-graph', path: '/knowledge/graph' },
  { name: 'search', path: '/search?q=a' },
  { name: 'search-empty', path: '/search?q=zzzzzzzzzzzz' },
  { name: 'sessions', path: '/sessions' },
  { name: 'sessions-open', path: '/sessions', steps: [click('Seed a session', { role: 'any' })] },
  { name: 'activity', path: '/activity' },
  { name: 'settings', path: '/settings' },
  { name: 'settings-new-entity', path: '/settings', steps: [click('New entity')] },
  { name: 'settings-rename', path: '/settings', steps: [click('Rename', { exact: true })] },
  { name: 'settings-keys', path: '/settings/keys' },
  { name: 'users', path: '/users' },
  { name: 'users-open', path: '/users', steps: [selector('summary')] },
  { name: 'users-keys', path: '/users', steps: [selector('summary'), click('Manage agent keys')] },
  { name: 'connect', path: '/connect' },
  { name: 'connect-approve', path: pairingPath },
  { name: 'vitals', path: '/vitals' },
  { name: 'api-docs', path: '/api-docs' },
  { name: 'changelog', path: '/changelog' },
]

/* ---------------------------------------------------------------------------
   The measurement, run in the page. Self-contained: it is serialised.
   ------------------------------------------------------------------------ */

const measure = ({ STANDARD, COMPACT, MIN_HIT, MIN_CONTRAST }) => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const cx = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = (css) => {
    cx.clearRect(0, 0, 1, 1)
    cx.fillStyle = '#000'
    cx.fillStyle = css
    cx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const over = (top, under) => {
    const a = top[3]
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1)
  }
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const backdrop = (el) => {
    const layers = []
    for (let n = el; n; n = n.parentElement) layers.push(rgba(getComputedStyle(n).backgroundColor))
    let color = rgba(getComputedStyle(document.documentElement).colorScheme === 'dark' ? '#000' : '#fff')
    for (const layer of layers.reverse()) color = over(layer, color)
    return color
  }
  const opacityOf = (el) => {
    let o = 1
    for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity)
    return o
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }
  const label = (el) => (
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    (el.labels && el.labels[0]?.textContent) ||
    el.textContent ||
    el.getAttribute('title') ||
    el.name ||
    ''
  ).trim().replace(/\s+/g, ' ').slice(0, 40)

  const TEXTY = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textarea'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox' || t === 'radio' || t === 'file') return t
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
      if (t === 'color') return 'color'
      if (t === 'range' || t === 'hidden') return null
      return TEXTY.has(t) ? 'field' : 'field'
    }
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button'
    return null
  }

  const selector = 'input, select, textarea, button, [role=button]'
  const els = [...document.querySelectorAll(selector)].filter((el) => {
    // The API reference is a third-party application with its own controls.
    if (el.closest('.scalar-app, [id=api-reference]')) return false
    if (!visible(el)) return false
    const role = el.getAttribute('role')
    return !role?.startsWith('menuitem') && role !== 'option' && role !== 'tab'
  })

  const records = []
  for (const el of els) {
    let kind = kindOf(el)
    if (!kind) continue
    // A select laid invisibly over a badge, chip or row: its face is what is
    // seen and pressed, so that is what is measured.
    const invisible = Number(getComputedStyle(el).opacity) === 0
    // A field that is only there to anchor the platform's picker, under a button.
    if (invisible && kind !== 'select' && kind !== 'button') continue
    const overlay = kind === 'select' && invisible
    if (overlay) kind = 'inline-select'
    const s = getComputedStyle(overlay ? el.parentElement : el)
    const r = (overlay ? el.parentElement : el).getBoundingClientRect()
    const bw = parseFloat(s.borderTopWidth) || 0
    const bg = rgba(s.backgroundColor)
    // A band that spans the page (a collapsible group header) or a card (a
    // draggable board card) is a surface that happens to be pressable, not a button.
    // A disclosure row names what it opens, so its text runs long.
    const row = kind === 'button' && (r.width > 600 || r.height > 70 || el.classList.contains('group-band') ||
      (el.hasAttribute('aria-expanded') && (el.textContent || '').trim().length > 20))
    const boxed = (bw > 0 || bg[3] > 0.02) && !row
    const submit = el.getAttribute('type') === 'submit'
    const iconOnly = kind === 'button' && !(el.textContent || '').trim()
    const rec = {
      kind,
      overlay,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      label: label(el),
      boxed,
      iconOnly,
      height: Math.round(r.height * 10) / 10,
      width: Math.round(r.width),
      fontSize: s.fontSize,
      fontFamily: s.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      borderStyle: s.borderTopStyle,
      borderWidth: s.borderTopWidth,
      borderColor: s.borderTopColor,
      radius: s.borderTopLeftRadius,
      background: s.backgroundColor,
      appearance: s.appearance,
      padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
      color: s.color,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      flags: [],
    }

    if (el.disabled === true && !overlay) {
      const fg = rgba(s.color)
      const ground = backdrop(el)
      const eff = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], over(bg, ground))
      rec.disabledContrast = Math.round(ratio(eff, over(bg[3] > 0 ? [bg[0], bg[1], bg[2], bg[3] * opacityOf(el)] : [0, 0, 0, 0], ground)) * 100) / 100
    }

    if (kind === 'field' || kind === 'select' || kind === 'textarea') {
      rec.textOverflow = s.textOverflow
      const ph = getComputedStyle(el, '::placeholder')
      if (kind !== 'select' && el.getAttribute('placeholder')) {
        const ground = over(bg, backdrop(el))
        rec.placeholderContrast = Math.round(ratio(over(rgba(ph.color), ground), ground) * 100) / 100
      }
    }

    if (kind === 'select') {
      const opt = el.selectedOptions[0]
      const text = opt ? opt.textContent.trim() : ''
      cx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
      const room = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
      rec.selectedText = text
      rec.clipped = cx.measureText(text).width > room + 1
      rec.enabledOptions = [...el.options].filter((o) => !o.disabled).length
      rec.emptyDisabled = el.disabled && (text === '' || el.options.length === 0)
    }
    if (kind === 'button' && s.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1) rec.clipped = true

    if (kind === 'checkbox' || kind === 'radio') {
      const host = el.closest('label, [role^=menuitem]') || el
      const lr = host.getBoundingClientRect()
      rec.hit = `${Math.round(Math.max(r.width, lr.width))}x${Math.round(Math.max(r.height, lr.height))}`
      rec.hitMin = Math.round(Math.min(Math.max(r.width, lr.width), Math.max(r.height, lr.height)) * 10) / 10
    }
    rec.el = el
    records.push(rec)
  }

  const inBand = (h, band) => h >= band.min && h <= band.max
  const coarse = matchMedia('(hover: none) and (pointer: coarse)').matches
  const sized = new Set(['field', 'select', 'textarea', 'file'])
  const modeOf = (key, list) => {
    const n = new Map()
    for (const v of list) n.set(v[key], (n.get(v[key]) || 0) + 1)
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  }
  const family = getComputedStyle(document.body).fontFamily.split(',')[0].replace(/["']/g, '').trim()

  for (const rec of records) {
    const f = (code) => rec.flags.push(code)
    if (rec.kind === 'inline-select') {
      if (rec.boxed && !inBand(rec.height, STANDARD) && !inBand(rec.height, COMPACT)) f(`picker face ${rec.height}px (want 40-44, or 36 compact)`)
      if (!rec.boxed && rec.height < MIN_HIT) f(`picker target ${rec.height}px (want ${MIN_HIT}px)`)
      if (rec.boxed && rec.borderStyle !== 'solid') f(`border ${rec.borderStyle}`)
      continue
    }
    const checked = sized.has(rec.kind) || (rec.kind === 'button' && (rec.boxed || rec.type === 'submit'))
    if (checked && rec.kind !== 'textarea' && rec.kind !== 'file' && !inBand(rec.height, STANDARD) && !inBand(rec.height, COMPACT)) f(`height ${rec.height}px (want 40-44, or 36 compact)`)
    if (checked && rec.fontFamily !== family) f(`font ${rec.fontFamily} (want ${family})`)
    if (checked && rec.kind !== 'file' && rec.borderStyle !== 'solid' && (rec.kind !== 'button' || rec.boxed) && rec.borderStyle !== 'none') f(`border ${rec.borderStyle}`)
    if ((rec.kind === 'field' || rec.kind === 'select' || rec.kind === 'textarea') && rec.borderStyle === 'none') f('no border')
    if (rec.kind === 'select' && rec.appearance !== 'none') f(`native select arrow (appearance ${rec.appearance})`)
    if (rec.kind === 'select' && rec.clipped && rec.textOverflow !== 'ellipsis') f('select text cut off, no ellipsis')
    if (rec.kind === 'select' && rec.emptyDisabled) f('disabled select with no text saying why')
    if (rec.disabled && rec.disabledContrast !== undefined && rec.disabledContrast < MIN_CONTRAST) f(`disabled text ${rec.disabledContrast}:1 (want ${MIN_CONTRAST})`)
    if (rec.disabled && rec.borderStyle !== 'solid' && rec.borderStyle !== 'none') f(`disabled border ${rec.borderStyle}`)
    if (rec.placeholderContrast !== undefined && rec.placeholderContrast < MIN_CONTRAST) f(`placeholder ${rec.placeholderContrast}:1`)
    if ((rec.kind === 'checkbox' || rec.kind === 'radio') && rec.hitMin < MIN_HIT) f(`hit area ${rec.hit} (want ${MIN_HIT}px)`)
    if (coarse && (rec.kind === 'field' || rec.kind === 'select' || rec.kind === 'textarea') && parseFloat(rec.fontSize) < 16) f(`touch font ${rec.fontSize} (iOS zooms under 16px)`)
  }

  // Controls on one row share a height and a centre line.
  const rectOf = (rec) => (rec.overlay ? rec.el.parentElement : rec.el).getBoundingClientRect()
  const rects = records.map(rectOf)
  records.forEach((rec, i) => {
    const rowKind = (r) => r.kind === 'field' || r.kind === 'select' || r.kind === 'button' || (r.kind === 'inline-select' && r.boxed)
    if (!rowKind(rec) || (rec.kind === 'button' && !rec.boxed && rec.type !== 'submit')) return
    let scope = rec.el.parentElement
    for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
      const mates = records.filter((other, j) => {
        if (j === i || !scope.contains(other.el) || !rowKind(other) || (other.kind === 'button' && !other.boxed && other.type !== 'submit')) return false
        const a = rects[i], b = rects[j]
        const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        const disjoint = a.right <= b.left + 1 || b.right <= a.left + 1
        return overlap > Math.min(a.height, b.height) * 0.5 && disjoint
      })
      if (mates.length === 0) continue
      const a = rects[i]
      const off = mates.find((m) => {
        const b = rectOf(m)
        return Math.abs(b.height - a.height) > 1.5 || Math.abs((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2) > 1.5
      })
      if (off) rec.flags.push(`row misaligned with "${off.label}" (${off.height}px vs ${rec.height}px)`)
      break
    }
  })

  const page = document.documentElement.scrollWidth - document.documentElement.clientWidth
  return {
    modal: { height: modeOf('height', records.filter((r) => sized.has(r.kind))), family },
    sideways: page,
    controls: records.map(({ el, ...rest }) => rest),
  }
}

/* ---------------------------------------------------------------------------
   The run.
   ------------------------------------------------------------------------ */

const browser = await chromium.launch()
const all = []
const warnings = []
const shortTheme = (theme) => (theme === 'dark' ? 'dark' : 'light')

for (const width of WIDTHS) {
  const narrow = width < 600
  for (const theme of THEMES) {
    const open = async (anon) => {
      const context = await browser.newContext({
        viewport: { width, height: narrow ? 812 : 900 },
        ...(narrow ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      })
      await context.addInitScript((value) => { try { localStorage.setItem('theme', value) } catch {} }, theme)
      if (!anon) {
        // A dev server compiles the route on first use and can refuse the first try.
        let status = 0
        for (let attempt = 0; attempt < 4 && status !== 200; attempt++) {
          const login = await context.request.post(`${base}/api/auth/login`, { data: { email, password }, headers: { origin: base } })
          status = login.status()
          if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        if (status !== 200) throw new Error(`login failed: ${status}`)
      }
      return context
    }
    const authed = await open(false)
    const anon = await open(true)

    for (const state of STATES) {
      if (ONLY && !state.name.includes(ONLY)) continue
      if (state.narrowOnly && !narrow) continue
      if (state.wideOnly && narrow) continue
      const page = await (state.anon ? anon : authed).newPage()
      try {
        const path = typeof state.path === 'function' ? await state.path() : state.path
        await page.goto(base + path, { waitUntil: 'networkidle' }).catch(() => {})
        // The framework's dev-mode badge is not part of the product.
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important }' }).catch(() => {})
        await page.waitForTimeout(250)
        for (const step of state.steps || []) {
          try { await step(page) } catch (e) { warnings.push(`${state.name} @${width}/${theme}: ${String(e.message).split('\n')[0]}`) }
        }
        // Off the page, so no hover fill is read as a button's own background.
        await page.mouse.move(0, 0)
        await page.waitForTimeout(220)
        const result = await page.evaluate(measure, { STANDARD, COMPACT, MIN_HIT, MIN_CONTRAST })
        const ctx = { state: state.name, path, width, theme }
        all.push({ ...ctx, ...result })
        if (SHOTS) {
          await mkdir(SHOTS, { recursive: true })
          await page.screenshot({ path: join(SHOTS, `${state.name}__${width}-${shortTheme(theme)}.png`) }).catch(() => {})
        }
      } catch (e) {
        warnings.push(`${state.name} @${width}/${theme}: ${String(e.message).split('\n')[0]}`)
      } finally {
        await page.close().catch(() => {})
      }
    }
    await authed.close()
    await anon.close()
  }
}
await browser.close()

/* ---------------------------------------------------------------------------
   The report.
   ------------------------------------------------------------------------ */

const flagged = []
const tally = new Map()
const kinds = new Map()
for (const entry of all) {
  for (const c of entry.controls) {
    const k = `${c.kind}${c.boxed || c.kind !== 'button' ? '' : ':bare'}`
    const row = kinds.get(k) || { n: 0, heights: new Map(), families: new Map(), borders: new Map(), appearance: new Map() }
    row.n++
    for (const [m, v] of [[row.heights, Math.round(c.height)], [row.families, c.fontFamily], [row.borders, c.borderStyle], [row.appearance, c.appearance]]) m.set(v, (m.get(v) || 0) + 1)
    kinds.set(k, row)
    for (const flag of c.flags) {
      const code = flag.replace(/[\d.]+/g, '#').replace(/"[^"]*"/g, '"…"')
      tally.set(code, (tally.get(code) || 0) + 1)
      flagged.push({ state: entry.state, width: entry.width, theme: entry.theme, kind: c.kind, label: c.label, flag })
    }
  }
}
const spread = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`).join(' ')

console.log(`\nAudited ${all.length} page states, ${[...kinds.values()].reduce((s, r) => s + r.n, 0)} controls.\n`)
console.log('By kind (height px / font / border / appearance):')
for (const [k, r] of [...kinds.entries()].sort()) {
  console.log(`  ${k.padEnd(12)} ${String(r.n).padStart(5)}   h: ${spread(r.heights)}\n${' '.repeat(26)}font: ${spread(r.families)}   border: ${spread(r.borders)}   appearance: ${spread(r.appearance)}`)
}
const sideways = all.filter((e) => e.sideways > 0)
if (sideways.length) console.log(`\nPages that scroll sideways: ${sideways.map((e) => `${e.state}@${e.width}`).join(', ')}`)

console.log(`\nOutliers: ${flagged.length}`)
for (const [code, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${code}`)

const seen = new Set()
const unique = flagged.filter((f) => {
  const key = `${f.kind}|${f.label}|${f.flag}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
if (unique.length) {
  console.log(`\nDistinct outliers (${unique.length}), first sighting of each:`)
  for (const f of unique.slice(0, 80)) console.log(`  [${f.state} ${f.width} ${f.theme}] ${f.kind} "${f.label}": ${f.flag}`)
  if (unique.length > 80) console.log(`  … and ${unique.length - 80} more (set AUDIT_OUT for the full record)`)
}
if (warnings.length) console.log(`\nSteps that did not apply (${warnings.length}):\n  ${warnings.slice(0, 40).join('\n  ')}`)

if (OUT) {
  await mkdir(join(OUT, '..'), { recursive: true }).catch(() => {})
  await writeFile(OUT, JSON.stringify({ base, widths: WIDTHS, themes: THEMES, outliers: flagged, warnings, states: all }, null, 1))
  console.log(`\nWrote ${OUT}`)
}
process.exit(flagged.length > 0 ? 1 : 0)
