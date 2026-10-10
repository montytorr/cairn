import { describe, expect, it } from 'vitest'
import { imageFiles, imageMarkdown, insertAt, settlePlaceholder, uploadPlaceholder } from './editor-upload'

describe('imageMarkdown', () => {
  it('embeds the stable content URL', () => {
    expect(imageMarkdown({ filename: 'shot.png', content_url: '/api/v1/attachments/a1/content' })).toBe(
      '![shot.png](/api/v1/attachments/a1/content)',
    )
  })

  it('escapes brackets so a filename cannot end the alt text early', () => {
    expect(imageMarkdown({ filename: 'shot [1].png', content_url: '/x' })).toBe('![shot \\[1\\].png](/x)')
  })
})

describe('imageFiles', () => {
  it('keeps only images, and survives no data at all', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' })
    const txt = new File(['x'], 'a.txt', { type: 'text/plain' })
    expect(imageFiles({ files: [png, txt] } as unknown as DataTransfer)).toEqual([png])
    expect(imageFiles(null)).toEqual([])
  })
})

describe('insertAt', () => {
  it('puts the image on a line of its own and the caret after it', () => {
    const { text, caret } = insertAt('before after', 6, 7, '![a](/x)')
    expect(text).toBe('before\n\n![a](/x)\n\nafter')
    expect(text.slice(0, caret)).toBe('before\n\n![a](/x)\n\n')
  })

  it('replaces a selection and adds no blank lines where there is nothing to separate', () => {
    expect(insertAt('', 0, 0, 'IMG').text).toBe('IMG')
    expect(insertAt('one\nSEL\n', 4, 7, 'IMG').text).toBe('one\nIMG\n')
  })

  it('clamps a stale selection to the text', () => {
    expect(insertAt('ab', 10, 12, 'X').text).toBe('ab\n\nX')
  })
})

describe('settlePlaceholder', () => {
  const token = uploadPlaceholder('a.png', 't1')

  it('swaps the placeholder for the image wherever typing moved it', () => {
    expect(settlePlaceholder(`typed\n\n${token}\n\nmore`, token, '![a](/x)')).toBe('typed\n\n![a](/x)\n\nmore')
  })

  it('removes the placeholder and its blank line when the upload failed', () => {
    expect(settlePlaceholder(`one\n\n${token}\n\ntwo`, token, '')).toBe('one\n\ntwo')
  })

  it('appends the image when the placeholder was deleted meanwhile', () => {
    expect(settlePlaceholder('gone', token, '![a](/x)')).toBe('gone\n\n![a](/x)')
    expect(settlePlaceholder('gone', token, '')).toBe('gone')
  })

  it('does not confuse two uploads of the same name', () => {
    const other = uploadPlaceholder('a.png', 't2')
    expect(settlePlaceholder(`${other}\n\n${token}`, token, 'IMG')).toBe(`${other}\n\nIMG`)
  })
})
