'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { Download, File, Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react'
import type { Attachment } from '@/lib/data'

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

    const res = await fetch(`/api/v1/tasks/${taskId}/attachments`, { method: 'POST', body: form })
    const payload = await res.json().catch(() => null)
    setPending(false)

    if (!payload?.success) {
      // The API names the acceptable types, so show that rather than "failed".
      setError(payload?.error ?? 'Upload failed.')
      return
    }
    router.refresh()
  }

  /** Signed URLs are short-lived, so fetch one on demand rather than up front. */
  const openSigned = async (id: string, name: string, mime: string) => {
    const res = await fetch(`/api/v1/attachments/${id}`)
    const payload = await res.json().catch(() => null)
    if (!payload?.success) return
    const { previewUrl, downloadUrl } = payload.data
    if (mime.startsWith('image/') && previewUrl) setLightbox({ url: previewUrl, name })
    else if (downloadUrl) window.open(downloadUrl, '_blank', 'noopener')
  }

  const remove = async (id: string) => {
    await fetch(`/api/v1/attachments/${id}`, { method: 'DELETE' })
    router.refresh()
  }

  return (
    <section>
      <h2 className="text-fg-muted mb-2 flex items-center gap-2 text-[10.5px] font-medium tracking-[0.06em] uppercase">
        Files
        <span className="tabular text-fg-subtle">{attachments.length}</span>
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
        className={`border-border mb-2 rounded-md border border-dashed p-3 text-center transition-colors ${
          dragging ? 'border-accent bg-accent-subtle' : ''
        }`}
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
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={pending}
          className="text-fg-muted hover:text-fg inline-flex items-center gap-1.5 text-xs disabled:opacity-50"
        >
          <Paperclip size={13} />
          {pending ? 'Uploading…' : 'Drop a file, or choose one'}
        </button>
      </div>

      {error && (
        <p className="text-danger bg-danger-subtle mb-2 rounded px-2 py-1.5 text-[11px]">{error}</p>
      )}

      {attachments.length > 0 && (
        <ul className="divide-border border-border divide-y overflow-hidden rounded-md border">
          {attachments.map((a) => (
            <li key={a.id} className="group flex items-center gap-2 px-2.5 py-1.5">
              {a.mime_type.startsWith('image/') ? (
                <ImageIcon size={13} className="text-fg-subtle shrink-0" />
              ) : (
                <File size={13} className="text-fg-subtle shrink-0" />
              )}
              <button
                type="button"
                onClick={() => void openSigned(a.id, a.original_name, a.mime_type)}
                className="hover:text-accent min-w-0 flex-1 truncate text-left text-[12.5px]"
              >
                {a.original_name}
              </button>
              <span className="text-fg-subtle tabular shrink-0 text-[11px]">
                {formatBytes(a.size_bytes)}
              </span>
              <span className="text-fg-subtle shrink-0 text-[11px]">{a.actor_id}</span>
              <button
                type="button"
                onClick={() => void openSigned(a.id, a.original_name, 'application/octet-stream')}
                className="text-fg-subtle hover:text-fg shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={`Download ${a.original_name}`}
              >
                <Download size={13} />
              </button>
              <button
                type="button"
                onClick={() => void remove(a.id)}
                className="text-fg-subtle hover:text-danger shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={`Delete ${a.original_name}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.url}
            alt={lightbox.name}
            className="max-h-full max-w-full rounded-md"
          />
        </div>
      )}
    </section>
  )
}
