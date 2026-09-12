'use client'

import { EditorContent, useEditor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import { useCallback, useEffect, useRef, useState } from 'react'
import { editorExtensions } from '@/lib/editor/markdown'
import { MarkdownView } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { mutate } from '@/lib/api/mutate'

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/**
 * Click-to-edit markdown body.
 *
 * The body is markdown on the wire and in the database; Tiptap is only the
 * editing surface. The extension set is constrained to GFM-representable
 * constructs — see docs/tiptap-markdown-spike.md for what that costs and why.
 */
export const MarkdownEditor = ({
  taskId,
  initial,
}: {
  taskId: string
  initial: string
}) => {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initial)
  const [state, setState] = useState<SaveState>('idle')
  // The markdown as it was when editing began, so an unchanged body is never
  // written back — the single most effective guard against the round trip
  // silently rewriting something an agent wrote.
  const baseline = useRef(initial)

  const editor = useEditor(
    {
      extensions: [
        ...editorExtensions(),
        Placeholder.configure({ placeholder: 'Describe the task. Markdown, / for commands.' }),
      ],
      content: value,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'outline-none min-h-32 text-sm leading-relaxed',
        },
      },
      onUpdate: () => setState('dirty'),
    },
    [editing],
  )

  const save = useCallback(async () => {
    if (!editor) return
    const markdown = editor.storage.markdown.getMarkdown()

    if (markdown === baseline.current) {
      setState('idle')
      setEditing(false)
      return
    }

    setState('saving')
    // Without a try/catch a dropped connection never resolved this, and the
    // button sat on "Saving…" until the page was left — with the edit still
    // unsaved.
    const result = await mutate(`/api/v1/tasks/${taskId}`, {
      method: 'PATCH',
      body: { description: markdown },
    })

    if (!result.ok) {
      setState('error')
      return
    }

    baseline.current = markdown
    setValue(markdown)
    setState('saved')
    setEditing(false)
  }, [editor, taskId])

  useEffect(() => {
    if (!editing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditing(false)
        setState('idle')
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void save()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [editing, save])

  if (!editing) {
    return (
      <div className="group relative">
        {value.trim() ? (
          <MarkdownView>{value}</MarkdownView>
        ) : (
          <p className="text-fg-subtle text-sm italic">No description.</p>
        )}
        <button
          type="button"
          onClick={() => {
            baseline.current = value
            setEditing(true)
          }}
          className="text-fg-subtle hover:text-fg border-border bg-surface absolute -top-1 right-0 rounded border px-2 py-0.5 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
        >
          Edit
        </button>
        {state === 'saved' && (
          <span className="text-status-done absolute -top-1 right-14 text-[11px]">saved</span>
        )}
      </div>
    )
  }

  return (
    <div>
      <div
        className={cn(
          'border-border focus-within:border-accent rounded-md border p-3 transition-colors',
          state === 'error' && 'border-danger',
        )}
      >
        <EditorContent editor={editor} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={state === 'saving'}
          className="bg-accent text-accent-fg rounded-md px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50"
        >
          {state === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false)
            setState('idle')
          }}
          className="text-fg-muted hover:bg-surface-raised rounded-md px-3 py-1.5 text-xs transition-colors"
        >
          Cancel
        </button>
        <span className="text-fg-subtle text-[11px]">⌘↵ save · esc cancel</span>
        {state === 'error' && (
          <span className="text-danger text-[11px]">Save failed — nothing was changed.</span>
        )}
      </div>
    </div>
  )
}
