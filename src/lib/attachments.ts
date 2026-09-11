import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const MAX_BYTES = Number(process.env.CAIRN_ATTACHMENT_MAX_BYTES || 10_485_760)
const attachmentRoot = () => resolve(/* turbopackIgnore: true */ process.env.CAIRN_ATTACHMENT_DIR || '/data/attachments')
const signingKey = () => {
  const key = process.env.CAIRN_ATTACHMENT_SIGNING_KEY
  if (!key) throw new Error('CAIRN_ATTACHMENT_SIGNING_KEY is required')
  return key
}

const absolutePath = (storagePath: string) => {
  const root = attachmentRoot()
  const target = resolve(/* turbopackIgnore: true */ root, storagePath)
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error('Invalid attachment path')
  return target
}

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
 * Two URLs, because they are used differently: `preview` renders inline in the
 * task view, `download` forces a save. Both expire in an hour — long enough for
 * a page session, short enough that a leaked link is not a standing grant.
 */
export const signUrls = async (storagePath: string, originalName: string, mimeType = 'application/octet-stream') => {
  const expires = Math.floor(Date.now() / 1000) + 3600
  const make = (download: boolean) => {
    const value = `${storagePath}\n${expires}\n${download ? originalName : ''}\n${mimeType}`
    const signature = createHmac('sha256', signingKey()).update(value).digest('base64url')
    const query = new URLSearchParams({ path: storagePath, expires: String(expires), mime: mimeType, signature })
    if (download) query.set('download', originalName)
    return `/api/files?${query}`
  }
  return {
    previewUrl: make(false),
    downloadUrl: make(true),
  }
}

export const verifyAttachmentToken = (storagePath: string, expires: number, download: string, mimeType: string) => {
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return () => false
  const value = `${storagePath}\n${expires}\n${download}\n${mimeType}`
  return (signature: string) => {
    const expected = createHmac('sha256', signingKey()).update(value).digest()
    const supplied = Buffer.from(signature, 'base64url')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
}

export const writeAttachment = async (storagePath: string, bytes: Buffer) => {
  const target = absolutePath(storagePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
}

export const readAttachment = (storagePath: string) => readFile(/* turbopackIgnore: true */ absolutePath(storagePath))

export const removeAttachments = async (paths: string[]) => {
  await Promise.all(paths.map((path) => unlink(/* turbopackIgnore: true */ absolutePath(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })))
}
