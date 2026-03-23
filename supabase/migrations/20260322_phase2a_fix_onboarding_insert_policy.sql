-- BALANCE360 - Fix onboarding_states RLS for UPSERT
-- The client uses UPSERT on onboarding_states. Without INSERT policy,
-- PostgreSQL raises: "new row violates row-level security policy".

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'onboarding_states'
      and policyname = 'onboarding_states_insert_own'
  ) then
    create policy "onboarding_states_insert_own"
      on public.onboarding_states
      for insert
      with check (auth.uid() = user_id);
  end if;
end
$$;

