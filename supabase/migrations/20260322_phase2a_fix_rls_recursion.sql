-- BALANCE360 - Fix RLS recursion (stack depth exceeded)
-- Root cause: helper functions queried workspace_members under RLS and
-- policies also depended on those helpers, producing recursive evaluation.

create or replace function public.current_workspace_role(workspace_uuid uuid)
returns text
language sql
stable
security definer
set search_path = public
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
security definer
set search_path = public
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
security definer
set search_path = public
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

grant execute on function public.current_workspace_role(uuid) to anon, authenticated, service_role;
grant execute on function public.is_workspace_member(uuid) to anon, authenticated, service_role;
grant execute on function public.is_workspace_admin(uuid) to anon, authenticated, service_role;

