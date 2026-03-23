-- BALANCE360 - Fix bootstrap trigger for new auth users
-- Idempotent patch: ensures trigger exists and repairs users without workspace.

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'on_auth_user_created'
  ) then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute procedure public.handle_new_user();
  end if;
end
$$;

with users_without_workspace as (
  select
    p.id as user_id,
    coalesce(nullif(p.company_name, ''), nullif(p.display_name, ''), split_part(u.email, '@', 1), 'My Workspace') as workspace_name,
    public.slugify(
      coalesce(nullif(p.company_name, ''), nullif(p.display_name, ''), split_part(u.email, '@', 1), 'workspace')
      || '-' || substr(p.id::text, 1, 8)
    ) as workspace_slug
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.workspace_id is null
),
inserted_workspaces as (
  insert into public.workspaces (name, slug, created_by)
  select workspace_name, workspace_slug, user_id
  from users_without_workspace
  returning id, created_by
)
update public.profiles p
set
  workspace_id = w.id,
  updated_at = now()
from inserted_workspaces w
where p.id = w.created_by
  and p.workspace_id is null;

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

insert into public.onboarding_states (user_id, workspace_id)
select
  p.id,
  p.workspace_id
from public.profiles p
where p.workspace_id is not null
on conflict (user_id) do update
set
  workspace_id = coalesce(public.onboarding_states.workspace_id, excluded.workspace_id),
  updated_at = now();

