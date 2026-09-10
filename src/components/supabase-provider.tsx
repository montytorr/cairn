'use client'

import { createBrowserClient } from '@supabase/ssr'
import { createContext, useContext, useMemo } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Supplies the browser Supabase client from RUNTIME config, not build-time.
 *
 * `NEXT_PUBLIC_*` variables are inlined by Next at BUILD time. In a Docker
 * image built once and configured at run time — which is how anyone
 * self-hosting this will do it — those reads compile to `undefined`, and the
 * browser client throws "Your project's URL and API key are required".
 * Server-side code keeps working, so the failure looks baffling: the API and
 * every server-rendered page are fine and only the login button hangs.
 *
 * The root layout reads the values on the server and passes them down here,
 * so a single image runs against any instance with no rebuild.
 */
type Config = { url: string; anonKey: string }

const ConfigContext = createContext<Config | null>(null)

export const SupabaseProvider = ({
  config,
  children,
}: {
  config: Config
  children: React.ReactNode
}) => <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>

export const useSupabaseConfig = (): Config => {
  const config = useContext(ConfigContext)
  if (!config) {
    throw new Error('useSupabaseConfig must be used inside <SupabaseProvider>')
  }
  return config
}

/** Memoised per component: creating a client on every render leaks listeners. */
export const useSupabase = (): SupabaseClient => {
  const { url, anonKey } = useSupabaseConfig()
  return useMemo(() => createBrowserClient(url, anonKey), [url, anonKey])
}
