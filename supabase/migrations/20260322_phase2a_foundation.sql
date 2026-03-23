-- BALANCE360 - Phase 2A foundation
-- Additive migration compatible with the current schema.
-- Focus: workspaces, companies, competitors, onboarding and structured history.

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------

create table if not exists public.workspaces (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,
  industry text,
  country text,
  default_company_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_workspaces_slug on public.workspaces (slug);
create index if not exists idx_workspaces_created_by on public.workspaces (created_by);

create table if not exists public.workspace_members (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'analyst', 'viewer', 'billing')),
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists idx_workspace_members_workspace on public.workspace_members (workspace_id);
create index if not exists idx_workspace_members_user on public.workspace_members (user_id);
create index if not exists idx_workspace_members_role on public.workspace_members (role);

create or replace function public.current_workspace_role(workspace_uuid uuid)
returns text
language sql
stable
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = workspace_uuid
    and wm.user_id = auth.uid()
    and wm.status = 'active'
  limit 1
$$;

create or replace function public.is_workspace_member(workspace_uuid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = workspace_uuid
      and wm.user_id = auth.uid()
      and wm.status = 'active'
  )
$$;

create or replace function public.is_workspace_admin(workspace_uuid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = workspace_uuid
      and wm.user_id = auth.uid()
      and wm.status = 'active'
      and wm.role in ('owner', 'admin')
  )
$$;

-- ---------------------------------------------------------------------------
-- Companies and competitors
-- ---------------------------------------------------------------------------

create table if not exists public.companies (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  sector text,
  country text,
  website_url text,
  app_store_url text,
  play_store_url text,
  google_business_url text,
  is_primary boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create index if not exists idx_companies_workspace on public.companies (workspace_id);
create index if not exists idx_companies_sector on public.companies (sector);
create index if not exists idx_companies_primary on public.companies (workspace_id, is_primary);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspaces_default_company_id_fkey'
  ) then
    alter table public.workspaces
      add constraint workspaces_default_company_id_fkey
      foreign key (default_company_id)
      references public.companies(id)
      on delete set null;
  end if;
end
$$;

create table if not exists public.company_competitors (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  competitor_company_id uuid references public.companies(id) on delete cascade,
  competitor_name text not null,
  competitor_slug text not null,
  source text not null default 'manual' check (source in ('manual', 'ai', 'import')),
  confidence numeric(5,2) default 0.50 check (confidence >= 0 and confidence <= 1),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, competitor_slug)
);

create index if not exists idx_company_competitors_workspace on public.company_competitors (workspace_id);
create index if not exists idx_company_competitors_company on public.company_competitors (company_id);

-- ---------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------

create table if not exists public.onboarding_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  step text not null default 'profile' check (step in ('profile', 'company', 'competitors', 'analysis', 'completed')),
  company_name text,
  sector text,
  primary_competitor text,
  first_analysis_audit_id uuid references public.audits(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Analysis orchestration and snapshots
-- ---------------------------------------------------------------------------

create table if not exists public.analysis_requests (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  requested_by uuid references auth.users(id) on delete set null,
  request_type text not null default 'single_audit' check (request_type in ('single_audit', 'benchmark', 'monitoring_refresh', 'onboarding_audit')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  company_name text not null,
  company_slug text not null,
  sector text,
  competitors jsonb not null default '[]'::jsonb,
  input_payload jsonb not null default '{}'::jsonb,
  result_audit_id uuid references public.audits(id) on delete set null,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_analysis_requests_workspace on public.analysis_requests (workspace_id, created_at desc);
create index if not exists idx_analysis_requests_company on public.analysis_requests (company_slug, created_at desc);
create index if not exists idx_analysis_requests_status on public.analysis_requests (status, created_at desc);
create index if not exists idx_analysis_requests_user on public.analysis_requests (requested_by, created_at desc);

create table if not exists public.analysis_snapshots (
  id uuid primary key default uuid_generate_v4(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  company_slug text not null,
  sector text,
  balance_score integer not null check (balance_score >= 0 and balance_score <= 100),
  app_score integer check (app_score >= 0 and app_score <= 100),
  web_score integer check (web_score >= 0 and web_score <= 100),
  rrss_score integer check (rrss_score >= 0 and rrss_score <= 100),
  reviews_score integer check (reviews_score >= 0 and reviews_score <= 100),
  google_business_score integer check (google_business_score >= 0 and google_business_score <= 100),
  organic_mentions_score integer check (organic_mentions_score >= 0 and organic_mentions_score <= 100),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_analysis_snapshots_audit on public.analysis_snapshots (audit_id);
create index if not exists idx_analysis_snapshots_company on public.analysis_snapshots (company_slug, created_at desc);
create index if not exists idx_analysis_snapshots_workspace on public.analysis_snapshots (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Profile extensions for SaaS onboarding
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists workspace_id uuid references public.workspaces(id) on delete set null,
  add column if not exists role text not null default 'owner' check (role in ('owner', 'admin', 'analyst', 'viewer', 'billing')),
  add column if not exists job_title text,
  add column if not exists onboarding_completed boolean not null default false;

create index if not exists idx_profiles_workspace on public.profiles (workspace_id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_workspaces_updated_at'
  ) then
    create trigger trg_workspaces_updated_at
      before update on public.workspaces
      for each row execute procedure public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_workspace_members_updated_at'
  ) then
    create trigger trg_workspace_members_updated_at
      before update on public.workspace_members
      for each row execute procedure public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_companies_updated_at'
  ) then
    create trigger trg_companies_updated_at
      before update on public.companies
      for each row execute procedure public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_company_competitors_updated_at'
  ) then
    create trigger trg_company_competitors_updated_at
      before update on public.company_competitors
      for each row execute procedure public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_onboarding_states_updated_at'
  ) then
    create trigger trg_onboarding_states_updated_at
      before update on public.onboarding_states
      for each row execute procedure public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_analysis_requests_updated_at'
  ) then
    create trigger trg_analysis_requests_updated_at
      before update on public.analysis_requests
      for each row execute procedure public.set_updated_at();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Workspace bootstrap on sign up
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  workspace_uuid uuid;
  base_name text;
  base_slug text;
begin
  base_name := coalesce(new.raw_user_meta_data->>'company_name', new.raw_user_meta_data->>'full_name', 'My Workspace');
  base_slug := public.slugify(base_name || '-' || substr(new.id::text, 1, 8));

  insert into public.workspaces (name, slug, created_by)
  values (base_name, base_slug, new.id)
  returning id into workspace_uuid;

  insert into public.profiles (id, display_name, company_name, workspace_id, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'company_name',
    workspace_uuid,
    'owner'
  )
  on conflict (id) do update
    set display_name = excluded.display_name,
        company_name = coalesce(excluded.company_name, public.profiles.company_name),
        workspace_id = coalesce(public.profiles.workspace_id, excluded.workspace_id),
        role = public.profiles.role,
        updated_at = now();

  insert into public.workspace_members (workspace_id, user_id, role, status, invited_by)
  values (workspace_uuid, new.id, 'owner', 'active', new.id)
  on conflict (workspace_id, user_id) do nothing;

  insert into public.onboarding_states (user_id, workspace_id)
  values (new.id, workspace_uuid)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Snapshot sync helper
-- ---------------------------------------------------------------------------

create or replace function public.sync_analysis_snapshot()
returns trigger
language plpgsql
security definer
as $$
declare
  workspace_uuid uuid;
  company_uuid uuid;
begin
  select p.workspace_id into workspace_uuid
  from public.profiles p
  where p.id = new.user_id;

  select c.id into company_uuid
  from public.companies c
  where c.workspace_id = workspace_uuid
    and c.slug = new.company_slug
  limit 1;

  insert into public.analysis_snapshots (
    audit_id,
    workspace_id,
    company_id,
    company_slug,
    sector,
    balance_score,
    app_score,
    web_score,
    rrss_score,
    reviews_score,
    google_business_score,
    organic_mentions_score,
    summary
  )
  values (
    new.id,
    workspace_uuid,
    company_uuid,
    new.company_slug,
    new.sector,
    new.score,
    (new.frentes -> 'app' ->> 'score')::integer,
    (new.frentes -> 'web' ->> 'score')::integer,
    (new.frentes -> 'rrss' ->> 'score')::integer,
    (new.frentes -> 'reviews' ->> 'score')::integer,
    (new.frentes -> 'google_business' ->> 'score')::integer,
    (new.frentes -> 'organic_mentions' ->> 'score')::integer,
    jsonb_build_object(
      'voz_usuario', new.voz_usuario,
      'gap_principal', new.gap_principal,
      'pasos', coalesce(new.pasos, '[]'::jsonb)
    )
  )
  on conflict (audit_id) do update
    set workspace_id = excluded.workspace_id,
        company_id = excluded.company_id,
        company_slug = excluded.company_slug,
        sector = excluded.sector,
        balance_score = excluded.balance_score,
        app_score = excluded.app_score,
        web_score = excluded.web_score,
        rrss_score = excluded.rrss_score,
        reviews_score = excluded.reviews_score,
        google_business_score = excluded.google_business_score,
        organic_mentions_score = excluded.organic_mentions_score,
        summary = excluded.summary;

  return new;
exception
  when others then
    return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_audits_sync_analysis_snapshot'
  ) then
    create trigger trg_audits_sync_analysis_snapshot
      after insert or update on public.audits
      for each row execute procedure public.sync_analysis_snapshot();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.companies enable row level security;
alter table public.company_competitors enable row level security;
alter table public.onboarding_states enable row level security;
alter table public.analysis_requests enable row level security;
alter table public.analysis_snapshots enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'workspaces' and policyname = 'workspaces_select_member'
  ) then
    create policy "workspaces_select_member"
      on public.workspaces for select
      using (public.is_workspace_member(id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'workspaces' and policyname = 'workspaces_update_admin'
  ) then
    create policy "workspaces_update_admin"
      on public.workspaces for update
      using (public.is_workspace_admin(id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'workspace_members' and policyname = 'workspace_members_select_member'
  ) then
    create policy "workspace_members_select_member"
      on public.workspace_members for select
      using (public.is_workspace_member(workspace_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'workspace_members' and policyname = 'workspace_members_manage_admin'
  ) then
    create policy "workspace_members_manage_admin"
      on public.workspace_members for all
      using (public.is_workspace_admin(workspace_id))
      with check (public.is_workspace_admin(workspace_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'companies' and policyname = 'companies_select_member'
  ) then
    create policy "companies_select_member"
      on public.companies for select
      using (public.is_workspace_member(workspace_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'companies' and policyname = 'companies_manage_analyst'
  ) then
    create policy "companies_manage_analyst"
      on public.companies for all
      using (public.current_workspace_role(workspace_id) in ('owner', 'admin', 'analyst'))
      with check (public.current_workspace_role(workspace_id) in ('owner', 'admin', 'analyst'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'company_competitors' and policyname = 'company_competitors_select_member'
  ) then
    create policy "company_competitors_select_member"
      on public.company_competitors for select
      using (public.is_workspace_member(workspace_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'company_competitors' and policyname = 'company_competitors_manage_analyst'
  ) then
    create policy "company_competitors_manage_analyst"
      on public.company_competitors for all
      using (public.current_workspace_role(workspace_id) in ('owner', 'admin', 'analyst'))
      with check (public.current_workspace_role(workspace_id) in ('owner', 'admin', 'analyst'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'onboarding_states' and policyname = 'onboarding_states_select_own'
  ) then
    create policy "onboarding_states_select_own"
      on public.onboarding_states for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'onboarding_states' and policyname = 'onboarding_states_update_own'
  ) then
    create policy "onboarding_states_update_own"
      on public.onboarding_states for update
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'analysis_requests' and policyname = 'analysis_requests_select_member'
  ) then
    create policy "analysis_requests_select_member"
      on public.analysis_requests for select
      using (
        workspace_id is null
        or public.is_workspace_member(workspace_id)
        or requested_by = auth.uid()
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'analysis_requests' and policyname = 'analysis_requests_insert_member'
  ) then
    create policy "analysis_requests_insert_member"
      on public.analysis_requests for insert
      with check (
        requested_by = auth.uid()
        and (
          workspace_id is null
          or public.current_workspace_role(workspace_id) in ('owner', 'admin', 'analyst')
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'analysis_snapshots' and policyname = 'analysis_snapshots_select_member'
  ) then
    create policy "analysis_snapshots_select_member"
      on public.analysis_snapshots for select
      using (
        workspace_id is null
        or public.is_workspace_member(workspace_id)
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Useful views
-- ---------------------------------------------------------------------------

create or replace view public.workspace_company_scores as
select
  c.workspace_id,
  c.id as company_id,
  c.name as company,
  c.slug as company_slug,
  s.balance_score,
  s.app_score,
  s.web_score,
  s.rrss_score,
  s.reviews_score,
  s.google_business_score,
  s.organic_mentions_score,
  s.created_at
from public.companies c
join lateral (
  select *
  from public.analysis_snapshots s
  where s.company_id = c.id
  order by s.created_at desc
  limit 1
) s on true;
