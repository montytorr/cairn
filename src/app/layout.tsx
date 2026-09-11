import type { Metadata } from 'next'
import { ThemeProvider } from 'next-themes'
import { display, mono, sans } from './fonts'
import './globals.css'

/**
 * Force request-time rendering for everything under the root layout.
 *
 * Without this, Next prerenders static pages (/login was one) at BUILD time
 * and bakes request state before the server can resolve a session.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Cairn',
  description: 'Agent-first task tracker whose tasks double as shared memory.',
}

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} ${display.variable}`}
    >
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}

export default RootLayout
