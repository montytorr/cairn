import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownView } from '@/components/markdown'
import { ProjectNav } from '@/components/project-nav'
import { ProjectKeysProvider } from '@/components/project-keys'
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

describe('LAB-n in a body while the Lab is on', () => {
  const render = (body: string) =>
    renderToStaticMarkup(
      <LabProvider enabled>
        <MarkdownView>{body}</MarkdownView>
      </LabProvider>,
    )

  it('links to the subject’s page', () => {
    const html = render('see LAB-12 for context')
    expect(html).toContain('href="/lab/subjects/12"')
    expect(html).toContain('data-subject-ref="LAB-12"')
  })

  it('leaves a task ref a task link', () => {
    const html = renderToStaticMarkup(
      <ProjectKeysProvider keys={['KDP']}>
        <LabProvider enabled>
          <MarkdownView>{'see KDP-41'}</MarkdownView>
        </LabProvider>
      </ProjectKeysProvider>,
    )
    expect(html).toContain('href="/projects/KDP/tasks/41"')
  })
})
