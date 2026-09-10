import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/** Cookie-bound client for the human UI, subject to RLS. */
export const serverClient = async () => {
  const store = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (toSet) => {
          try {
            toSet.forEach(({ name, value, options }) => store.set(name, value, options))
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Session refresh is handled in middleware instead.
          }
        },
      },
    },
  )
}
