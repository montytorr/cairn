import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabSettings, Stage, Tag } from '@/components/lab/types'
import { LabSection } from './lab-section'

const { mutateMock, refreshMock } = vi.hoisted(() => ({ mutateMock: vi.fn(), refreshMock: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))

const off: LabSettings = { enabled: false, home_project: null, updated_at: null }
const on: LabSettings = { ...off, enabled: true }
const stages: Stage[] = [
  { id: 's1', name: 'to explore', category: 'planned', color: '#8a8792', position: 0 },
  { id: 's2', name: 'done', category: 'completed', color: '#5f8a63', position: 1 },
]
const tags: Tag[] = [{ id: 't1', name: 'search', color: '#8a8792', position: 0 }]
const projects = [{ id: 'p1', key: 'CAIRN', title: 'Cairn' }]

const markup = (settings: LabSettings) =>
  renderToStaticMarkup(<LabSection settings={settings} stages={stages} tags={tags} projects={projects} />)

describe('the Lab section of Settings', () => {
  it('offers only the switch and the home project while the Lab is off', () => {
    const html = markup(off)
    expect(html).toContain('Turn the Lab on')
    expect(html).toContain('Home project for todos')
    expect(html).not.toContain('Lab stages')
    expect(html).not.toContain('Lab tags')
  })

  it('adds the stages and tags once it is on', () => {
    const html = markup(on)
    expect(html).toContain('The Lab is on')
    expect(html).toContain('Lab stages')
    expect(html).toContain('Lab tags')
    expect(html).toContain('to explore')
    expect(html).toContain('search')
  })

  it('names each stage’s category in words', () => {
    const html = markup(on)
    expect(html).toContain('Planned')
    expect(html).toContain('Completed')
  })

  describe('writing', () => {
    let container: HTMLDivElement
    let root: ReturnType<typeof createRoot>

    beforeEach(() => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      mutateMock.mockReset().mockResolvedValue({ ok: true, data: {} })
      refreshMock.mockReset()
    })

    afterEach(async () => {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    })

    it('turns the Lab on with a PUT to the settings route', async () => {
      await act(async () =>
        root.render(<LabSection settings={off} stages={[]} tags={[]} projects={projects} />),
      )
      const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      await act(async () => box.click())

      expect(mutateMock).toHaveBeenCalledWith('/api/v1/lab/settings', {
        method: 'PUT',
        body: { enabled: true },
      })
      expect(refreshMock).toHaveBeenCalled()
    })

    it('shows a refusal (a project already keyed LAB) rather than swallowing it', async () => {
      mutateMock.mockResolvedValue({ ok: false, error: 'Rekey the project LAB first.', code: 'conflict' })
      await act(async () =>
        root.render(<LabSection settings={off} stages={[]} tags={[]} projects={projects} />),
      )
      const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      await act(async () => box.click())

      expect(container.textContent).toContain('Rekey the project LAB first.')
      expect(refreshMock).not.toHaveBeenCalled()
    })

    it('reorders by sending every stage id exactly once', async () => {
      await act(async () =>
        root.render(<LabSection settings={on} stages={stages} tags={[]} projects={projects} />),
      )
      const later = container.querySelector('[aria-label="Move to explore later"]') as HTMLButtonElement
      await act(async () => later.click())

      expect(mutateMock).toHaveBeenCalledWith('/api/v1/lab/stages/reorder', {
        method: 'POST',
        body: { ids: ['s2', 's1'] },
      })
    })

    it('shows why a stage in use could not be deleted', async () => {
      mutateMock.mockResolvedValue({ ok: false, error: 'done holds 4 subjects.', code: 'stage_in_use' })
      await act(async () =>
        root.render(<LabSection settings={on} stages={stages} tags={[]} projects={projects} />),
      )
      const del = container.querySelector('[aria-label="Delete done"]') as HTMLButtonElement
      await act(async () => del.click())

      expect(container.textContent).toContain('done holds 4 subjects.')
    })
  })
})
