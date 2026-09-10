import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Service-role client. Bypasses RLS, so it must only ever be used from server
 * code that has already resolved an owner, and every query it makes must be
 * scoped to that owner explicitly.
 *
 * RLS remains the boundary for the browser client and a defence-in-depth layer
 * behind this one — it is not a substitute for scoping queries here.
 */
let cached: SupabaseClient | null = null

export const admin = (): SupabaseClient => {
  if (cached) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
