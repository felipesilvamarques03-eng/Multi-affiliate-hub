-- Multi Affiliate Hub - Fase 1: núcleo
-- Multi-inquilino: toda tabela de negócio tem organization_id e RLS.
-- O sistema só REGISTRA e COMPARA valores; nunca movimenta dinheiro.

create extension if not exists "pgcrypto";

-- ───────── Organizações e membros ─────────
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','member')),
  primary key (organization_id, user_id)
);

-- Função auxiliar: organizações do usuário logado
create or replace function public.my_org_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select organization_id from memberships where user_id = auth.uid()
$$;

-- ───────── Plataformas ─────────
create type platform as enum ('mercado_livre','tiktok_shop','shopee','manual');

-- Conexões: tokens ficam criptografados (use Supabase Vault ou criptografia no servidor).
-- Nunca exponha esta tabela ao frontend.
create table platform_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  platform platform not null,
  external_account_id text,
  encrypted_credentials bytea,
  status text not null default 'pending' check (status in ('pending','active','error','revoked')),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- ───────── Links de afiliado ─────────
create table affiliate_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  platform platform not null,
  campaign text,
  tag text,
  product_name text,
  url text not null,
  clicks integer not null default 0,
  created_at timestamptz not null default now()
);

-- ───────── Vendas (normalizadas + dado bruto de origem) ─────────
create table sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  platform platform not null,
  external_id text,                       -- id do pedido na plataforma
  sold_at date not null,
  product_name text not null,
  gross_amount numeric(14,2) not null default 0,
  raw jsonb,                              -- resposta/linha original, preserva a origem
  source text not null default 'csv' check (source in ('csv','api','manual')),
  created_at timestamptz not null default now(),
  unique (organization_id, platform, external_id)
);

-- ───────── Comissões (livro-razão) ─────────
create type commission_status as enum ('pendente','aprovada','cancelada','paga');

create table commissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sale_id uuid references sales(id) on delete set null,
  platform platform not null,
  amount numeric(14,2) not null check (amount >= 0),
  status commission_status not null default 'pendente',
  expected_payment_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Histórico de cada mudança de status (auditoria e conciliação)
create table commission_status_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  commission_id uuid not null references commissions(id) on delete cascade,
  old_status commission_status,
  new_status commission_status not null,
  changed_at timestamptz not null default now()
);

create or replace function log_commission_status() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into commission_status_history (organization_id, commission_id, old_status, new_status)
    values (new.organization_id, new.id,
            case when tg_op = 'INSERT' then null else old.status end,
            new.status);
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger trg_commission_status
after insert or update of status on commissions
for each row execute function log_commission_status();

-- ───────── Pagamentos recebidos (registro manual / importado) ─────────
create table payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  platform platform not null,
  received_at date not null,
  amount numeric(14,2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now()
);

-- Vínculo pagamento ↔ comissões, para conciliar
create table payment_allocations (
  payment_id uuid not null references payments(id) on delete cascade,
  commission_id uuid not null references commissions(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  primary key (payment_id, commission_id)
);

-- ───────── Índices ─────────
create index on sales (organization_id, sold_at);
create index on commissions (organization_id, status);
create index on commissions (organization_id, platform);
create index on payments (organization_id, received_at);

-- ───────── RLS: cada usuário só vê dados das suas organizações ─────────
do $$
declare t text;
begin
  foreach t in array array[
    'platform_connections','affiliate_links','sales','commissions',
    'commission_status_history','payments'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (organization_id in (select my_org_ids())) with check (organization_id in (select my_org_ids()))',
      t || '_org_isolation', t);
  end loop;
end $$;

alter table organizations enable row level security;
create policy organizations_member_read on organizations
  for select using (id in (select my_org_ids()));

alter table memberships enable row level security;
create policy memberships_self_read on memberships
  for select using (user_id = auth.uid());

alter table payment_allocations enable row level security;
create policy payment_allocations_via_payment on payment_allocations
  for all using (payment_id in (select id from payments where organization_id in (select my_org_ids())))
  with check (payment_id in (select id from payments where organization_id in (select my_org_ids())));

-- Frontend não deve ler credenciais das plataformas
revoke all on platform_connections from anon, authenticated;
