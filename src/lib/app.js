import { supabase } from './supabase'

async function loadBaseContext(userId) {
  const [profileRes, onboardingRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('onboarding_states')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
  ])

  return {
    profile: profileRes.data || null,
    onboarding: onboardingRes.data || null
  }
}

async function ensureWorkspaceBootstrap(accessToken) {
  if (!accessToken) return null

  try {
    const response = await fetch('/api/bootstrap-workspace', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({})
    })

    if (!response.ok) return null
    return response.json()
  } catch {
    return null
  }
}

export async function getAppContext(userId, accessToken) {
  let { profile, onboarding } = await loadBaseContext(userId)
  let workspaceId = profile?.workspace_id || onboarding?.workspace_id || null

  if (!workspaceId && accessToken) {
    const bootstrap = await ensureWorkspaceBootstrap(accessToken)
    if (bootstrap?.workspace_id) {
      const refreshed = await loadBaseContext(userId)
      profile = refreshed.profile
      onboarding = refreshed.onboarding
      workspaceId = profile?.workspace_id || onboarding?.workspace_id || bootstrap.workspace_id
    }
  }

  let workspace = null
  let companies = []
  let history = []

  if (workspaceId) {
    const [workspaceRes, companiesRes, historyRes] = await Promise.all([
      supabase
        .from('workspaces')
        .select('*')
        .eq('id', workspaceId)
        .maybeSingle(),
      supabase
        .from('companies')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase
        .from('audits')
        .select('id, company, sector, score, created_at, frentes')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10)
    ])

    workspace = workspaceRes.data || null
    companies = companiesRes.data || []
    history = historyRes.data || []
  }

  return { profile, onboarding, workspace, companies, history }
}

export async function completeOnboarding({
  userId,
  workspaceId,
  companyName,
  sector,
  primaryCompetitor,
  secondaryCompetitor,
  jobTitle
}) {
  const cleanCompany = companyName.trim()
  const companySlug = slugify(cleanCompany)

  const companyPayload = {
    workspace_id: workspaceId,
    name: cleanCompany,
    slug: companySlug,
    sector,
    is_primary: true,
    created_by: userId
  }

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .upsert(companyPayload, { onConflict: 'workspace_id,slug' })
    .select()
    .single()

  if (companyError) throw companyError

  const updates = [
    supabase
      .from('workspaces')
      .update({ default_company_id: company.id })
      .eq('id', workspaceId),
    supabase
      .from('profiles')
      .update({
        company_name: cleanCompany,
        job_title: jobTitle || null,
        onboarding_completed: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId),
    supabase
      .from('onboarding_states')
      .upsert({
        user_id: userId,
        workspace_id: workspaceId,
        company_id: company.id,
        company_name: cleanCompany,
        sector,
        primary_competitor: primaryCompetitor || null,
        step: 'analysis'
      })
  ]

  if (primaryCompetitor?.trim()) {
    updates.push(
      supabase
        .from('company_competitors')
        .upsert({
          workspace_id: workspaceId,
          company_id: company.id,
          competitor_name: primaryCompetitor.trim(),
          competitor_slug: slugify(primaryCompetitor),
          source: 'manual',
          confidence: 1
        }, { onConflict: 'company_id,competitor_slug' })
    )
  }

  if (secondaryCompetitor?.trim()) {
    updates.push(
      supabase
        .from('company_competitors')
        .upsert({
          workspace_id: workspaceId,
          company_id: company.id,
          competitor_name: secondaryCompetitor.trim(),
          competitor_slug: slugify(secondaryCompetitor),
          source: 'manual',
          confidence: 0.95
        }, { onConflict: 'company_id,competitor_slug' })
    )
  }

  const results = await Promise.all(updates)
  const failure = results.find((result) => result.error)
  if (failure?.error) throw failure.error

  return company
}

export async function finalizeOnboarding({ userId, workspaceId, companyId, auditId }) {
  const now = new Date().toISOString()

  const [onboardingRes, profileRes] = await Promise.all([
    supabase
      .from('onboarding_states')
      .update({
        workspace_id: workspaceId,
        company_id: companyId,
        first_analysis_audit_id: auditId,
        step: 'completed',
        completed_at: now,
        updated_at: now
      })
      .eq('user_id', userId),
    supabase
      .from('profiles')
      .update({
        onboarding_completed: true,
        updated_at: now
      })
      .eq('id', userId)
  ])

  if (onboardingRes.error) throw onboardingRes.error
  if (profileRes.error) throw profileRes.error
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
