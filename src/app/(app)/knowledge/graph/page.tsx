import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { LiveUpdates } from '@/components/live-updates'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { BrandName } from '@/components/brand'
import { currentUser } from '@/lib/data'
import { knowledgeGraph } from '@/lib/api/knowledge-graph'
import { GraphView } from './graph-view'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Knowledge map' }

/**
 * The corpus as a map, and specifically as a map of what it is NOT joined to.
 *
 * Built after counting the edges in the model and finding only one real graph
 * in it: the `[[slug]]` references between knowledge entries. Everything
 * relational is a tree or a fan — two dependency edges across three thousand
 * tasks — so this draws the one structure that has a shape worth seeing.
 *
 * As navigation it would be decoration; the references have been clickable
 * since CAIRN-192 and one click beats hunting a dot. What earns it is the
 * other half: a quarter of the corpus is joined to nothing, it falls into
 * nineteen separate islands, and dozens of references point at entries nobody
 * ever wrote. None of that appears in a list, because a list shows what is
 * there.
 *
 * The page does not scroll, and that is a fix rather than a style. The map
 * takes the wheel for zooming, which is right for a canvas and wrong for a
 * document — with a caption below the frame, scrolling down to read it zoomed
 * the map out instead. Nothing is behind the map now, so nothing is stolen.
 *
 * page-scroll-guard: fills the viewport on purpose
 */
const KnowledgeGraphPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const graph = await knowledgeGraph()
  const { stats } = graph

  const figures: [string, string, string][] = [
    [`${stats.entries}`, 'entries', `${stats.withReferences} reference another`],
    [`${graph.edges.length}`, 'links', `${stats.resolved} references resolve`],
    [
      `${stats.islands}`,
      stats.islands === 1 ? 'island' : 'islands',
      graph.islands.length > 0 ? `largest holds ${graph.islands[0]}` : '',
    ],
    [
      `${stats.isolated}`,
      'joined to nothing',
      stats.entries > 0 ? `${Math.round((stats.isolated / stats.entries) * 100)}% of the corpus` : '',
    ],
    [
      `${graph.missing.length}`,
      'never written',
      stats.dangling > 0 ? `${stats.dangling} references point at them` : '',
    ],
  ]

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* agents write knowledge while you are reading it */}
      <LiveUpdates />
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-ui transition-colors sm:block"
        >
          <BrandName />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <Link href="/knowledge" className="text-fg-muted hover:text-fg text-ui">
          Knowledge
        </Link>
        <ChevronRight size={13} className="text-fg-subtle" aria-hidden />
        <span className="text-fg text-ui">Map</span>
      </header>

      {/* Five instruments over the map: flat tiles, each a label, a reading
          and what the reading means. */}
      <dl className="grid shrink-0 grid-cols-2 gap-1.5 px-2.5 py-2 sm:grid-cols-3 md:px-4 lg:grid-cols-5">
        {figures.map(([value, label, note]) => (
          <div
            key={label}
            className="border-border bg-surface min-w-0 rounded-lg border px-3 py-1.5"
          >
            <dt className="text-fg-subtle text-label font-medium tracking-[0.08em] uppercase">
              {label}
            </dt>
            <dd className="font-display text-fg text-[1.15rem] leading-tight font-medium tracking-tight tabular-nums">
              {value}
            </dd>
            {note ? <p className="text-fg-subtle text-meta">{note}</p> : null}
          </div>
        ))}
      </dl>

      <div className="border-border/70 min-h-0 flex-1 border-t">
        <GraphView graph={graph} />
      </div>
    </div>
  )
}

export default KnowledgeGraphPage
