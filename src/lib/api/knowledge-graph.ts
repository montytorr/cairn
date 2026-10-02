import { unstable_cache } from 'next/cache'
import { admin } from '@/lib/db/client'
import { normalizeSlugRef } from '@/schemas/knowledge'
import { components, layoutGraph, type Edge } from '@/lib/graph-layout'

/**
 * The knowledge corpus as a map, including the parts of it joined to nothing.
 *
 * Every other view here answers "what is connected to this". None answers
 * "what is connected to nothing", and that turned out to be the question worth
 * asking: of 377 entries, 105 have no reference in or out, they fall into
 * nineteen separate islands, and 31 references point at entries nobody ever
 * wrote. All of it was invisible, because absence does not appear in a list —
 * a list shows what is there.
 *
 * The edges live in prose rather than in a table. `[[some-slug]]` is how these
 * entries have always cross-referenced each other, so this reads them out of
 * the bodies with the same regex the renderer uses. Extracting them here, once
 * and on the server, also produces the one thing the renderer never had: the
 * complete set of slugs that exist, which is what lets a reference to
 * something unwritten be MARKED rather than silently linked into the void.
 */

/** The same shape `remarkKnowledgeRefs` matches, and deliberately the same. */
const WIKI = /\[\[([A-Za-z0-9][A-Za-z0-9_-]{1,118}[A-Za-z0-9])\]\]/g

/**
 * A fenced block is code, not prose.
 *
 * The renderer never linkifies inside one because the markdown parser hands it
 * a `code` node instead of text. Reading raw bodies has no such help, so a
 * `[[slug]]` shown as an EXAMPLE inside a fence would otherwise become a real
 * edge on the map — a graph slightly denser than the prose it claims to draw.
 */
const withoutFences = (body: string): string => body.replace(/```[\s\S]*?```/g, ' ')

/**
 * An inline code span is code too, and the renderer already knows it.
 *
 * `remarkKnowledgeRefs` visits `text` nodes only, so `` `[[build]]` `` is an
 * `inlineCode` node it never sees and never linkifies. Reading raw bodies saw
 * it, which is how herdr-plugin-ecosystem-audit contributed three dangling
 * references — `[[build]]`, `[[startup]]`, `[[keys]]` — that are TOML table
 * headers quoted in prose, not links to anything. The page showed backticks;
 * the diagnostic reported three broken promises. Two answers to one question
 * is worse than either answer.
 *
 * The delimiter is a backtick RUN, matched by the same run, so ``a `b` c``
 * closes where CommonMark closes it. A span cannot cross a blank line either,
 * for the same reason the parser will not: a blank line ends the paragraph, so
 * two stray backticks in separate paragraphs are two literal backticks and the
 * prose between them is prose.
 */
const withoutInlineCode = (body: string): string =>
  body.replace(/(`+)(?:(?!\1)[^\n]|\n(?![ \t]*\n))+?\1/g, ' ')

/** Just the prose: what the markdown parser would hand the renderer as text. */
const prose = (body: string): string => withoutInlineCode(withoutFences(body))

/** A reference as its author spelled it, beside the slug it resolves to. */
export type WikiRef = { raw: string; slug: string }

/**
 * Every `[[...]]` in the prose, keeping the author's spelling.
 *
 * The raw form is what write-time validation needs and the map does not: it is
 * the difference between `[[BB-192]]` — a task reference in the wrong brackets
 * — and `bb-192`, which the normaliser has already made to look like a
 * perfectly ordinary slug.
 */
export const wikiRefsIn = (body: string): WikiRef[] => {
  const found = new Map<string, WikiRef>()
  for (const [, raw] of prose(body).matchAll(WIKI)) {
    if (!raw) continue
    const slug = normalizeSlugRef(raw)
    if (!found.has(slug)) found.set(slug, { raw, slug })
  }
  return [...found.values()]
}

export const referencesIn = (body: string): string[] => wikiRefsIn(body).map((ref) => ref.slug)

/**
 * How much of an entry the map's hover card can say (CAIRN-349).
 *
 * A title alone does not tell you what an entry is about, and the body is the
 * whole corpus — shipping that to draw a tooltip would make the map's payload
 * the size of every page in the store. One sentence-ish of prose per node is a
 * few tens of kilobytes over a corpus this size, and it is the part that
 * answers "is this the one I meant".
 */
export const EXCERPT_CAP = 140

const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/
const SETEXT = /^\s{0,3}(?:=+|-{2,})\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/

/** A line that is structure rather than something said. */
const notProse = (line: string): boolean =>
  !line.trim() ||
  HEADING.test(line) ||
  RULE.test(line) ||
  SETEXT.test(line) ||
  line.trimStart().startsWith('|') ||
  line.trimStart().startsWith('<!--')

/**
 * A line of markdown as the reader of the rendered page would read it.
 *
 * Code ticks go first so a `**` quoted inside a span is not taken for
 * emphasis around the rest of the line. A `[[ref]]` keeps its slug: on the
 * page it renders as a link whose text IS the slug, so dropping it would leave
 * the sentence with a hole in it.
 */
const plainLine = (line: string): string =>
  line
    .replace(/^\s{0,3}(?:>\s?)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/(`+)(.+?)\1/g, '$2')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/** Cut at a word where there is one close enough, and say that it was cut. */
const clip = (text: string, cap: number): string => {
  if (text.length <= cap) return text
  const cut = text.slice(0, cap - 1)
  const space = cut.lastIndexOf(' ')
  const head = space > cap * 0.6 ? cut.slice(0, space) : cut
  return `${head.replace(/[\s,;:.\-–—]+$/, '')}…`
}

/**
 * The first thing an entry actually says, as plain text, or '' if it says
 * nothing outside headings, tables and code.
 *
 * The first paragraph rather than the first line, because most bodies here
 * are hard-wrapped and the first line on its own stops mid-clause. A list
 * item ends it: the next bullet is the next thought, not the rest of this one.
 * A line that only repeats the title is skipped — the card already shows the
 * title, and an excerpt that says it twice has said nothing.
 */
export const excerptOf = (body: string, title = '', cap = EXCERPT_CAP): string => {
  const text = withoutFences(body.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, ''))
  const lines = text.split(/\r?\n/)
  const named = title.trim().toLowerCase()
  const parts: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    const next = lines[i + 1] ?? ''
    if (parts.length === 0) {
      // A setext heading is a line whose underline comes after it.
      if (notProse(line) || SETEXT.test(next)) continue
      const said = plainLine(line)
      if (!said || said.toLowerCase() === named) continue
      parts.push(said)
    } else {
      if (notProse(line) || LIST_ITEM.test(line) || SETEXT.test(next)) break
      const said = plainLine(line)
      if (said) parts.push(said)
    }
    if (parts.join(' ').length >= cap) break
  }

  return clip(parts.join(' '), cap)
}

/**
 * `[[BB-192]]` is a task reference somebody put in the wrong brackets.
 *
 * Six of these are in the store. Nothing rejected them, and the normaliser
 * lower-cased them into `bb-192` — a string of exactly the shape a knowledge
 * slug has, so they were counted as references to unwritten knowledge and
 * looked, in every list, like a fact somebody had forgotten to write.
 *
 * Shape only. A slug genuinely named `sha-256` or `next-16` would match this
 * too, so the caller tests it AFTER the lookup fails: something that resolves
 * to a real entry is a real entry whatever it looks like.
 */
const TASK_SHAPED = /^[a-z]{2,10}-\d{1,6}$/

/**
 * Prefixes the corpus half-uses, and the reason a reference misses.
 *
 * `project-`, `reference-`, `feedback-` and `discovery-` are claude-mem TYPE
 * names that survived the import into some slugs and not others. "Is the
 * prefix part of the name" is genuinely unanswerable from inside the store, so
 * an agent guesses, and guesses in both directions:
 * `adp-client-read-email-only-join` dangles while
 * `project-adp-client-read-email-only-join` exists, and elsewhere the same
 * mistake runs the other way.
 *
 * Deliberately NOT in `normalizeSlugRef`. That function answers "how is this
 * spelled canonically" and has exactly one right answer, which every lookup,
 * every link URL and every map key depends on; folding the prefix in there
 * would make `project-x` and `x` the same identifier, and both of those exist
 * as separate entries. Prefix tolerance is a GUESS between candidates, so it
 * belongs in a step that reports what it guessed and lets a caller decide.
 */
const TYPE_PREFIXES = ['project', 'reference', 'feedback', 'discovery']

const withoutTypePrefix = (slug: string): string => {
  for (const prefix of TYPE_PREFIXES) {
    if (slug.startsWith(`${prefix}-`)) return slug.slice(prefix.length + 1)
  }
  return slug
}

const wordsOf = (slug: string): Set<string> =>
  new Set(withoutTypePrefix(slug).split('-').filter(Boolean))

const isSubset = (small: Set<string>, large: Set<string>): boolean =>
  [...small].every((word) => large.has(word))

/**
 * How sure we are that an existing slug is the one that was meant.
 *
 * 0 — the same name, one of them wearing a type prefix. Mechanical.
 * 1 — one name contains the other whole: `capsolver-akamai-bug` against
 *     `capsolver-akamai-script-bug`, `seetickets-session` against
 *     `seetickets-session-mechanics`. The store already holds this fact under
 *     a longer or shorter handle.
 * 2 — most of the same words. Worth showing, not worth acting on unasked.
 */
const SURE = 1

const closeness = (ref: string, candidate: string): number | null => {
  if (withoutTypePrefix(ref) === withoutTypePrefix(candidate)) return 0

  const a = wordsOf(ref)
  const b = wordsOf(candidate)
  // One word in common is a coincidence: `session` sits inside a dozen slugs.
  const shared = [...a].filter((word) => b.has(word)).length
  if (shared < 2) return null

  if (isSubset(a, b) || isSubset(b, a)) return 1

  const union = new Set([...a, ...b]).size
  return shared / union >= 0.5 ? 2 : null
}

/**
 * Existing slugs that might be what a missing reference meant, closest first.
 *
 * This is the half of the answer that makes a refusal worth receiving. 63% of
 * dangling references in the store point at a fact Cairn already holds under a
 * different slug, so "that does not exist" is true and useless; "that does not
 * exist, and here are the three names that nearly are it" is the whole fix.
 */
const ranked = (ref: string, known: readonly string[], limit = 3): { slug: string; rank: number }[] => {
  const scored: { slug: string; rank: number }[] = []
  for (const raw of known) {
    const slug = normalizeSlugRef(raw)
    if (slug === ref) continue
    const rank = closeness(ref, slug)
    if (rank !== null) scored.push({ slug, rank })
  }
  return scored
    .sort(
      (x, y) =>
        x.rank - y.rank ||
        Math.abs(x.slug.length - ref.length) - Math.abs(y.slug.length - ref.length) ||
        x.slug.localeCompare(y.slug),
    )
    .slice(0, limit)
}

export const closeSlugs = (ref: string, known: readonly string[], limit = 3): string[] =>
  ranked(ref, known, limit).map((hit) => hit.slug)

/** A reference that resolves to nothing, and what it probably meant. */
export type UnresolvedRef = {
  slug: string
  /** As the author spelled it. */
  raw: string
  /** Existing slugs that are close, closest first. Often empty. */
  suggestions: string[]
  /**
   * Whether one of those suggestions is close enough to call this a misspelt
   * name rather than a fact nobody has written yet.
   */
  certain: boolean
}

export type ReferenceReport = {
  /** `[[BB-192]]` and friends: task references in the wrong brackets. */
  taskShaped: WikiRef[]
  unresolved: UnresolvedRef[]
}

/**
 * What is wrong with the references in a body, before it is written.
 *
 * Pure, and takes the corpus as an argument, because the decision this feeds
 * is worth testing without a database: which references miss, and whether the
 * thing they missed is sitting right there under another name.
 */
export const checkReferences = ({
  body,
  slug,
  known,
}: {
  body: string
  /** The slug being written, which resolves its own self-references. */
  slug?: string
  known: readonly string[]
}): ReferenceReport => {
  const exists = new Set(known.map(normalizeSlugRef))
  if (slug) exists.add(normalizeSlugRef(slug))

  const taskShaped: WikiRef[] = []
  const unresolved: UnresolvedRef[] = []

  for (const ref of wikiRefsIn(body)) {
    if (exists.has(ref.slug)) continue
    if (TASK_SHAPED.test(ref.slug)) {
      taskShaped.push(ref)
      continue
    }
    const hits = ranked(ref.slug, known)
    unresolved.push({
      slug: ref.slug,
      raw: ref.raw,
      suggestions: hits.map((hit) => hit.slug),
      certain: (hits[0]?.rank ?? Infinity) <= SURE,
    })
  }

  return { taskShaped, unresolved }
}

const nameList = (slugs: string[]): string => slugs.map((s) => `[[${s}]]`).join(', ')

/**
 * The refusal, or null if nothing in the body is worth refusing over.
 *
 * Written as one string because that is what reaches an agent: the CLI prints
 * `payload.error` and drops everything beside it, so guidance that lives only
 * in a structured field is guidance nobody reads.
 */
export const referenceRefusal = (
  report: ReferenceReport,
  { allowUnresolved = false }: { allowUnresolved?: boolean } = {},
): string | null => {
  const reasons: string[] = []

  for (const ref of report.taskShaped) {
    reasons.push(
      `[[${ref.raw}]] is a task reference in wiki brackets. ` +
        `Write it bare as ${ref.raw.toUpperCase()} — inside [[...]] it reads as a knowledge ` +
        `slug, and points at an entry that will never exist.`,
    )
  }

  const misnamed = allowUnresolved ? [] : report.unresolved.filter((ref) => ref.certain)
  for (const ref of misnamed) {
    reasons.push(
      `[[${ref.raw}]] is not an entry, but ${nameList(ref.suggestions)} ` +
        `${ref.suggestions.length > 1 ? 'are' : 'is'} — use the name the store has.`,
    )
  }

  if (reasons.length === 0) return null
  return (
    `${reasons.join(' ')} ` +
    `A reference that resolves to nothing still looks like a trail, so fix it here rather than ` +
    `leave it for whoever follows it.` +
    // Only where an override would help. A task reference in wiki brackets is
    // never what the author meant, so offering to record it anyway would be
    // offering to record a mistake.
    (misnamed.length > 0
      ? ` If you really meant an entry nobody has written yet, send "allowUnresolvedRefs": true ` +
        `and it will be recorded with a warning.`
      : '')
  )
}

/**
 * What was accepted but is still worth saying out loud.
 *
 * A reference to something nobody has written is not necessarily a mistake —
 * two entries that cite each other cannot both be written first — so it is
 * recorded and reported rather than refused. Silence is what let 70 of these
 * accumulate.
 */
export const referenceWarnings = (report: ReferenceReport): string[] =>
  report.unresolved.map((ref) =>
    ref.suggestions.length > 0
      ? `[[${ref.raw}]] points at no entry. Close matches: ${nameList(ref.suggestions)}.`
      : `[[${ref.raw}]] points at no entry — write it, or correct the reference.`,
  )

export type GraphNode = {
  slug: string
  title: string
  project: string | null
  /**
   * The world this entry belongs to: a business, a stack, a subsystem.
   *
   * Thirty-five project keys is more colours than anyone can hold, and the
   * grouping a reader actually thinks in sits one level up — "the Dispofi
   * side", "the Tribe side". Carried here so the map can show it.
   *
   * Taken from the entry's own entity scope where it has one, and otherwise
   * inherited from its project. An entry filed against `dispofi-api` belongs
   * to the Dispofi world whether or not anybody said so, and making that
   * explicit on every row is work nobody would keep up.
   */
  entity: string | null
  /** How many entries this one is joined to, in either direction. */
  degree: number
  /**
   * The first thing the entry says, as plain text, for the hover card
   * (CAIRN-349). Absent rather than empty when there is no prose to show, so
   * an entry that is all headings and code costs the payload nothing.
   */
  excerpt?: string
  /** Index into `islands`; -1 for an entry joined to nothing. */
  island: number
  x: number
  y: number
}

/** A reference to an entry nobody ever wrote. Drawn, not dropped. */
export type MissingNode = {
  slug: string
  /** The entries that point at it. */
  from: string[]
  x: number
  y: number
}

export type KnowledgeGraph = {
  nodes: GraphNode[]
  /**
   * The worlds, named as the rest of the app names them.
   *
   * The map had only the entity KEY, so it wrote "dispofi" where settings and
   * the knowledge list both say "Dispofi". A key is an identifier; a title is
   * what somebody chose to call the thing, and the map should agree with
   * every other surface about that.
   */
  entities: { key: string; title: string }[]
  edges: { source: string; target: string }[]
  missing: MissingNode[]
  islands: number[]
  width: number
  height: number
  isolatedFrom: number
  stats: {
    entries: number
    withReferences: number
    references: number
    resolved: number
    dangling: number
    isolated: number
    islands: number
  }
}

type Row = {
  slug: string
  title: string
  body: string
  superseded_by?: string | null
  knowledge_projects?: { project?: { key?: string } | null }[]
  knowledge_entities?: { entity?: { key?: string } | null }[]
}

/**
 * Every slug in the store, which is the set the renderer needs and has never
 * had.
 *
 * `markdown.tsx` passes no `known` list, so `remarkKnowledgeRefs` links every
 * reference whether or not its target exists — CAIRN-192 left it that way
 * because the only list to hand was a page capped at 300 against a corpus of
 * 377, and using it would have marked 77 real entries as missing. This is the
 * whole set and nothing else: one column, no bodies.
 */
export const knownSlugs = async (): Promise<string[]> => {
  const { data, error } = await admin().from('knowledge').select('slug')
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => normalizeSlugRef(row.slug as string))
}

/**
 * The graph itself, without anywhere to draw it.
 *
 * Split out because the findings are worth more than the picture: what is
 * joined to nothing, what is referenced but never written, how many separate
 * islands there are. A browser needs coordinates; an agent needs the facts,
 * and should not pay for a force simulation to get them.
 */
export type KnowledgeGaps = {
  /** Entries with no reference in or out. */
  orphans: { slug: string; title: string; project: string | null }[]
  /** Referenced, never written. */
  missing: { slug: string; from: string[] }[]
  /** Sizes of the connected components, largest first. */
  islands: number[]
  stats: KnowledgeGraph['stats']
}

type Analysed = {
  rows: Row[]
  bySlug: Map<string, Row>
  edges: Edge[]
  degree: Map<string, number>
  missing: Map<string, string[]>
  references: number
  resolved: number
  withReferences: number
}

const analyse = async (): Promise<Analysed> => {
  const { data, error } = await admin()
    .from('knowledge')
    .select('slug, title, body, superseded_by, knowledge_projects(project:projects(key)), knowledge_entities(entity:entities(key))')
  if (error) throw new Error(error.message)

  const all = (data ?? []) as unknown as Row[]

  /**
   * A superseded entry is not drawn, and is not missing either.
   *
   * It still exists: `getKnowledge` resolves it, the renderer links it, and a
   * reader following the reference lands on the page. Excluding it from the
   * lookup as well as from the drawing made every reference to a corrected
   * entry count as "referenced, but never written" — the map contradicting the
   * page it is a map of, and inflating the one headline the page exists for.
   */
  const rows = all.filter((row) => !row.superseded_by)
  const exists = new Set(all.map((row) => normalizeSlugRef(row.slug)))
  const bySlug = new Map(rows.map((row) => [normalizeSlugRef(row.slug), row]))

  const edges: Edge[] = []
  const seen = new Set<string>()
  const missing = new Map<string, string[]>()
  const degree = new Map<string, number>()
  let references = 0
  let resolved = 0
  let withReferences = 0

  for (const row of rows) {
    const from = normalizeSlugRef(row.slug)
    const refs = referencesIn(row.body ?? '')
    if (refs.length > 0) withReferences += 1

    for (const to of refs) {
      references += 1
      // An entry referencing itself is not connected to anything by that.
      if (to === from) continue

      if (!exists.has(to)) {
        missing.set(to, [...(missing.get(to) ?? []), from])
        continue
      }
      resolved += 1

      // Real, and deliberately not on the map: an edge to a node that is not
      // drawn would be a line to nowhere.
      if (!bySlug.has(to)) continue

      // Undirected: two entries that cite each other are one link, not two.
      const key = [from, to].sort().join(' -> ')
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: from, target: to })
      degree.set(from, (degree.get(from) ?? 0) + 1)
      degree.set(to, (degree.get(to) ?? 0) + 1)
    }
  }

  return { rows, bySlug, edges, degree, missing, references, resolved, withReferences }
}

/**
 * One project key for a row, chosen the same way every time.
 *
 * The embedded aggregate comes back without an ORDER BY, so `[0]` is whatever
 * order the scan happened to produce — not stable across an update or a vacuum.
 */
const projectKeyOf = (row: Row): string | null =>
  (row.knowledge_projects ?? [])
    .map((link) => link.project?.key)
    .filter((key): key is string => Boolean(key))
    .sort()[0] ?? null

/** Its own entity scope, if it was given one. Sorted for the same reason. */
const entityKeyOf = (row: Row): string | null =>
  (row.knowledge_entities ?? [])
    .map((link) => link.entity?.key)
    .filter((key): key is string => Boolean(key))
    .sort()[0] ?? null

/**
 * Which world each project belongs to.
 *
 * Read once and joined in memory rather than as a third level of embedded
 * select: there are thirty-five projects and five entities, so this is two
 * small queries against a join that would otherwise be nested three deep in a
 * client that has never been asked to do that.
 */
/** Every world and what it is called. Five rows; read alongside the rest. */
const entityTitles = async (): Promise<{ key: string; title: string }[]> => {
  const { data, error } = await admin().from('entities').select('key, title').order('key')
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    key: row.key as string,
    title: (row.title as string) || (row.key as string),
  }))
}

const entityByProject = async (): Promise<Map<string, string>> => {
  const { data, error } = await admin()
    .from('project_entities')
    .select('project:projects(key), entity:entities(key)')
  if (error) throw new Error(error.message)
  const out = new Map<string, string>()
  for (const row of (data ?? []) as unknown as {
    project?: { key?: string } | { key?: string }[] | null
    entity?: { key?: string } | { key?: string }[] | null
  }[]) {
    const p = Array.isArray(row.project) ? row.project[0]?.key : row.project?.key
    const e = Array.isArray(row.entity) ? row.entity[0]?.key : row.entity?.key
    // A project can belong to more than one entity. First by name wins, so
    // the answer does not depend on scan order.
    if (p && e && (!out.has(p) || (out.get(p) as string) > e)) out.set(p, e)
  }
  return out
}

/** Counts that do not depend on where anything is drawn. */
const summarise = (a: Analysed, isolated: number, islands: number[]): KnowledgeGraph['stats'] => ({
  entries: a.rows.length,
  withReferences: a.withReferences,
  references: a.references,
  resolved: a.resolved,
  dangling: [...a.missing.values()].reduce((total, from) => total + from.length, 0),
  isolated,
  islands: islands.length,
})

const islandsOf = (ids: string[], edges: Edge[]): { sizes: number[]; of: Map<string, number> } => {
  const of = new Map<string, number>()
  const sizes: number[] = []
  components(ids, edges)
    .filter((group) => group.length > 1)
    .forEach((group, index) => {
      sizes.push(group.length)
      for (const id of group) of.set(id, index)
    })
  return { sizes, of }
}

/**
 * What the map shows, for a reader who has no screen.
 *
 * Cairn is agent-facing and these findings were visible only in a browser:
 * the entries that wrote themselves into a corner, and the references pointing
 * at things nobody ever wrote. An agent that cannot see them cannot fix them.
 */
export const knowledgeGaps = async (): Promise<KnowledgeGaps> => {
  const a = await analyse()
  const ids = [...a.bySlug.keys()].sort()
  const { sizes, of } = islandsOf(ids, a.edges)

  const orphans = ids
    .filter((id) => !of.has(id))
    .map((id) => {
      const row = a.bySlug.get(id) as Row
      return { slug: id, title: row.title, project: projectKeyOf(row) }
    })

  return {
    orphans,
    missing: [...a.missing.entries()]
      .map(([slug, from]) => ({ slug, from: [...new Set(from)].sort() }))
      .sort((x, y) => y.from.length - x.from.length || x.slug.localeCompare(y.slug)),
    islands: sizes,
    stats: summarise(a, orphans.length, sizes),
  }
}

/**
 * Whether the corpus has changed at all, in one cheap query.
 *
 * The map is `force-dynamic`, and every open tab re-renders it through
 * `router.refresh()` each time the live stream reports a change — which while
 * agents are working is every four seconds. Without this each of those tabs
 * paid a full fetch of every body plus a force simulation for a picture that
 * had not moved. This is the one query worth running every time; everything
 * behind it is keyed on the answer.
 */
const corpusVersion = async (): Promise<string> => {
  const { data, error } = await admin().from('knowledge').select('updated_at')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as { updated_at: string }[]
  const latest = rows.reduce((newest, row) => (row.updated_at > newest ? row.updated_at : newest), '')
  return `${rows.length}:${latest}`
}

const graphFor = unstable_cache(
  async (_version: string): Promise<KnowledgeGraph> => buildGraph(),
  // Versioned with the node's shape: the cache outlives a deploy, and the
  // version argument tracks the corpus, not the code, so a graph cached before
  // nodes carried an excerpt would be served without one until the next write
  // (CAIRN-349).
  ['cairn-knowledge-graph-v2'],
  { revalidate: 3600 },
)

export const knowledgeGraph = async (): Promise<KnowledgeGraph> => graphFor(await corpusVersion())

const buildGraph = async (): Promise<KnowledgeGraph> => {
  const [a, worldOf, entities] = await Promise.all([
    analyse(),
    entityByProject(),
    entityTitles(),
  ])
  const { rows, bySlug, edges, degree, missing } = a

  const ids = [...bySlug.keys()].sort()
  const { placed, width, height, isolatedFrom } = layoutGraph(ids, edges)

  const { sizes: islands, of: islandOf } = islandsOf(ids, edges)

  const nodes: GraphNode[] = placed.map((p) => {
    const row = bySlug.get(p.id) as Row
    // Sorted, because the embedded aggregate has no ORDER BY: taking [0] of a
    // scan order that is not stable would change a dot's colour between two
    // renders of the same corpus, which is the one thing this must not do.
    const key = projectKeyOf(row)
    return {
      slug: p.id,
      title: row.title,
      project: key,
      // Its own scope first, then whatever world its project lives in.
      entity: entityKeyOf(row) ?? (key ? (worldOf.get(key) ?? null) : null),
      degree: degree.get(p.id) ?? 0,
      excerpt: excerptOf(row.body ?? '', row.title) || undefined,
      island: islandOf.get(p.id) ?? -1,
      // One decimal. Nothing is drawn to a tenth of a unit, and full float
      // precision was shipping `87.6812408671319` per node twice over.
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
    }
  })

  /**
   * A missing target is drawn beside whichever entry points at it, so the gap
   * appears where the reader already is rather than in a list somewhere else.
   * It has no position of its own — it does not exist — so it borrows one.
   */
  const at = new Map(nodes.map((node) => [node.slug, node]))
  const missingNodes: MissingNode[] = [...missing.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([slug, from], i) => {
      const anchor = at.get(from[0] as string)
      const angle = (i / Math.max(1, missing.size)) * Math.PI * 2
      return {
        slug,
        from,
        x: Math.round(((anchor?.x ?? 0) + Math.cos(angle) * 46) * 10) / 10,
        y: Math.round(((anchor?.y ?? 0) + Math.sin(angle) * 46) * 10) / 10,
      }
    })

  return {
    nodes,
    entities,
    edges,
    missing: missingNodes,
    islands,
    width,
    height,
    isolatedFrom,
    stats: summarise(a, nodes.length - isolatedFrom, islands),
  }
}
