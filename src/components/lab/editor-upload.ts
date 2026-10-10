import { mutate, type Mutation } from '@/lib/api/mutate'
import type { LabAttachment } from './types'

/** The image files in a paste or a drop, in the order they came. */
export const imageFiles = (data: DataTransfer | null | undefined): File[] =>
  data ? Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/')) : []

/**
 * `[`, `]` and `\` end or escape an image's alt text, so a screenshot named
 * `shot [1].png` has to be written `shot \[1\].png` to stay one image.
 */
const escapeAlt = (text: string) => text.replace(/[\\[\]]/g, (c) => `\\${c}`)

/** How an uploaded image is embedded: by its stable URL, never the signed one that expires within the hour. */
export const imageMarkdown = (file: Pick<LabAttachment, 'filename' | 'content_url'>) =>
  `![${escapeAlt(file.filename)}](${file.content_url})`

/** What stands in the markdown while the upload runs, unique per upload so two of the same name cannot collide. */
export const uploadPlaceholder = (filename: string, token: string) => `![Uploading ${escapeAlt(filename)}… ${token}]()`

/** `text` with `insert` put where the selection was, and the caret just after it. */
export const insertAt = (text: string, start: number, end: number, insert: string) => {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  // A block of its own: an image glued to the end of a sentence renders inline.
  const before = from > 0 && text[from - 1] !== '\n' ? '\n\n' : ''
  const after = to < text.length && text[to] !== '\n' ? '\n\n' : ''
  const piece = `${before}${insert}${after}`
  return { text: text.slice(0, from) + piece + text.slice(to), caret: from + piece.length }
}

/** `text` with `placeholder` swapped for `replacement` (or removed), wherever the typing since has moved it. */
export const settlePlaceholder = (text: string, placeholder: string, replacement: string) => {
  const at = text.indexOf(placeholder)
  if (at === -1) return replacement ? `${text}${text.endsWith('\n') || !text ? '' : '\n\n'}${replacement}` : text
  if (replacement) return text.slice(0, at) + replacement + text.slice(at + placeholder.length)
  // Removed: take the blank line it was given with it.
  const head = text.slice(0, at).replace(/\n\n$/, '\n')
  const tail = text.slice(at + placeholder.length).replace(/^\n\n/, '\n')
  return (head + tail).replace(/^\n+/, '')
}

/** One file onto a subject, as its Files tab shows it. */
export const uploadSubjectFile = (subjectRef: string, file: File): Promise<Mutation<LabAttachment>> => {
  const form = new FormData()
  form.append('file', file)
  return mutate<LabAttachment>(`/api/v1/subjects/${subjectRef}/attachments`, { method: 'POST', form })
}
