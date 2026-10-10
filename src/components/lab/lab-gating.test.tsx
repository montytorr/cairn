import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownView } from '@/components/markdown'
import { ProjectNav } from '@/components/project-nav'
import { LabProvider } from './lab-context'

vi.mock('next/navigation', () => ({ usePathname: () => '/' }))

const nav = (enabled?: boolean) =>
  renderToStaticMarkup(
    enabled === undefined ? (
      <ProjectNav projects={[]} />
    ) : (
      <LabProvider enabled={enabled}>
        <ProjectNav projects={[]} />
      </LabProvider>
    ),
  )

describe('the sidebar’s Lab entry', () => {
  it('is drawn when the Lab is on', () => {
    const html = nav(true)
    expect(html).toContain('href="/lab"')
    expect(html).toContain('>Lab<')
  })

  it('is not drawn when the Lab is off', () => {
    expect(nav(false)).not.toContain('href="/lab"')
  })

  it('is not drawn where nothing says the Lab is on', () => {
    expect(nav()).not.toContain('href="/lab"')
  })
})

describe('LAB-n in a body while the Lab is off', () => {
  it('stays the text it was', () => {
    const html = renderToStaticMarkup(
      <LabProvider enabled={false}>
        <MarkdownView>{'see LAB-12 for context'}</MarkdownView>
      </LabProvider>,
    )
    expect(html).toContain('LAB-12')
    expect(html).not.toContain('/lab/subjects/12')
  })
})
