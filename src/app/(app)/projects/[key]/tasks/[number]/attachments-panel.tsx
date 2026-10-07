'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { Download, File, Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react'
import type { Attachment } from '@/lib/data'
import { mutate } from '@/lib/api/mutate'
import { useMutate } from '@/lib/api/use-mutate'
import { useNotify } from '@/components/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/control'
import { COUNT, LABEL } from './styles'

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const AttachmentsPanel = ({
  taskId,
  attachments,
}: {
  taskId: string
  attachments: Attachment[]
}) => {
  const router = useRouter()
  const request = useMutate()
  const notify = useNotify()
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null)

  const upload = async (file: File) => {
    setPending(true)
    setError(null)
    const form = new FormData()
    form.append('file', file)

    // The API names the acceptable types, so show that rather than "failed".
    const result = await mutate(`/api/v1/tasks/${taskId}/attachments`, { method: 'POST', form })
    setPending(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  /** Signed URLs are short-lived, so fetch one on demand rather than up front. */
  const openSigned = async (id: string, name: string, mime: string) => {
    const res = await fetch(`/api/v1/attachments/${id}`).catch(() => null)
    const payload = await res?.json().catch(() => null)
    if (!payload?.success) {
      notify(payload?.error ?? 'Could not open that file.')
      return
    }
    const { previewUrl, downloadUrl } = payload.data
    if (mime.startsWith('image/') && previewUrl) setLightbox({ url: previewUrl, name })
    else if (downloadUrl) window.open(downloadUrl, '_blank', 'noopener')
  }

  const remove = async (id: string) => {
    // Unchecked, this refreshed either way, so a refused delete looked like a
    // file that simply refused to go.
    const result = await request(`/api/v1/attachments/${id}`, { method: 'DELETE' })
    if (result.ok) router.refresh()
  }

  return (
    <section>
      <h2 className={cn(LABEL, 'mb-2.5 flex items-center gap-2')}>
        Files
        <span className={COUNT}>{attachments.length}</span>
      </h2>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files[0]
          if (file) void upload(file)
        }}
        // The rim and the fill change, never the size in motion: padding
        // steps between states rather than animating the panel's height.
        className={cn(
          'border-border mb-2 rounded-lg border border-dashed text-center',
          'transition-[border-color,background-color] duration-[var(--dur-2)] ease-[var(--ease-out)]',
          dragging
            ? 'border-accent bg-accent-subtle p-3'
            : attachments.length === 0
              ? 'border-transparent p-0 text-left'
              : 'hover:border-border-strong p-2',
        )}
      >
        <input
          ref={input}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
            e.target.value = ''
          }}
        />
        <Button
          size="sm"
          variant="quiet"
          onClick={() => input.current?.click()}
          disabled={pending}
        >
          <Paperclip size={14} aria-hidden />
          {pending ? 'Uploading…' : 'Drop a file, or choose one'}
        </Button>
      </div>

      {error && (
        <p className="enter-rise text-danger bg-danger-subtle mb-2 rounded-md px-2 py-1.5 text-meta">{error}</p>
      )}

      {attachments.length > 0 && (
        // Cards, two across: a file is a thing you pick up, and the tile says
        // what kind before the name is read.
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {attachments.map((a) => (
            <li
              key={a.id}
              className="surface-card surface-card-interactive group flex min-w-0 items-center gap-2.5 px-2 py-1.5"
            >
              <span className="bg-surface-raised text-fg-subtle group-hover:text-fg-muted grid size-[1.75rem] shrink-0 place-items-center rounded-md transition-colors duration-[var(--dur-2)]">
                {a.mime_type.startsWith('image/') ? <ImageIcon size={13} /> : <File size={13} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <button
                  type="button"
                  onClick={() => void openSigned(a.id, a.original_name, a.mime_type)}
                  className="hover:text-accent min-w-0 truncate text-left text-ui transition-colors duration-[var(--dur-1)]"
                >
                  {a.original_name}
                </button>
                <span className="text-fg-subtle flex min-w-0 items-center gap-1.5 text-meta">
                  <span className="tabular shrink-0">{formatBytes(a.size_bytes)}</span>
                  <span aria-hidden>·</span>
                  <span className="truncate">{a.actor_id}</span>
                </span>
              </span>
              <Button
                icon
                size="sm"
                variant="ghost"
                onClick={() => void openSigned(a.id, a.original_name, 'application/octet-stream')}
                aria-label={`Download ${a.original_name}`}
                className="md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Download size={14} aria-hidden />
              </Button>
              <Button
                icon
                size="sm"
                variant="danger"
                onClick={() => void remove(a.id)}
                aria-label={`Delete ${a.original_name}`}
                className="md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {lightbox && (
        <div
          className="scrim fixed inset-0 z-50 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.url}
            alt={lightbox.name}
            className="enter-sheet raised-lg max-h-full max-w-full rounded-lg"
          />
        </div>
      )}
    </section>
  )
}
