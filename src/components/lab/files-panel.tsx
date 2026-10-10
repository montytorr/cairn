'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { Copy, Download, File, Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { RelativeTime } from '@/components/relative-time'
import { useNotify } from '@/components/toast'
import { Button, buttonClass } from '@/components/ui/control'
import { mutate } from '@/lib/api/mutate'
import { useMutate } from '@/lib/api/use-mutate'
import { cn } from '@/lib/utils'
import { imageMarkdown } from './editor-upload'
import type { LabAttachment } from './types'

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * A subject's own files, kept beside its write-up. The same limits and
 * refusals as a task's files; an image can be copied as markdown to embed it.
 */
export const FilesPanel = ({
  subjectRef,
  files,
}: {
  subjectRef: string
  files: LabAttachment[]
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
    const result = await mutate(`/api/v1/subjects/${subjectRef}/attachments`, { method: 'POST', form })
    setPending(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  const remove = async (id: string) => {
    const result = await request(`/api/v1/subjects/${subjectRef}/attachments/${id}`, { method: 'DELETE' })
    if (result.ok) router.refresh()
  }

  const copyMarkdown = async (file: LabAttachment) => {
    try {
      await navigator.clipboard.writeText(imageMarkdown(file))
      notify('Markdown copied.')
    } catch {
      notify('Could not copy to the clipboard.')
    }
  }

  return (
    <section aria-label="Files" className="max-w-[51.25rem]">
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
        className={cn(
          'border-border mb-3 rounded-lg border border-dashed p-2 text-center',
          'transition-[border-color,background-color] duration-[var(--dur-2)] ease-[var(--ease-out)]',
          dragging ? 'border-accent bg-accent-subtle' : 'hover:border-border-strong',
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
        <Button size="sm" variant="quiet" onClick={() => input.current?.click()} disabled={pending}>
          <Paperclip size={14} aria-hidden />
          {pending ? 'Uploading…' : 'Drop a file, or choose one'}
        </Button>
      </div>

      {error ? (
        <p className="enter-rise text-danger bg-danger-subtle mb-2 rounded-md px-2 py-1.5 text-meta">{error}</p>
      ) : null}

      {files.length === 0 ? (
        <EmptyState compact title="No files yet." hint="Screenshots, exports and anything the write-up points at." />
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {files.map((f) => {
            const image = f.mime_type.startsWith('image/')
            return (
              <li
                key={f.id}
                className="surface-card surface-card-interactive group flex min-w-0 items-center gap-2.5 px-2 py-1.5"
              >
                <span className="bg-surface-raised text-fg-subtle grid size-[1.75rem] shrink-0 place-items-center rounded-md">
                  {image ? <ImageIcon size={13} /> : <File size={13} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  {image ? (
                    <button
                      type="button"
                      onClick={() => setLightbox({ url: f.preview_url, name: f.filename })}
                      className="hover:text-accent min-w-0 truncate text-left text-ui transition-colors duration-[var(--dur-1)]"
                    >
                      {f.filename}
                    </button>
                  ) : (
                    <a
                      href={f.download_url}
                      className="hover:text-accent min-w-0 truncate text-ui transition-colors duration-[var(--dur-1)]"
                    >
                      {f.filename}
                    </a>
                  )}
                  <span className="text-fg-subtle flex min-w-0 items-center gap-1.5 text-meta">
                    <span className="tabular shrink-0">{formatBytes(f.size_bytes)}</span>
                    <span aria-hidden>·</span>
                    <span className="truncate">{f.uploaded_by}</span>
                    <span aria-hidden>·</span>
                    <RelativeTime iso={f.created_at} className="shrink-0" />
                  </span>
                </span>
                {image ? (
                  <Button
                    icon
                    size="sm"
                    variant="ghost"
                    onClick={() => void copyMarkdown(f)}
                    aria-label={`Copy ${f.filename} as markdown`}
                    className="md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Copy size={14} aria-hidden />
                  </Button>
                ) : null}
                <a
                  href={f.download_url}
                  aria-label={`Download ${f.filename}`}
                  className={cn(buttonClass('ghost', true), 'md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100')}
                  data-size="sm"
                >
                  <Download size={14} aria-hidden />
                </a>
                <Button
                  icon
                  size="sm"
                  variant="danger"
                  onClick={() => void remove(f.id)}
                  aria-label={`Delete ${f.filename}`}
                  className="md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Trash2 size={14} aria-hidden />
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {lightbox ? (
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
      ) : null}
    </section>
  )
}
