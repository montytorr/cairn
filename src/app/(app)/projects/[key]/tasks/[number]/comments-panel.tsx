'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MarkdownView } from '@/components/markdown'
import type { Comment } from '@/lib/data'
import { Button, Textarea } from '@/components/ui/control'

/** Conversation aimed at the human, kept separate from the agent work log. */
export const CommentsPanel = ({
  taskId,
  comments: initial,
}: {
  taskId: string
  comments: Comment[]
}) => {
  const router = useRouter()
  // Appended locally; see the note in notes-panel.tsx.
  const [comments, setComments] = useState(initial)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (!text.trim() || pending) return
    setPending(true)
    const res = await fetch(`/api/v1/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.trim() }),
    })
    setPending(false)
    if (!res.ok) return

    const payload = await res.json().catch(() => null)
    const created = payload?.data
    setText('')

    if (created?.id) setComments((current) => [...current, created as Comment])
    else router.refresh()
  }

  return (
    <section>
      <h2 className="text-fg-muted mb-2 flex items-center gap-2 text-[10.5px] font-medium tracking-[0.06em] uppercase">
        Comments
        <span className="tabular text-fg-subtle">{comments.length}</span>
      </h2>

      {comments.length > 0 && (
        <ul className="mb-3 flex flex-col gap-3">
          {comments.map((c) => (
            <li key={c.id} className="border-border border-l-2 pl-3">
              <div className="mb-0.5 flex items-center gap-2 text-[11px]">
                <span className={c.actor_type === 'agent' ? 'text-accent' : 'text-fg-subtle'}>
                  {c.actor_type === 'agent' ? c.actor_id : 'you'}
                </span>
                <span className="text-fg-subtle tabular">
                  {c.created_at.slice(0, 16).replace('T', ' ')}
                </span>
              </div>
              <MarkdownView>{c.content}</MarkdownView>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          placeholder="Add a comment…"
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          variant="primary"
          onClick={submit}
          disabled={!text.trim() || pending}
          className="w-auto self-end px-3"
        >
          {pending ? '…' : 'Post'}
        </Button>
      </div>
    </section>
  )
}
