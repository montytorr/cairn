import type { Metadata } from 'next'
import { ApiReference } from './api-reference'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'API' }

/**
 * The generated OpenAPI document, rendered by Scalar.
 *
 * Deliberately not a hand-written reference: the spec comes from the same Zod
 * schemas the routes validate with, so it cannot drift from the API. A test
 * also asserts every route on disk appears in it.
 */
const ApiDocsPage = () => (
  // The layout's <main> is overflow-hidden, so every page scrolls itself.
  <div className="h-full overflow-y-auto">
    <ApiReference specUrl="/api/v1/openapi.json" />
    <noscript>
      <div className="surface-card m-8 max-w-xl p-5">
        <p className="text-ui">
          The interactive reference needs JavaScript. The raw document is at{' '}
          <a className="text-accent underline" href="/api/v1/openapi.json">
            /api/v1/openapi.json
          </a>
          .
        </p>
      </div>
    </noscript>
  </div>
)

export default ApiDocsPage
