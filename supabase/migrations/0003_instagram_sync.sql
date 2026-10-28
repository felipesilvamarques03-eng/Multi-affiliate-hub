-- Instagram da loja sincronizado automaticamente (função ig-sync + pg_cron).
-- As duas tabelas só são lidas e gravadas pela função, com a chave secreta (RLS ligado e sem políticas).

create table if not exists public.mah_ig_state (
  id smallint primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  fetched_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  last_source text
);
alter table public.mah_ig_state enable row level security;

create table if not exists public.mah_ig_config (
  id smallint primary key default 1 check (id = 1),
  windsor_key text,            -- chave da API do Windsor.ai, criptografada pela função (AES-GCM)
  account_id text,             -- conta do Instagram no Windsor (vazio = primeira conta)
  cron_hash text,              -- sha256 do segredo usado pelo agendamento
  updated_at timestamptz not null default now()
);
alter table public.mah_ig_config enable row level security;

insert into public.mah_ig_state (id) values (1) on conflict do nothing;
insert into public.mah_ig_config (id, account_id) values (1, '17841476522195869') on conflict do nothing;

-- Segredo do agendamento: fica no Vault; a função guarda só o hash.
create extension if not exists pg_cron;
do $$
declare s text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not exists (select 1 from vault.secrets where name = 'ig_sync_cron') then
    perform vault.create_secret(s, 'ig_sync_cron', 'Segredo do agendamento da função ig-sync');
    update public.mah_ig_config set cron_hash = encode(extensions.digest(s, 'sha256'), 'hex') where id = 1;
  end if;
end $$;

-- A cada 3 horas a função busca os dados do Instagram e grava em mah_ig_state.
select cron.unschedule('ig-sync') where exists (select 1 from cron.job where jobname = 'ig-sync');
select cron.schedule('ig-sync', '7 */3 * * *', $$
  select net.http_post(
    url := 'https://znfmookzymtymgalwlly.supabase.co/functions/v1/ig-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-ig-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ig_sync_cron')),
    body := '{"op":"cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
