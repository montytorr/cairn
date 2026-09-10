import type { Metadata } from 'next'
import { ThemeProvider } from 'next-themes'
import { SupabaseProvider } from '@/components/supabase-provider'
import './globals.css'

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
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SupabaseProvider config={config}>{children}</SupabaseProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}

export default RootLayout
