'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Textarea } from '@/components/ui/control'
import { useMutate } from '@/lib/api/use-mutate'
import { cn } from '@/lib/utils'

const TITLE =
  'font-display headline text-fg -mx-1.5 mb-4 rounded-md border px-1.5 text-[1.25rem] leading-[1.25] sm:text-[1.375rem] ' +
  'transition-[background-color,box-shadow] duration-[var(--dur-1)] ease-[var(--ease-out)]'

/**
 * Click-to-edit title, as a task's is. Seeded from the prop when editing
 * starts, never synced while open: an agent's rename arriving under a live
 * refresh must not clobber typing.
 */
export const SubjectTitle = ({ subjectRef, initial }: { subjectRef: string; initial: string }) => {
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
    if (!next || next === initial) {
      setValue(initial)
      setEditing(false)
      return
    }
    setSaving(true)
    const result = await request(`/api/v1/subjects/${subjectRef}`, {
      method: 'PATCH',
      body: { title: next },
    })
    setSaving(false)
    // Stay in edit mode with the text intact: a refused title is retyped from
    // what was written, not from nothing.
    if (!result.ok) return
    setEditing(false)
    router.refresh()
  }

  if (!editing) {
    return (
      <h1
        onClick={() => {
          setValue(initial)
          setEditing(true)
        }}
        className={cn(TITLE, 'hover:bg-surface-hover cursor-text border-transparent')}
        title="Click to edit"
      >
        {initial}
      </h1>
    )
  }

  return (
    <Textarea
      ref={ref}
      value={value}
      disabled={saving}
      aria-label="Subject title"
      maxLength={300}
      onChange={(e) => {
        setValue(e.target.value)
        e.target.style.height = 'auto'
        e.target.style.height = `${e.target.scrollHeight}px`
      }}
      onBlur={() => void save()}
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
      className="mb-4 block w-full resize-none"
      rows={1}
    />
  )
}
