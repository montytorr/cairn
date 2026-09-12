'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useMutate } from '@/lib/api/use-mutate'

/**
 * Click-to-edit title.
 *
 * Titles were the one field with no UI path at all — the body was editable,
 * the properties were, the title was not. It is also the field that matters
 * most for finding the task later, since it carries the heaviest search
 * weight.
 */
export const EditableTitle = ({ taskId, initial }: { taskId: string; initial: string }) => {
  const router = useRouter()
  const request = useMutate()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing || !ref.current) return
    const el = ref.current
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editing])

  const save = async () => {
    const next = value.trim()
    // Never write an unchanged or empty title.
    if (!next || next === initial) {
      setValue(initial)
      setEditing(false)
      return
    }
    setSaving(true)
    const result = await request(`/api/v1/tasks/${taskId}`, {
      method: 'PATCH',
      body: { title: next },
    })
    setSaving(false)
    if (!result.ok) {
      // Stay in edit mode with the text intact. Reverting to the old title
      // and closing the editor — which is what this did — threw away what
      // had just been typed, and a title over 300 characters is refused
      // every time, so a pasted sentence vanished without a word.
      return
    }
    setEditing(false)
    router.refresh()
  }

  if (!editing) {
    return (
      <h1
        onClick={() => {
          // Seed from the current prop at the moment editing starts, rather
          // than syncing prop to state in an effect — that fires on every
          // server refresh and can clobber what is being typed.
          setValue(initial)
          setEditing(true)
        }}
        className="hover:bg-surface-hover -mx-1.5 mb-6 cursor-text rounded-md px-1.5 text-[24px] leading-[1.25] font-semibold tracking-[-0.01em] text-balance transition-colors"
        title="Click to edit"
      >
        {initial}
      </h1>
    )
  }

  return (
    <textarea
      ref={ref}
      value={value}
      disabled={saving}
      maxLength={300}
      onChange={(e) => {
        setValue(e.target.value)
        e.target.style.height = 'auto'
        e.target.style.height = `${e.target.scrollHeight}px`
      }}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          void save()
        }
        if (e.key === 'Escape') {
          setValue(initial)
          setEditing(false)
        }
      }}
      className="border-accent bg-surface -mx-1.5 mb-6 w-[calc(100%+0.75rem)] resize-none rounded-md border px-1.5 text-[24px] leading-[1.25] font-semibold tracking-[-0.01em] outline-none"
      rows={1}
    />
  )
}
