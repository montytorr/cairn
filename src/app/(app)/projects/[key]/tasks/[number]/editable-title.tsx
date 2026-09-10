'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

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
    const res = await fetch(`/api/v1/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next }),
    })
    setSaving(false)
    if (res.ok) {
      setEditing(false)
      router.refresh()
    } else {
      setValue(initial)
      setEditing(false)
    }
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
