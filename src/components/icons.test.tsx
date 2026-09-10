import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PriorityIcon, StatusIcon } from './icons'
import { TASK_PRIORITIES, TASK_STATUSES } from '@/schemas/task'

/**
 * React 19 treats `<title>` as hoistable document metadata. A `<title>` whose
 * children are an expression *plus* a literal — `{label} priority` — is
 * rendered on the client but dropped by the server renderer, which is one
 * hydration mismatch per icon. On a list page that was React #418 twenty-four
 * times, and it looked exactly like a broken page.
 *
 * These assert the server actually emits the title, which is the half that
 * went missing.
 */
describe('icons render their title server-side', () => {
  it.each([...TASK_PRIORITIES])('PriorityIcon(%s)', (priority) => {
    const html = renderToStaticMarkup(<PriorityIcon priority={priority} />)
    expect(html).toContain('<title>')
    expect(html).toMatch(/<title>[^<]+<\/title>/)
  })

  it.each([...TASK_STATUSES])('StatusIcon(%s)', (status) => {
    const html = renderToStaticMarkup(<StatusIcon status={status} />)
    expect(html).toMatch(/<title>[^<]+<\/title>/)
  })

  // The specific shape that broke: interpolation followed by a literal.
  it('names the priority in the title without splitting it into two children', () => {
    expect(renderToStaticMarkup(<PriorityIcon priority="medium" />)).toContain(
      '<title>Medium priority</title>',
    )
  })
})
