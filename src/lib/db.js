// src/lib/db.js
// Capa de datos BALANCE360 — cache, historial, benchmarks
import { supabase } from './supabase'

const CACHE_TTL_DAYS = 7

// Normalizar nombre de empresa a slug
function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ─────────────────────────────────
// CACHE — buscar auditoría reciente
// ─────────────────────────────────
export async function getCachedAudit(company) {
  const slug = slugify(company)
  const { data, error } = await supabase
    .from('audits')
    .select('*')
    .eq('company_slug', slug)
    .eq('is_public', true)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[BALANCE360] Cache lookup error:', error.message)
    return null
  }
  return data
}

// ─────────────────────────────────
// GUARDAR auditoría nueva
// ─────────────────────────────────
export async function saveAudit(result, userId = null) {
  const slug = slugify(result.company)
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS)

  const { data, error } = await supabase
    .from('audits')
    .insert({
      company:       result.company,
      company_slug:  slug,
      sector:        result.sector,
      score:         result.score,
      frentes:       result.frentes || {},
      voz_usuario:   result.voz_usuario,
      gap_principal: result.gap_principal,
      pasos:         result.pasos || [],
      expires_at:    expiresAt.toISOString(),
      user_id:       userId,
      is_public:     true
    })
    .select()
    .single()

  if (error) {
    console.warn('[BALANCE360] Save audit error:', error.message)
    return null
  }

  // Actualizar benchmark del sector
  if (result.sector && result.score != null) {
    await upsertBenchmark(result, data.id)
  }

  return data
}

// ─────────────────────────────────
// BENCHMARK — upsert ranking sectorial
// ─────────────────────────────────
async function upsertBenchmark(result, auditId) {
  const slug   = slugify(result.company)
  const now    = new Date()
  const period = `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`

  const { error } = await supabase
    .from('benchmarks')
    .upsert({
      sector:       result.sector,
      company:      result.company,
      company_slug: slug,
      score:        result.score,
      audit_id:     auditId,
      period
    }, {
      onConflict: 'sector,company_slug,period',
      ignoreDuplicates: false
    })

  if (error) console.warn('[BALANCE360] Benchmark upsert error:', error.message)
}

// ─────────────────────────────────
// RANKING — top empresas por sector
// ─────────────────────────────────
export async function getSectorRanking(sector, limit = 10) {
  const { data, error } = await supabase
    .from('sector_rankings')
    .select('company, score, rank, created_at')
    .eq('sector', sector)
    .order('rank', { ascending: true })
    .limit(limit)

  if (error) {
    console.warn('[BALANCE360] Ranking error:', error.message)
    return []
  }
  return data || []
}

// ─────────────────────────────────
// HISTORIAL — audits del usuario
// ─────────────────────────────────
export async function getUserHistory(userId, limit = 20) {
  const { data, error } = await supabase
    .from('audits')
    .select('id, company, sector, score, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.warn('[BALANCE360] History error:', error.message)
    return []
  }
  return data || []
}

// ─────────────────────────────────
// PERFIL — queries restantes
// ─────────────────────────────────
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (error) return null
  return data
}

export async function incrementQueryCount(userId) {
  const { error } = await supabase.rpc('increment_queries', { uid: userId })
  if (error) console.warn('[BALANCE360] Increment queries error:', error.message)
}
