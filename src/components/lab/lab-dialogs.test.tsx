import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteSubjectDialog } from './delete-subject-dialog'
import { useStageMove } from './use-stage-move'
import type { Stage } from './types'

const { mutateMock, notifyMock } = vi.hoisted(() => ({ mutateMock: vi.fn(), notifyMock: vi.fn() }))

vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))
vi.mock('@/components/toast', () => ({ useNotify: () => notifyMock }))

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const change = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const button = (name: string) => {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return found
}

describe('the Lab’s dialogs', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset()
    notifyMock.mockReset()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  describe('DeleteSubjectDialog', () => {
    const render = async (todos: number, onDeleted = vi.fn()) => {
      await act(async () =>
        root.render(
          <DeleteSubjectDialog
            subjectRef="LAB-12"
            subjectTitle="Try pgvector"
            todos={todos}
            onClose={() => {}}
            onDeleted={onDeleted}
          />,
        ),
      )
      return onDeleted
    }

    it('keeps the destructive button off until the ref is typed', async () => {
      await render(0)
      const confirm = button('Delete subject')
      expect(confirm.disabled).toBe(true)

      await change(document.body.querySelector('input')!, 'LAB-12')
      expect(confirm.disabled).toBe(false)
    })

    it('confirms by ref, without detaching, when there are no todos', async () => {
      mutateMock.mockResolvedValue({ ok: true, data: {} })
      const onDeleted = await render(0)
      await change(document.body.querySelector('input')!, 'lab-12')
      await act(async () => button('Delete subject').click())
      await flush()

      expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/LAB-12?confirm=LAB-12', { method: 'DELETE' })
      expect(onDeleted).toHaveBeenCalled()
    })

    it('says that todos are detached, never deleted, and sends todos=detach', async () => {
      mutateMock.mockResolvedValue({ ok: true, data: {} })
      await render(3)
      expect(document.body.textContent).toContain('detached, not deleted')

      await change(document.body.querySelector('input')!, 'LAB-12')
      await act(async () => button('Detach todos and delete').click())
      await flush()

      expect(mutateMock).toHaveBeenCalledWith(
        '/api/v1/subjects/LAB-12?confirm=LAB-12&todos=detach',
        { method: 'DELETE' },
      )
    })

    it('switches to the detach wording when the server finds todos the page did not', async () => {
      mutateMock.mockResolvedValue({ ok: false, error: 'has todos', code: 'subject_has_todos' })
      const onDeleted = await render(0)
      await change(document.body.querySelector('input')!, 'LAB-12')
      await act(async () => button('Delete subject').click())
      await flush()

      expect(onDeleted).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('has todos now')
      expect(button('Detach todos and delete')).toBeTruthy()
    })
  })

  describe('useStageMove', () => {
    const exploring: Stage = { id: 's1', name: 'exploring', category: 'active', color: '#6b7fa6', position: 1 }
    const done: Stage = { id: 's2', name: 'done', category: 'completed', color: '#5f8a63', position: 2 }
    const subject = { id: 'x', ref: 'LAB-12', title: 'Try pgvector', conclusion: null as string | null }

    let move: ReturnType<typeof useStageMove>['move']
    const onMoved = vi.fn()

    const Harness = () => {
      const hook = useStageMove(onMoved)
      move = hook.move
      return <>{hook.dialog}</>
    }

    beforeEach(async () => {
      onMoved.mockReset()
      await act(async () => root.render(<Harness />))
    })

    it('moves at once into a stage that does not conclude', async () => {
      mutateMock.mockResolvedValue({ ok: true, data: { id: 'x', conclusion: null } })
      let outcome: string | undefined
      await act(async () => {
        outcome = await move(subject, exploring)
      })

      expect(outcome).toBe('moved')
      expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/LAB-12', {
        method: 'PATCH',
        body: { stage: 's1' },
      })
    })

    it('asks for the conclusion instead of sending a move the server would refuse', async () => {
      let outcome: string | undefined
      await act(async () => {
        outcome = await move(subject, done)
      })

      expect(outcome).toBe('needs-conclusion')
      expect(mutateMock).not.toHaveBeenCalled()
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    })

    it('sends the stage and the conclusion together once it is written', async () => {
      mutateMock.mockResolvedValue({ ok: true, data: { id: 'x', conclusion: 'Works well' } })
      await act(async () => {
        await move(subject, done)
      })
      await change(document.body.querySelector('textarea')!, 'Works well')
      await act(async () => button('Conclude and move').click())
      await flush()

      expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/LAB-12', {
        method: 'PATCH',
        body: { stage: 's2', conclusion: 'Works well' },
      })
      expect(onMoved).toHaveBeenCalled()
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    })

    it('opens the dialog when the server asks for a conclusion the page thought it had', async () => {
      mutateMock.mockResolvedValue({ ok: false, error: 'conclusion required', code: 'conclusion_required' })
      let outcome: string | undefined
      await act(async () => {
        outcome = await move({ ...subject, conclusion: 'stale' }, done)
      })

      expect(outcome).toBe('needs-conclusion')
      expect(notifyMock).not.toHaveBeenCalled()
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    })

    it('tells the person when a move is refused for another reason', async () => {
      mutateMock.mockResolvedValue({ ok: false, error: 'Nope.', code: 'forbidden' })
      let outcome: string | undefined
      await act(async () => {
        outcome = await move(subject, exploring)
      })

      expect(outcome).toBe('failed')
      expect(notifyMock).toHaveBeenCalledWith('Nope.')
    })
  })
})
