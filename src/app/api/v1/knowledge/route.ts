import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { createKnowledge, listKnowledge } from '@/lib/api/knowledge'
import { searchAll } from '@/lib/api/search'
import {
  checkReferences,
  knownSlugs,
  referenceRefusal,
  referenceWarnings,
} from '@/lib/api/knowledge-graph'
import { knowledgeCreate, slugify } from '@/schemas/knowledge'
import { liveProjectKey } from '@/lib/api/project-keys'
import { COUNTED, RECALL_WINDOW_DAYS, recallCounts, unusedKnowledge, unusedWindow } from '@/lib/api/knowledge-use'

export const dynamic = 'force-dynamic'

const listQuery = z.object({
  project: z.string().max(10).optional(),
  entity: z.string().max(40).optional(),
  label: z.string().max(40).optional(),
  superseded: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Instead of a list: current entries nobody was given in this many days (CAIRN-270). */
  unused: z.coerce.number().int().min(1).max(365).optional(),
})

/**
 * Knowledge scoped to a project deliberately includes the global rows: the
 * question is "what do we know that applies here", and an infra gotcha applies
 * here.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad filters.', { issues: parsed.error.issues })

    const { entity, label, superseded, limit, unused } = parsed.data

    if (unused !== undefined) {
      const [results, window] = await Promise.all([unusedKnowledge(unused, limit), unusedWindow(unused)])
      return ok({ count: results.length, days: unused, counted: COUNTED, ...window, results })
    }

    // Normalised here so every scope below — the project's own rows AND the
    // entities it belongs to — is looked up under the key the project has now.
    const { key: project, renamed } = await liveProjectKey(parsed.data.project)

    // Naming an unknown project is the caller's mistake, not a server fault.
    // Left to the shared handler it became "Something went wrong." and was
    // logged as unhandled — which is how a typo would have read as a bug in
    // Cairn. POST below has always reported its own message; this matches it.
    let rows
    try {
      rows = await listKnowledge(actor.userId, {
        project,
        entity,
        label,
        limit,
        includeSuperseded: superseded,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read that.'
      if (!message.startsWith('No such ')) throw error
      return fail('validation_failed', message)
    }

    const use = await recallCounts(rows.map((r) => r.id))

    return ok({
      count: rows.length,
      recallWindowDays: RECALL_WINDOW_DAYS,
      results: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        labels: r.labels,
        projects: r.projects ?? [],
        entities: r.entities ?? [],
        // Narrowest wins, and the label says which rule put it in front of you.
        scope:
          (r.projects ?? []).length > 0
            ? 'project'
            : (r.entities ?? []).length > 0
              ? 'entity'
              : 'global',
        verified: Boolean(r.verified_at),
        superseded: Boolean(r.superseded_by),
        updatedAt: r.updated_at,
        tokens: Math.ceil((r.body?.length ?? 0) / 4),
        // Searches that returned it plus direct reads, in the window.
        recalled: (use.get(r.id)?.returned ?? 0) + (use.get(r.id)?.read ?? 0),
      })),
      ...(renamed ? { renamed_from: renamed } : {}),
    })
  },
})

/**
 * References are resolved before the entry is written, not audited afterwards.
 *
 * This is the one place that did not look. The schema checked the shape of a
 * slug and the length of a body and inserted; `[[...]]` inside that body was
 * never parsed, so a reference to something that does not exist became a fact
 * about the store the moment it was accepted, and was found only by a
 * diagnostic nobody is obliged to run. 70 of them accumulated that way.
 *
 * What the refusal has to carry is the near miss. 44 of those 70 point at a
 * fact Cairn already holds under a different slug — `capsolver-akamai-bug`
 * where `capsolver-akamai-script-bug` exists — so the useful half of the
 * answer is not "that does not exist" but "that exists, spelt this way".
 */
const referenceCheck = async (body: string, slug: string) =>
  checkReferences({ body, slug, known: await knownSlugs() })

/**
 * Entries that already say something about the same thing (CAIRN-289).
 *
 * `clawdius-server` described per-project Supabase stacks while
 * `active-clawdius-applications-use-two-native-postgresql-17-containers` said
 * the opposite; neither linked the other, because nothing at write time asked
 * whether the store already held a claim on the subject. `cairn add` has
 * always warned about similar existing work before filing a task; this is
 * the same question for a fact, asked after the write so it can never block
 * one. The precise arm only — at least half the title's distinctive terms —
 * because a nudge that fires on every write teaches people to ignore it.
 * Not recorded as a search: it is not a recall, and counting it would mark
 * every neighbour of every new fact as used.
 */
const similarKnowledge = async (userId: string, title: string, slug: string) => {
  try {
    const { rows } = await searchAll(userId, title, { kinds: ['knowledge'] }, 8)
    return rows
      .filter((r) => r.kind === 'knowledge' && !r.widened && r.ref !== slug && r.status !== 'superseded')
      .slice(0, 3)
      .map((r) => ({ slug: r.ref, title: r.title, scope: r.project_key ?? 'global' }))
  } catch {
    return []
  }
}

export const POST = route({
  schema: knowledgeCreate,
  secretFields: ['title', 'body'],
  handler: async ({ actor, body }) => {
    let warnings: string[] = []
    if (body.body.includes('[[')) {
      const report = await referenceCheck(body.body, body.slug ?? slugify(body.title))
      const refusal = referenceRefusal(report, { allowUnresolved: body.allowUnresolvedRefs })
      if (refusal) {
        // The structured half, for a caller that can use it. The CLI prints
        // `error` and nothing else, which is why the message above says it all
        // in prose as well.
        return fail('validation_failed', refusal, {
          unresolvedReferences: report.unresolved,
          taskReferences: report.taskShaped.map((ref) => ref.raw),
        })
      }
      warnings = referenceWarnings(report)
    }

    try {
      const row = await createKnowledge(actor, body)
      const similar = row ? await similarKnowledge(actor.userId, row.title, row.slug) : []
      // Accepted, and still said out loud: a reference to something nobody has
      // written is recorded, never silent.
      return ok(
        {
          ...row,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(similar.length > 0 ? { similar } : {}),
        },
        { status: 201 },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not record that.'
      const code = message.includes('already exists') ? 'conflict' : 'validation_failed'
      return fail(code, message)
    }
  },
})
