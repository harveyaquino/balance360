-- Mejora de performance para rate-limit persistente por usuario
create index if not exists idx_analysis_requests_requested_by_started_at
  on public.analysis_requests (requested_by, started_at desc);
