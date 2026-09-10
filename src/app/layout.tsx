import type { Metadata } from 'next'
import { ThemeProvider } from 'next-themes'
import { SupabaseProvider } from '@/components/supabase-provider'
import { display, mono, sans } from './fonts'
import './globals.css'

/**
 * Force request-time rendering for everything under the root layout.
 *
 * Without this, Next prerenders static pages (/login was one) at BUILD time
 * and bakes whatever process.env held then — which, in an image built before
 * it is configured, is nothing. The Supabase config below would be serialised
 * into the flight data as empty strings, and the browser client would throw
 * "Your project's URL and API key are required" with no obvious cause.
 *
 * Reading runtime config in a layout and prerendering that layout are simply
 * incompatible. The cost is a per-request render, which is irrelevant here.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Cairn',
  description: 'Agent-first task tracker whose tasks double as shared memory.',
}

/**
 * Read on the server at request time and handed to the client provider.
 * Deliberately not read from `process.env` in client components: Next inlines
 * NEXT_PUBLIC_* at build time, which is wrong for an image configured at run
 * time. See src/components/supabase-provider.tsx.
 */
const RootLayout = ({ children }: { children: React.ReactNode }) => {
  const config = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} ${display.variable}`}
    >
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SupabaseProvider config={config}>{children}</SupabaseProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}

export default RootLayout
