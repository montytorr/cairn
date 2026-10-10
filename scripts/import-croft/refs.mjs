/**
 * Croft refs written in prose: `S-12` and `T-41`.
 *
 * Under `--rewrite-refs` the ones that name a real subject or todo become
 * `LAB-12` and the todo's new ref, so they link and appear under "Mentioned
 * in". The rewrite is deliberately timid. It only ever touches a ref that is in
 * the mapping, on its own, in running text. It leaves alone anything that is
 * code (fenced, indented, inline), anything inside a URL, a link target, an
 * autolink or an HTML tag, and anything that merely looks like a ref.
 *
 * Every call also says what it left and why, so the report can show it.
 */

const REF = /(?<![A-Za-z0-9_/#@=?&.:%~-])([A-Z][A-Z0-9]{0,9})-(\d+)(?![A-Za-z0-9_-])(?!\.[A-Za-z0-9])/g

/** Spans of `text` that are not prose: [start, end) pairs. */
export const protectedSpans = (text) => {
  const spans = []
  const add = (start, end) => spans.push([start, end])

  // Fenced and indented code, line by line.
  let offset = 0
  let fence = null
  let inList = false
  let inIndented = false
  let previousBlank = true
  for (const line of text.split('\n')) {
    const end = offset + line.length
    const next = end + 1
    const blank = /^\s*$/.test(line)
    if (fence) {
      add(offset, end)
      const close = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`)
      if (close.test(line)) fence = null
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      const marker = /^\s*([-*+]|\d+[.)])\s/.test(line)
      const indented = /^( {4,}|\t)/.test(line)
      if (open) {
        fence = { char: open[1][0] === '`' ? '`' : '~', length: open[1].length }
        add(offset, end)
        inIndented = false
      } else if (indented && !blank && !inList && (previousBlank || inIndented)) {
        add(offset, end)
        inIndented = true
      } else if (blank) {
        // A blank line keeps an indented block open; the next line decides.
      } else {
        inIndented = false
        if (marker) inList = true
        else if (!indented) inList = false
      }
    }
    previousBlank = blank
    offset = next
  }

  const each = (re, group = 0) => {
    for (const m of text.matchAll(re)) {
      const start = m.index + (group ? m[0].indexOf(m[group]) : 0)
      add(start, start + (group ? m[group].length : m[0].length))
    }
  }
  // Inline code: a backtick run closed by a run of the same length.
  each(/(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g)
  // A markdown link or image target, with its optional title.
  each(/\]\(\s*<?[^)\s>]*>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)
  // A reference definition: `[id]: target`.
  each(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S+/gm)
  // Autolinks and any HTML tag (so href="…" and src="…" are safe).
  each(/<[A-Za-z][A-Za-z0-9+.-]*:[^>\s]*>/g)
  each(/<\/?[A-Za-z][^<>\n]*>/g)
  // Bare URLs, with or without a scheme.
  each(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi)
  each(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>"'`]*/gi)
  return spans
}

const within = (spans, index) => spans.some(([start, end]) => index >= start && index < end)

/**
 * @param {string | null} text
 * @param {Map<string, string>} subjectRefs `S-12` to `LAB-12`
 * @param {Map<string, string>} todoRefs    `T-41` to its new ref
 * @returns {{ text: string | null, rewritten: {from: string, to: string, at: number}[],
 *             left: {ref: string, at: number}[], unknown: string[] }}
 */
export const scanRefs = (text, subjectRefs, todoRefs) => {
  if (typeof text !== 'string' || text === '') return { text, rewritten: [], left: [], unknown: [] }
  const keys = new Set([...subjectRefs.keys(), ...todoRefs.keys()].map((r) => r.slice(0, r.lastIndexOf('-'))))
  const spans = protectedSpans(text)
  const rewritten = []
  const left = []
  const unknown = []
  let out = ''
  let last = 0
  for (const m of text.matchAll(REF)) {
    const [whole, key, digits] = m
    if (!keys.has(key)) continue
    const ref = `${key}-${Number(digits)}`
    const to = subjectRefs.get(ref) ?? todoRefs.get(ref)
    if (!to) {
      unknown.push(ref)
      continue
    }
    if (within(spans, m.index)) {
      left.push({ ref, at: m.index })
      continue
    }
    out += text.slice(last, m.index) + to
    last = m.index + whole.length
    rewritten.push({ from: whole, to, at: m.index })
  }
  out += text.slice(last)
  return { text: out, rewritten, left, unknown }
}

export const rewriteRefs = (text, subjectRefs, todoRefs) => scanRefs(text, subjectRefs, todoRefs).text

/**
 * The text around one rewrite, before and after, on one line each, for the
 * report. Every rewrite inside the window is applied to the "after", so what
 * the reader sees is what the field will say.
 */
export const around = (text, at, length, all, width = 28) => {
  const a = Math.max(0, at - width)
  const b = Math.min(text.length, at + length + width)
  let after = ''
  let cursor = a
  for (const r of all) {
    if (r.at < a || r.at + r.from.length > b) continue
    after += text.slice(cursor, r.at) + r.to
    cursor = r.at + r.from.length
  }
  after += text.slice(cursor, b)
  const head = a > 0 ? '…' : ''
  const tail = b < text.length ? '…' : ''
  const flat = (s) => s.replace(/\s+/g, ' ')
  return { before: `${head}${flat(text.slice(a, b))}${tail}`, after: `${head}${flat(after)}${tail}` }
}
