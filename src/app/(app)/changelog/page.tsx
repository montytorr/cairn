import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Metadata } from 'next'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { MarkdownView } from '@/components/markdown'
import { parseChangelog } from '@/lib/changelog'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Changelog' }

const REPO = 'https://github.com/montytorr/cairn'

/**
 * CHANGELOG.md, as this build shipped it. Read from disk rather than fetched
 * from GitHub, so an instance shows what it runs, not what upstream has since
 * released. next.config traces the file into the standalone image.
 */
const ChangelogPage = () => {
  const running = process.env.CAIRN_VERSION
  const { intro, releases } = parseChangelog(readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8'))

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border pr-live-status flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4">
        <MobileNavButton />
        <span className="text-fg text-ui font-medium">Changelog</span>
        {running ? (
          <span className="text-fg-subtle tabular ml-auto text-meta">Running v{running}</span>
        ) : null}
      </header>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto flex max-w-4xl flex-col px-4 py-5 md:px-6">
          {intro ? (
            <div className="text-fg-muted mb-6 text-ui [&_p]:my-0 [&_p+p]:mt-2">
              <MarkdownView>{intro}</MarkdownView>
            </div>
          ) : null}

          {releases.map((release) => {
            const unreleased = release.version === 'Unreleased'
            const current = release.version === running
            return (
              <section
                key={release.version}
                id={unreleased ? 'unreleased' : `v${release.version}`}
                className="border-border grid scroll-mt-4 gap-x-6 gap-y-2 border-t py-5 md:grid-cols-[8.5rem_1fr]"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 md:flex-col md:gap-1">
                  <a
                    href={
                      unreleased ? `${REPO}/compare/v${running ?? 'main'}...main` : `${REPO}/releases/tag/v${release.version}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="text-fg hover:text-accent tabular text-ui font-semibold tracking-tight transition-colors duration-[var(--dur-1)]"
                  >
                    {unreleased ? 'Unreleased' : `v${release.version}`}
                  </a>
                  {release.date ? (
                    <time dateTime={release.date} className="text-fg-subtle tabular text-meta">
                      {release.date}
                    </time>
                  ) : null}
                  {current || unreleased ? (
                    <span
                      className={cn(
                        'rounded px-1.5 py-px text-meta font-medium',
                        current ? 'bg-accent-subtle text-accent' : 'bg-surface-raised text-fg-muted',
                      )}
                    >
                      {current ? 'Running' : 'On main'}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0 text-ui">
                  <MarkdownView>{release.body}</MarkdownView>
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default ChangelogPage
