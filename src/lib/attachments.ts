import { createHash } from 'node:crypto'
import { admin } from '@/lib/supabase/admin'

export const BUCKET = process.env.CAIRN_ATTACHMENT_BUCKET || 'attachments'
export const MAX_BYTES = Number(process.env.CAIRN_ATTACHMENT_MAX_BYTES || 10_485_760)

/** Allowlist, because a denylist on uploads is a game you lose eventually. */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'video/mp4',
  'audio/mpeg',
])

/**
 * Belt and braces alongside the MIME allowlist. A file can arrive with an
 * innocuous content-type and an executable extension, and the extension is
 * what a human's OS will act on after they download it.
 */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'com', 'ps1',
  'js', 'mjs', 'cjs', 'py', 'rb', 'pl', 'php', 'jar', 'app', 'scpt', 'vbs', 'msi',
])

export const sanitizeFilename = (name: string): string => {
  const base = name.split(/[/\\]/).pop() ?? 'file'
  return (
    base
      .replace(/[^\w.\-]+/g, '-')
      .replace(/^[.\-]+/, '')
      .slice(0, 120) || 'file'
  )
}

const extensionOf = (name: string): string => {
  const parts = name.toLowerCase().split('.')
  return parts.length > 1 ? (parts.pop() ?? '') : ''
}

export type Rejection = { reason: string; valid?: string[] }

export const validateUpload = (file: {
  name: string
  type: string
  size: number
}): Rejection | null => {
  if (file.size > MAX_BYTES) {
    return { reason: `File is ${file.size} bytes; the limit is ${MAX_BYTES}.` }
  }
  if (file.size === 0) return { reason: 'File is empty.' }

  const ext = extensionOf(file.name)
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { reason: `The .${ext} extension is not allowed.` }
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return { reason: `Content type ${file.type || '(none)'} is not allowed.`, valid: [...ALLOWED_MIME] }
  }
  return null
}

/** `{projectId}/tasks/{taskId}/{uuid}-{name}` — collision-free and browsable. */
export const buildStoragePath = (projectId: string, taskId: string, filename: string) =>
  `${projectId}/tasks/${taskId}/${crypto.randomUUID()}-${sanitizeFilename(filename)}`

export const sha256 = (buffer: Buffer | Uint8Array): string =>
  createHash('sha256').update(buffer).digest('hex')

/**
 * Supabase builds signed URLs relative to whatever base the client was created
 * with. Server-side that is SUPABASE_INTERNAL_URL — a Docker hostname no
 * browser can resolve — so the origin has to be rewritten to the public one
 * before the URL leaves the server. The signature covers only the path and
 * token, so swapping the origin is safe.
 */
const toPublicOrigin = (signed: string | undefined): string | null => {
  if (!signed) return null
  const internal = process.env.SUPABASE_INTERNAL_URL?.replace(/\/+$/, '')
  const publicBase = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '')
  if (!internal || !publicBase || internal === publicBase) return signed
  return signed.startsWith(internal) ? `${publicBase}${signed.slice(internal.length)}` : signed
}

/**
 * Two URLs, because they are used differently: `preview` renders inline in the
 * task view, `download` forces a save. Both expire in an hour — long enough for
 * a page session, short enough that a leaked link is not a standing grant.
 */
export const signUrls = async (storagePath: string, originalName: string) => {
  const storage = admin().storage.from(BUCKET)
  const [preview, download] = await Promise.all([
    storage.createSignedUrl(storagePath, 3600),
    storage.createSignedUrl(storagePath, 3600, { download: originalName }),
  ])
  return {
    previewUrl: toPublicOrigin(preview.data?.signedUrl),
    downloadUrl: toPublicOrigin(download.data?.signedUrl),
  }
}

/** Exported for tests only. */
export const __test = { toPublicOrigin }
