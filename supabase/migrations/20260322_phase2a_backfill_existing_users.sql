-- BALANCE360 - Phase 2A backfill for existing users
-- Run after 20260322_phase2a_foundation.sql

with profiles_without_workspace as (
  select
    p.id as user_id,
    coalesce(nullif(p.company_name, ''), nullif(p.display_name, ''), 'My Workspace') as workspace_name,
    public.slugify(
      coalesce(nullif(p.company_name, ''), nullif(p.display_name, ''), 'workspace')
      || '-' || substr(p.id::text, 1, 8)
    ) as workspace_slug,
    p.company_name,
    p.display_name
  from public.profiles p
  where p.workspace_id is null
),
inserted_workspaces as (
  insert into public.workspaces (name, slug, created_by)
  select
    workspace_name,
    workspace_slug,
    user_id
  from profiles_without_workspace
  returning id, slug, created_by
),
mapped_workspaces as (
  select
    p.user_id,
    w.id as workspace_id,
    p.company_name,
    p.display_name
  from profiles_without_workspace p
  join inserted_workspaces w
    on w.created_by = p.user_id
)
update public.profiles profile_row
set
  workspace_id = mapped.workspace_id,
  updated_at = now()
from mapped_workspaces mapped
where profile_row.id = mapped.user_id;

insert into public.workspace_members (workspace_id, user_id, role, status, invited_by)
select
  p.workspace_id,
  p.id,
  coalesce(nullif(p.role, ''), 'owner'),
  'active',
  p.id
from public.profiles p
where p.workspace_id is not null
on conflict (workspace_id, user_id) do nothing;

insert into public.onboarding_states (user_id, workspace_id, company_name, step)
select
  p.id,
  p.workspace_id,
  p.company_name,
  case
    when coalesce(p.company_name, '') <> '' then 'competitors'
    else 'profile'
  end
from public.profiles p
where p.workspace_id is not null
on conflict (user_id) do update
set
  workspace_id = excluded.workspace_id,
  company_name = coalesce(public.onboarding_states.company_name, excluded.company_name),
  updated_at = now();

insert into public.companies (
  workspace_id,
  name,
  slug,
  sector,
  is_primary,
  created_by
)
select
  p.workspace_id,
  p.company_name,
  public.slugify(p.company_name),
  latest_audit.sector,
  true,
  p.id
from public.profiles p
left join lateral (
  select a.sector
  from public.audits a
  where a.user_id = p.id
    and a.sector is not null
  order by a.created_at desc
  limit 1
) latest_audit on true
where p.workspace_id is not null
  and coalesce(p.company_name, '') <> ''
on conflict (workspace_id, slug) do update
set
  is_primary = true,
  sector = coalesce(public.companies.sector, excluded.sector),
  updated_at = now();

update public.workspaces w
set
  default_company_id = c.id,
  updated_at = now()
from public.companies c
where c.workspace_id = w.id
  and c.is_primary = true
  and w.default_company_id is null;

update public.onboarding_states os
set
  company_id = c.id,
  step = case
    when os.completed_at is not null then 'completed'
    when c.id is not null then 'competitors'
    else os.step
  end,
  updated_at = now()
from public.profiles p
left join public.companies c
  on c.workspace_id = p.workspace_id
 and c.is_primary = true
where os.user_id = p.id
  and os.company_id is null;
