import { beforeEach, describe, expect, it } from 'vitest'
import { signUrls, verifyAttachmentToken } from './attachments'

describe('native attachment links', () => {
  beforeEach(() => {
    process.env.CAIRN_ATTACHMENT_SIGNING_KEY = 'test-signing-key-with-enough-entropy'
  })

  it('signs preview and download intent separately', async () => {
    const links = await signUrls('project/tasks/task/file.pdf', 'report final.pdf', 'application/pdf')
    const preview = new URL(links.previewUrl, 'https://tasks.example.com')
    const download = new URL(links.downloadUrl, 'https://tasks.example.com')
    const valid = (url: URL) => verifyAttachmentToken(
      url.searchParams.get('path')!,
      Number(url.searchParams.get('expires')),
      url.searchParams.get('download') || '',
      url.searchParams.get('mime')!,
    )(url.searchParams.get('signature')!)
    expect(valid(preview)).toBe(true)
    expect(valid(download)).toBe(true)
    preview.searchParams.set('download', 'other.pdf')
    expect(valid(preview)).toBe(false)
  })
})
