'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { MarkdownView } from '@/components/markdown'
import { Spinner } from '@/components/spinner'
import { Button, Textarea } from '@/components/ui/control'
import { mutate } from '@/lib/api/mutate'
import { cn } from '@/lib/utils'
import {
  imageFiles, imageMarkdown, insertAt, settlePlaceholder, uploadPlaceholder, uploadSubjectFile,
} from './editor-upload'

type SaveState = 'idle' | 'saving' | 'error'

const PLACEHOLDER =
  'What is it, why does it matter, what have we found? Markdown works; LAB-12 and task refs link themselves. Paste or drop an image to add it.'

/**
 * The editor: raw markdown is the source of truth, with a preview beside or
 * under it. A pasted or dropped image is uploaded to the subject's own files
 * and written in as an image by its stable address.
 */
const Editor = ({
  subjectRef,
  initial,
  onClose,
}: {
  subjectRef: string
  initial: string
  /** Must be stable. */
  onClose: (saved: boolean) => void
}) => {
  const [markdown, setMarkdown] = useState(initial)
  const preview = useDeferredValue(markdown)
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [pane, setPane] = useState<'write' | 'preview'>('write')
  const [uploads, setUploads] = useState(0)
  const baseline = useRef(initial)
  const source = useRef<HTMLTextAreaElement>(null)

  // The markdown side of paste and drop: a placeholder at the caret at once,
  // the image in its place when it lands. Uploads may finish while the author
  // keeps typing.
  const uploadIntoSource = async (files: File[]) => {
    const el = source.current
    for (const file of files) {
      const token = uploadPlaceholder(file.name, Math.random().toString(36).slice(2, 8))
      setMarkdown((text) => {
        const { text: next, caret } = insertAt(
          text,
          el?.selectionStart ?? text.length,
          el?.selectionEnd ?? text.length,
          token,
        )
        requestAnimationFrame(() => el?.setSelectionRange(caret, caret))
        return next
      })
      setUploads((n) => n + 1)
      const result = await uploadSubjectFile(subjectRef, file)
      setUploads((n) => n - 1)
      if (!result.ok) setError(`${file.name}: ${result.error}`)
      setMarkdown((text) => settlePlaceholder(text, token, result.ok ? imageMarkdown(result.data) : ''))
    }
  }

  const save = useCallback(async () => {
    if (uploads > 0 || state === 'saving') return
    if (markdown === baseline.current) {
      onClose(false)
      return
    }
    setState('saving')
    setError(null)
    const result = await mutate(`/api/v1/subjects/${subjectRef}`, {
      method: 'PATCH',
      body: { body: markdown },
    })
    if (!result.ok) {
      setState('error')
      setError(result.error)
      return
    }
    baseline.current = markdown
    onClose(true)
  }, [markdown, onClose, state, subjectRef, uploads])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void save()
      }
      if (e.key === 'Escape') onClose(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [save, onClose])

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div className="bg-surface-raised flex items-center gap-0.5 rounded-md p-0.5 lg:hidden" role="group" aria-label="Pane">
          {(['write', 'preview'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={pane === p}
              onClick={() => setPane(p)}
              className={cn(
                'rounded px-2 py-0.5 text-meta capitalize transition-colors',
                pane === p ? 'bg-surface text-fg ring-border ring-1' : 'text-fg-subtle hover:text-fg',
              )}
            >
              {p}
            </button>
          ))}
        </div>
        {uploads > 0 ? (
          <span className="text-fg-muted flex items-center gap-1.5 text-meta" role="status">
            <Spinner size={11} /> Uploading {uploads === 1 ? 'an image' : `${uploads} images`}…
          </span>
        ) : (
          <span className="text-fg-subtle hidden items-center gap-1 text-meta sm:flex">
            <ImagePlus size={12} aria-hidden /> Paste or drop an image
          </span>
        )}
        <span className="text-fg-subtle ml-auto hidden text-meta sm:block">⌘↵ save · esc cancel</span>
      </div>

      {error ? (
        <p className="text-danger bg-danger-subtle mb-2 rounded-md px-2 py-1.5 text-meta" role="alert">
          {error} {state === 'error' ? 'Nothing was saved; your text is still here.' : null}
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={cn('lg:block', pane === 'write' ? 'block' : 'hidden')}>
          <Textarea
            ref={source}
            autoFocus
            aria-label="Write-up, as markdown"
            disabled={state === 'saving'}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            onPaste={(e) => {
              const files = imageFiles(e.clipboardData)
              if (!files.length) return
              e.preventDefault()
              void uploadIntoSource(files)
            }}
            onDrop={(e) => {
              const files = imageFiles(e.dataTransfer)
              if (!files.length) return
              e.preventDefault()
              void uploadIntoSource(files)
            }}
            placeholder={PLACEHOLDER}
            spellCheck
            className="min-h-[24rem] w-full resize-y [field-sizing:content]"
          />
        </div>
        <div
          className={cn(
            'border-border min-h-[24rem] min-w-0 rounded-lg border p-3 lg:block',
            pane === 'preview' ? 'block' : 'hidden',
          )}
        >
          {preview.trim() ? (
            <MarkdownView>{preview}</MarkdownView>
          ) : (
            <p className="text-fg-subtle text-ui">The write-up will appear here.</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={state === 'saving' || uploads > 0}
        >
          {state === 'saving' ? <Spinner /> : 'Save write-up'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onClose(false)} disabled={state === 'saving'}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * A subject's write-up: the long account of it. "Edit" is always there rather
 * than a hover affordance, because writing this is the point of the tab.
 */
export const SubjectWriteUp = ({ subjectRef, body }: { subjectRef: string; body: string | null }) => {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // Seeded from the prop when editing starts, never synced while open.
  const [seed, setSeed] = useState(body ?? '')
  const text = body ?? ''

  const close = useCallback(
    (saved: boolean) => {
      setEditing(false)
      if (saved) {
        setSavedAt(Date.now())
        router.refresh()
      }
    },
    [router],
  )

  const start = () => {
    setSeed(text)
    setEditing(true)
  }

  return (
    <section aria-label="Write-up">
      {editing ? (
        <Editor subjectRef={subjectRef} initial={seed} onClose={close} />
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            {savedAt ? <span className="enter-rise text-status-done text-meta">Saved</span> : null}
            <Button
              size="sm"
              variant={text.trim() ? 'secondary' : 'primary'}
              onClick={start}
              className="ml-auto"
            >
              {text.trim() ? 'Edit write-up' : 'Start writing'}
            </Button>
          </div>
          {text.trim() ? (
            <MarkdownView>{text}</MarkdownView>
          ) : (
            <EmptyState
              compact
              title="No write-up yet"
              hint="What is it, why does it matter, and what would settle it?"
            />
          )}
        </>
      )}
    </section>
  )
}
