-- Cole este arquivo inteiro no SQL Editor do Supabase e clique em Run.

create table if not exists public.calls (
  id            bigint primary key,
  name          text not null default '',
  num           text not null,
  started_at    bigint not null,                 -- início da ligação (ms desde 1970)
  duration      integer not null default 0,      -- segundos
  answered      boolean not null default false,
  qualification smallint check (qualification in (1, 2, 3)),  -- 1 Sangria, 2 Fechamento de caixa, 3 Apoio de cópia
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

create index if not exists calls_started_at_idx on public.calls (started_at desc);

-- Só usuários logados leem, criam e apagam ligações.
alter table public.calls enable row level security;

drop policy if exists "logados leem" on public.calls;
create policy "logados leem" on public.calls
  for select to authenticated using (true);

drop policy if exists "logados inserem" on public.calls;
create policy "logados inserem" on public.calls
  for insert to authenticated with check (true);

drop policy if exists "logados apagam" on public.calls;
create policy "logados apagam" on public.calls
  for delete to authenticated using (true);

-- Atualização do dashboard em tempo real.
do $$
begin
  alter publication supabase_realtime add table public.calls;
exception when duplicate_object then null;
end $$;
