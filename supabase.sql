-- Supabase > SQL Editor > New query > cole e rode
create table if not exists public.chamadas (
  id uuid primary key default gen_random_uuid(),
  uid text unique,
  numero text not null default '',
  atendente text,
  data timestamptz not null default now(),
  qualificacao text not null,
  observacao text not null default ''
);
create index if not exists chamadas_data_idx on public.chamadas (data desc);
-- só o servidor acessa (chave service_role); ninguém acessa direto pela chave pública
alter table public.chamadas enable row level security;
