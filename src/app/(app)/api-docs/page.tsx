import Script from 'next/script'

export const dynamic = 'force-dynamic'

/**
 * Renders the generated OpenAPI document. Deliberately not a hand-written
 * reference page — the spec comes from the same Zod schemas the routes
 * validate with, so this cannot drift from the API.
 */
const ApiDocsPage = () => (
  <div className="min-h-dvh">
    <div id="scalar" data-url="/api/v1/openapi.json" />
    <Script
      src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"
      strategy="afterInteractive"
    />
    <noscript>
      <div className="p-8">
        <p className="text-sm">
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
