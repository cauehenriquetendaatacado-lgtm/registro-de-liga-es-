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

-- Atualização 2 (discador e contatos): pode rodar de novo com segurança
alter table public.chamadas add column if not exists contato text not null default '';
create table if not exists public.contatos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  numero text not null unique,
  criado timestamptz not null default now()
);
alter table public.contatos enable row level security;

-- Atualização 3 (número guarda qualificação e histórico): pode rodar de novo com segurança
alter table public.contatos add column if not exists qualificacao text;
alter table public.contatos add column if not exists atualizado timestamptz;
create index if not exists chamadas_numero_idx on public.chamadas (numero);
-- preenche a qualificação dos contatos que já têm ligações registradas (usa a mais recente)
update public.contatos c set qualificacao = x.qualificacao, atualizado = x.data
from (select distinct on (numero) numero, qualificacao, data from public.chamadas where numero <> '' order by numero, data desc) x
where x.numero = c.numero and c.qualificacao is null;
