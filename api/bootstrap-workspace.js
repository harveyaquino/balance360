import { createClient } from '@supabase/supabase-js'

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''
const STRICT_CORS = process.env.STRICT_CORS === 'true'
const ALLOWED_ORIGINS = ALLOWED_ORIGIN
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

function corsHeaders(origin) {
  const isDev = process.env.NODE_ENV === 'development'
  const allowAnyInDev = isDev && !ALLOWED_ORIGINS.length
  const allowAnyByConfig = !STRICT_CORS && !ALLOWED_ORIGINS.length
  const normalizedOrigin = String(origin || '').trim()
  const allowed = allowAnyInDev || allowAnyByConfig || ALLOWED_ORIGINS.includes(normalizedOrigin)
  const resolvedOrigin = allowed
    ? (normalizedOrigin || ((allowAnyInDev || allowAnyByConfig) ? '*' : ALLOWED_ORIGINS[0] || ''))
    : (ALLOWED_ORIGINS[0] || '')

  return {
    'Access-Control-Allow-Origin': resolvedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  }
}

function isOriginAllowed(origin) {
  const isDev = process.env.NODE_ENV === 'development'
  if (isDev && !ALLOWED_ORIGINS.length) return true
  if (!STRICT_CORS && !ALLOWED_ORIGINS.length) return true
  if (!origin) return true
  return ALLOWED_ORIGINS.includes(String(origin).trim())
}

function applyHeaders(res, headers) {
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function baseWorkspaceName(user) {
  const meta = user?.user_metadata || {}
  return meta.company_name || meta.full_name || user?.email?.split('@')[0] || 'My Workspace'
}

async function uniqueWorkspaceSlug(supabase, rawName, userId) {
  const prefix = slugify(`${rawName}-${String(userId).slice(0, 8)}`) || `workspace-${String(userId).slice(0, 8)}`
  let candidate = prefix
  let attempts = 0

  while (attempts < 5) {
    const { data } = await supabase
      .from('workspaces')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle()

    if (!data) return candidate
    attempts += 1
    candidate = `${prefix}-${attempts + 1}`
  }

  return `${prefix}-${Date.now().toString().slice(-4)}`
}

async function ensureWorkspaceForUser(supabase, user) {
  const userId = user.id
  const meta = user.user_metadata || {}

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  if (profile?.workspace_id) {
    return { workspaceId: profile.workspace_id, repaired: false }
  }

  const name = baseWorkspaceName(user)
  const slug = await uniqueWorkspaceSlug(supabase, name, userId)

  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .insert({
      name,
      slug,
      created_by: userId
    })
    .select('id')
    .single()

  if (workspaceError) {
    throw workspaceError
  }

  const workspaceId = workspace.id

  if (profile) {
    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        workspace_id: workspaceId,
        role: profile.role || 'owner',
        company_name: profile.company_name || meta.company_name || null,
        display_name: profile.display_name || meta.full_name || user.email?.split('@')[0] || 'Usuario',
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)

    if (profileError) throw profileError
  } else {
    const { error: profileInsertError } = await supabase
      .from('profiles')
      .insert({
        id: userId,
        display_name: meta.full_name || user.email?.split('@')[0] || 'Usuario',
        company_name: meta.company_name || null,
        workspace_id: workspaceId,
        role: 'owner'
      })

    if (profileInsertError) throw profileInsertError
  }

  const { error: memberError } = await supabase
    .from('workspace_members')
    .upsert({
      workspace_id: workspaceId,
      user_id: userId,
      role: 'owner',
      status: 'active',
      invited_by: userId
    }, { onConflict: 'workspace_id,user_id' })

  if (memberError) throw memberError

  const { error: onboardingError } = await supabase
    .from('onboarding_states')
    .upsert({
      user_id: userId,
      workspace_id: workspaceId,
      company_name: meta.company_name || null
    }, { onConflict: 'user_id' })

  if (onboardingError) throw onboardingError

  return { workspaceId, repaired: true }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || ''
  if (!isOriginAllowed(origin)) {
    return res.status(403).json({ error: 'Origen no permitido.' })
  }
  const headers = corsHeaders(origin)
  applyHeaders(res, headers)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Supabase no configurado en servidor' })
  }

  const authHeader = req.headers.authorization || ''
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de sesión requerido' })
  }

  const token = authHeader.slice('Bearer '.length).trim()
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Sesión inválida' })
    }

    const result = await ensureWorkspaceForUser(supabase, data.user)
    return res.status(200).json({
      ok: true,
      workspace_id: result.workspaceId,
      repaired: result.repaired
    })
  } catch (error) {
    console.error('[BALANCE360] bootstrap-workspace error:', error?.message || error)
    return res.status(500).json({ error: 'No se pudo garantizar workspace para el usuario' })
  }
}
