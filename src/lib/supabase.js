// src/lib/supabase.js
// Cliente Supabase — solo variables públicas en frontend
import { createClient } from '@supabase/supabase-js'

const url  = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anon) {
  console.warn('[BALANCE360] Supabase env vars no configuradas')
}

export const supabase = createClient(url || '', anon || '', {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
})
