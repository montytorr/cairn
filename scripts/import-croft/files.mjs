/**
 * Attachment stores, for copying a file's bytes from Croft's store to the
 * target's. Cairn's own store is a directory or an S3 bucket and the storage
 * path is the same string in both (src/lib/attachments.ts), so a path names a
 * file in either; this mirrors that, with no dependency on the app's code.
 *
 * A store is `{ describe, read(path), write(path, bytes), remove(path) }`.
 * Tests pass their own.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'

const cleanPath = (storagePath) => {
  const key = posix.normalize(storagePath)
  if (key.startsWith('/') || key === '..' || key.startsWith('../')) throw new Error(`invalid storage path ${storagePath}`)
  return key
}

export const diskStore = (root) => {
  const base = resolve(root)
  const at = (storagePath) => resolve(base, cleanPath(storagePath))
  return {
    describe: `directory ${base}`,
    read: async (storagePath) => readFile(at(storagePath)),
    write: async (storagePath, bytes) => {
      const target = at(storagePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
    },
    // Takes the directories it leaves empty with it, up to the store's root, so
    // a failed import leaves the store as it found it. A directory that still
    // holds something is not empty and stays.
    remove: async (storagePath) => {
      const file = at(storagePath)
      await unlink(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
      for (let dir = dirname(file); dir !== base && dir.startsWith(`${base}/`); dir = dirname(dir)) {
        try {
          await rmdir(dir)
        } catch (error) {
          if (error.code !== 'ENOENT') break
        }
      }
    },
  }
}

export const s3Store = ({ bucket, prefix = '', region }) => {
  const prefixed = (storagePath) => {
    const key = cleanPath(storagePath)
    const p = prefix.replace(/^\/+|\/+$/g, '')
    return p ? `${p}/${key}` : key
  }
  let client = null
  const sdk = async () =>
    (client ??= import('@aws-sdk/client-s3').then((m) => ({
      m,
      s3: new m.S3Client({ region: region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION }),
    })))
  return {
    describe: `s3://${bucket}${prefix ? `/${prefix.replace(/^\/+|\/+$/g, '')}` : ''}`,
    read: async (storagePath) => {
      const { m, s3 } = await sdk()
      const object = await s3.send(new m.GetObjectCommand({ Bucket: bucket, Key: prefixed(storagePath) }))
      if (!object.Body) throw new Error(`no such object ${storagePath}`)
      return Buffer.from(await object.Body.transformToByteArray())
    },
    write: async (storagePath, bytes) => {
      const { m, s3 } = await sdk()
      // IfNoneMatch is `wx`: an import never replaces a file.
      await s3.send(new m.PutObjectCommand({ Bucket: bucket, Key: prefixed(storagePath), Body: bytes, IfNoneMatch: '*' }))
    },
    remove: async (storagePath) => {
      const { m, s3 } = await sdk()
      await s3.send(new m.DeleteObjectCommand({ Bucket: bucket, Key: prefixed(storagePath) }))
    },
  }
}

/** `{ source, target }` from the command line, either of which may be null. */
export const storesFromOptions = (o) => {
  const make = (dir, bucket, prefix) => {
    if (dir && bucket) throw new Error('give a directory or an S3 bucket for a store, not both')
    if (dir) return diskStore(dir)
    if (bucket) return s3Store({ bucket, prefix: prefix ?? '' })
    return null
  }
  return {
    source: make(o.croftFilesDir, o.croftFilesS3Bucket, o.croftFilesS3Prefix),
    target: make(o.targetFilesDir, o.targetFilesS3Bucket, o.targetFilesS3Prefix),
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * Reads every file from the source and checks it against the row. Used by the
 * dry run (which must not write) and as the first half of the copy.
 */
export const checkSource = async (store, files) => {
  const problems = []
  const bytes = new Map()
  for (const file of files) {
    let data
    try {
      data = await store.read(file.from)
    } catch (error) {
      problems.push(`${file.from}: cannot be read from ${store.describe} (${error.code ?? error.name ?? error.message})`)
      continue
    }
    if (file.size != null && data.length !== file.size) {
      problems.push(`${file.from}: ${data.length} bytes in the store, ${file.size} on its row`)
    }
    if (file.sha256 && sha256(data) !== file.sha256) problems.push(`${file.from}: its sha256 does not match its row`)
    bytes.set(file.from, data)
  }
  return { problems, bytes }
}

/**
 * Copies each file to its target path. A path that already holds the same bytes
 * counts as copied (a rerun after a rollback); one holding other bytes is an
 * error. Returns the paths this call wrote, so a failed import can remove them.
 */
export const copyFiles = async ({ source, target, files }) => {
  const written = []
  const { problems, bytes } = await checkSource(source, files)
  if (problems.length) throw new Error(`attachments cannot be copied:\n  ${problems.join('\n  ')}`)
  try {
    for (const file of files) {
      const data = bytes.get(file.from)
      try {
        await target.write(file.to, data)
        written.push(file.to)
      } catch (error) {
        const exists = error.code === 'EEXIST' || error.name === 'PreconditionFailed' || error.$metadata?.httpStatusCode === 412
        if (!exists) throw error
        const there = await target.read(file.to)
        if (!there.equals(data)) throw new Error(`${file.to} already exists in ${target.describe} with other bytes`)
      }
    }
  } catch (error) {
    await removeFiles({ target, paths: written })
    throw error
  }
  return written
}

export const removeFiles = async ({ target, paths }) => {
  for (const path of paths) await target.remove(path).catch(() => {})
}
