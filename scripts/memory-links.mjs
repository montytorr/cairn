/**
 * The pure half of `import-memory-files.mjs`: which slug each memory file will
 * be written under, and the `[[links]]` between them rewritten to match
 * (CAIRN-347).
 *
 * Split out because the importer runs on import — it reads argv and exits — so
 * nothing in it could be tested, and this is the part worth testing.
 *
 * WHY THE LINKS NEED REWRITING AT ALL. Claude Code memory links files by their
 * STEM: `[[feedback_verify_branch]]` means `feedback_verify_branch.md`. The
 * importer writes each file under `front.name` when it has one, and re-slugs a
 * collision to `<project>-<slug>`. Either way the stem and the slug part
 * company, and every link the files carried pointed at an entry nobody wrote —
 * or, worse, at a DIFFERENT project's fact that happened to own the name.
 */

/**
 * A name as a slug: the shape the 013 CHECK accepts, and the same folding the
 * importer has always applied to `front.name`. Used for stems too, so a link
 * `[[project_aircall_widget]]` and a file `project_aircall_widget.md` meet.
 */
export const slugOf = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Anything in wiki brackets on one line. Looser than the store's own shape on purpose: a stem can hold characters a slug cannot. */
const LINK = /\[\[([^[\]\n]+?)\]\]/g

/**
 * Fenced blocks and inline code spans, matched the way `knowledge-graph.ts`
 * reads them: the renderer never links inside code, so a `[[stem]]` quoted
 * there is an example, and rewriting it would change what the example says.
 */
const CODE = /```[\s\S]*?```|(`+)(?:(?!\1)[^\n]|\n(?![ \t]*\n))+?\1/g

const outsideCode = (body, rewrite) => {
  let out = ''
  let last = 0
  for (const match of body.matchAll(CODE)) {
    out += rewrite(body.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return out + rewrite(body.slice(last))
}

/**
 * Every `[[name]]` whose name is a file in `targets`, pointed at that file's
 * slug. A link to no file is left exactly as written: it may be a reference to
 * an entry already in the store, and if it is not, `cairn learn` will say so —
 * guessing here would hide that.
 */
export const rewriteLinks = (body, targets) =>
  outsideCode(body, (prose) =>
    prose.replace(LINK, (whole, inner) => {
      const slug = targets?.get(slugOf(inner))
      return slug ? `[[${slug}]]` : whole
    }),
  )

/**
 * Whether two bodies are the same fact, whatever their links say.
 *
 * The importer decides "this file was already imported" by comparing bodies,
 * and re-slugs on a mismatch. An entry imported before links were rewritten
 * carries the old `[[stem]]` spellings, so comparing literally would call it a
 * different fact and file a second copy under `<project>-<slug>` — the 125
 * duplicate rows that comparison was introduced to stop.
 */
export const sameIgnoringLinks = (a, b) => {
  const strip = (text) => String(text ?? '').replace(LINK, '[[]]').trim()
  return strip(a) === strip(b)
}

/**
 * The slug every file will be written under, decided BEFORE anything is.
 *
 * The collision re-slug used to be decided by the write itself: learn, and on
 * "already exists" look at what is there and try `<project>-<slug>`. That
 * cannot feed a link map, because the first file to link to a re-slugged one
 * may be written before it. So the same decision is made up front, in the same
 * order, against `lookup(slug)` (the stored body, or null when there is none)
 * plus what this run has already claimed:
 *
 *   free                   -> learn it under that slug
 *   held by the same fact  -> present: it was imported before, skip it
 *   held by another fact   -> try `<project>-<slug>` the same way; a global
 *                             file has no qualifier, so it is a collision
 *
 * Deterministic for a given store and set of files; a write racing the import
 * is the one thing it cannot see, and that write fails loudly as before.
 */
export const planSlugs = (entries, lookup) => {
  const claimed = new Map()
  const settle = (slug, full) => {
    const held = claimed.has(slug) ? claimed.get(slug) : lookup(slug)
    if (held == null) return 'free'
    return sameIgnoringLinks(held, full) ? 'present' : 'taken'
  }

  return entries.map((entry) => {
    let final = entry.slug
    let state = settle(final, entry.full)
    if (state === 'taken' && entry.project) {
      final = `${String(entry.project).toLowerCase()}-${entry.slug}`
      state = settle(final, entry.full)
    }
    const action = state === 'free' ? 'learn' : state === 'present' ? 'present' : 'collision'
    if (action !== 'collision') claimed.set(final, entry.full)
    return {
      ...entry,
      action,
      final: action === 'collision' ? null : final,
      requalified: action === 'learn' && final !== entry.slug,
    }
  })
}

/**
 * Per memory directory: link name -> the slug that file is written under.
 *
 * Per directory, not global, because that is the scope the links were written
 * in — every project has its own `feedback_verify_branch_before_commit.md`, and
 * one global map would point all of them at whichever was planned last.
 *
 * Keyed by stem first, which is how Claude Code writes links, then by the
 * frontmatter name where no stem claims it, for the files that were linked by
 * the name they declare. A collision has no slug of its own, so links to it are
 * left alone rather than aimed at the other project's fact that owns the name.
 */
export const linkTargets = (plan) => {
  const byDir = new Map()
  const mapFor = (dir) => {
    if (!byDir.has(dir)) byDir.set(dir, new Map())
    return byDir.get(dir)
  }
  const placed = plan.filter((entry) => entry.final)
  for (const entry of placed) mapFor(entry.dir).set(slugOf(entry.stem), entry.final)
  for (const entry of placed) {
    const map = mapFor(entry.dir)
    if (!map.has(entry.slug)) map.set(entry.slug, entry.final)
  }
  return byDir
}
