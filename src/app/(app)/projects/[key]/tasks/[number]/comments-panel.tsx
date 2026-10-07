'use client'

import { Spinner } from '@/components/spinner'

import { RelativeTime } from '@/components/relative-time'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MarkdownView } from '@/components/markdown'
import type { Comment } from '@/lib/data'
import { Avatar } from '@/components/icons'
import { Button, Textarea } from '@/components/ui/control'
import { useMutate } from '@/lib/api/use-mutate'
import { cn } from '@/lib/utils'
import { COUNT, LABEL } from './styles'

/** Conversation aimed at the human, kept separate from the agent work log. */
export const CommentsPanel = ({
  taskId,
  comments: initial,
}: {
  taskId: string
  comments: Comment[]
}) => {
  const router = useRouter()
  const request = useMutate()
  // Appended locally; see the note in notes-panel.tsx.
  const [comments, setComments] = useState(initial)
  // See notes-panel: state seeded from a prop is not updated by a re-render,
  // so a comment left by someone else never arrived without a full reload.
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setComments(initial)
  }
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (!text.trim() || pending) return
    setPending(true)
    const result = await request<Comment>(`/api/v1/tasks/${taskId}/comments`, {
      method: 'POST',
      body: { content: text.trim() },
    })
    setPending(false)
    // The toast carries the reason. What was typed stays in the box, because
    // the one thing worse than a refused comment is a lost one.
    if (!result.ok) return

    setText('')
    if (result.data?.id) setComments((current) => [...current, result.data])
    else router.refresh()
  }

  return (
    <section>
      <h2 className={cn(LABEL, 'mb-2.5 flex items-center gap-2')}>
        Comments
        <span className={COUNT}>{comments.length}</span>
      </h2>

      {comments.length > 0 && (
        <ul className="stagger mb-3 flex flex-col gap-2">
          {comments.map((c) => (
            <li key={c.id} className="surface-card px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-meta">
                <Avatar name={c.actor_id} size={16} />
                <span className={c.actor_type === 'agent' ? 'text-accent' : 'text-fg-muted'}>
                  {c.actor_id}
                </span>
                <span className="text-fg-subtle tabular ml-auto">
                  <RelativeTime iso={c.created_at} />
                </span>
              </div>
              <MarkdownView>{c.content}</MarkdownView>
            </li>
          ))}
        </ul>
      )}

      {/* The same field and footer as the work log's composer, so the page has
          one way of writing into it. */}
      <div className="flex flex-col gap-2">
        <Textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          placeholder="Add a comment…"
          aria-label="Add a comment"
          className="max-h-[40vh] w-full"
        />
        <div className="flex items-center gap-2">
          <span className="text-fg-subtle ml-auto hidden text-meta sm:block">
            <kbd className="kbd inline-flex">⌘</kbd>
            <kbd className="kbd ml-0.5 inline-flex">↵</kbd>
          </span>
          <Button size="sm" variant="primary" onClick={submit} disabled={!text.trim() || pending}>
            {pending ? <Spinner /> : 'Post'}
          </Button>
        </div>
      </div>
    </section>
  )
}
