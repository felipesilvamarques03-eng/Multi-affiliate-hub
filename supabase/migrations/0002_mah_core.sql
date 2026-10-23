-- Multi Affiliate Hub: login de convidados com 2FA, dados privados, vitrine pública,
-- Mercado Livre e Spotify Controle. Tudo com prefixo mah_/spc_ para não mexer nas tabelas da loja.

create extension if not exists pgcrypto;

-- ---------- quem pode entrar ----------
create table if not exists public.mah_members (
  email text primary key check (email = lower(email) and position('@' in email) > 1 and length(email) <= 254),
  role text not null default 'membro' check (role in ('dono', 'membro')),
  added_at timestamptz not null default now(),
  added_by uuid references auth.users(id) on delete set null
);
alter table public.mah_members enable row level security;

-- membro = e-mail confirmado + e-mail na lista de convidados
create or replace function public.mah_is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    join public.mah_members m on m.email = lower(u.email)
    where u.id = (select auth.uid()) and u.email_confirmed_at is not null
  );
$$;
create or replace function public.mah_is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    join public.mah_members m on m.email = lower(u.email) and m.role = 'dono'
    where u.id = (select auth.uid()) and u.email_confirmed_at is not null
  );
$$;
create or replace function public.mah_aal2()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2';
$$;
revoke all on function public.mah_is_member() from public, anon;
revoke all on function public.mah_is_owner() from public, anon;
grant execute on function public.mah_is_member() to authenticated;
grant execute on function public.mah_is_owner() to authenticated;
grant execute on function public.mah_aal2() to authenticated;

-- o painel pergunta "posso entrar?" (sem revelar a lista para quem não é convidado)
create or replace function public.mah_whoami()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'member', public.mah_is_member(),
    'owner', public.mah_is_owner(),
    'aal', coalesce((select auth.jwt() ->> 'aal'), 'aal1')
  );
$$;
revoke all on function public.mah_whoami() from public, anon;
grant execute on function public.mah_whoami() to authenticated;

create policy "mah_members: 2FA" on public.mah_members as restrictive for all to authenticated
  using (public.mah_aal2()) with check (public.mah_aal2());
create policy "mah_members: dono vê todos, membro vê a si" on public.mah_members for select to authenticated
  using (public.mah_is_owner() or (public.mah_is_member() and email = lower(coalesce((select auth.jwt() ->> 'email'), ''))));
create policy "mah_members: dono convida" on public.mah_members for insert to authenticated
  with check (public.mah_is_owner() and role = 'membro');
create policy "mah_members: dono remove convidado" on public.mah_members for delete to authenticated
  using (public.mah_is_owner() and role = 'membro');
revoke all on public.mah_members from anon;

-- bloqueio de cadastro de quem não foi convidado (ativar em Authentication → Hooks → Before User Created)
create or replace function public.mah_before_user_created(event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if exists (select 1 from public.mah_members m where m.email = e) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('message', 'Cadastro apenas para convidados.', 'http_code', 403));
end;
$$;
revoke all on function public.mah_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.mah_before_user_created(jsonb) to supabase_auth_admin;
grant select on public.mah_members to supabase_auth_admin;
create policy "mah_members: auth hook lê" on public.mah_members for select to supabase_auth_admin using (true);

-- ---------- dados do painel (um documento por seção) ----------
create table if not exists public.mah_docs (
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_-]{1,40}$'),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner, key),
  constraint mah_docs_size check (pg_column_size(data) < 4000000)
);
alter table public.mah_docs enable row level security;
create policy "mah_docs: 2FA" on public.mah_docs as restrictive for all to authenticated
  using (public.mah_aal2()) with check (public.mah_aal2());
create policy "mah_docs: dono dos dados" on public.mah_docs for all to authenticated
  using (owner = (select auth.uid()) and public.mah_is_member())
  with check (owner = (select auth.uid()) and public.mah_is_member());
revoke all on public.mah_docs from anon;

create or replace function public.mah_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists mah_docs_touch on public.mah_docs;
create trigger mah_docs_touch before update on public.mah_docs for each row execute function public.mah_touch();

-- ---------- registro de atividades (só inserir e ler; ninguém altera) ----------
create table if not exists public.mah_audit (
  id bigint generated always as identity primary key,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  action text not null check (action ~ '^[a-z0-9_.:-]{2,60}$'),
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) < 8000)
);
alter table public.mah_audit enable row level security;
create policy "mah_audit: 2FA para ler" on public.mah_audit as restrictive for select to authenticated using (public.mah_aal2());
create policy "mah_audit: lê o seu" on public.mah_audit for select to authenticated
  using (owner = (select auth.uid()) and public.mah_is_member());
create policy "mah_audit: grava o seu" on public.mah_audit for insert to authenticated
  with check (owner = (select auth.uid()) and public.mah_is_member());
revoke all on public.mah_audit from anon;
revoke update, delete on public.mah_audit from authenticated;
create index if not exists mah_audit_owner_at on public.mah_audit (owner, at desc);

-- ---------- vitrine pública (página que recebe o tráfego pago) ----------
create table if not exists public.mah_vitrine (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (length(title) between 2 and 120),
  descr text check (descr is null or length(descr) <= 1500),
  price numeric(12,2) check (price is null or price >= 0),
  old_price numeric(12,2) check (old_price is null or old_price >= 0),
  platform text not null default 'mercadolivre' check (platform in ('mercadolivre','shopee','tiktok','loja','outro')),
  url text not null constraint mah_vitrine_url_check check (url ~ '^https://[^\s<>"]+$' and length(url) between 12 and 2000),
  image_url text constraint mah_vitrine_image_url_check check (image_url is null or (image_url ~ '^https://[^\s<>"]+$' and length(image_url) between 12 and 2000)),
  badge text check (badge is null or length(badge) <= 30),
  sort int not null default 0,
  published boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.mah_vitrine enable row level security;
create policy "mah_vitrine: público vê publicados" on public.mah_vitrine for select to anon, authenticated using (published);
create policy "mah_vitrine: membro vê os seus" on public.mah_vitrine for select to authenticated
  using (owner = (select auth.uid()) and public.mah_is_member() and public.mah_aal2());
create policy "mah_vitrine: membro cria" on public.mah_vitrine for insert to authenticated
  with check (owner = (select auth.uid()) and public.mah_is_member() and public.mah_aal2());
create policy "mah_vitrine: membro edita" on public.mah_vitrine for update to authenticated
  using (owner = (select auth.uid()) and public.mah_is_member() and public.mah_aal2())
  with check (owner = (select auth.uid()) and public.mah_is_member() and public.mah_aal2());
create policy "mah_vitrine: membro apaga" on public.mah_vitrine for delete to authenticated
  using (owner = (select auth.uid()) and public.mah_is_member() and public.mah_aal2());
revoke insert, update, delete on public.mah_vitrine from anon;
drop trigger if exists mah_vitrine_touch on public.mah_vitrine;
create trigger mah_vitrine_touch before update on public.mah_vitrine for each row execute function public.mah_touch();

-- ---------- configuração pública do site (nome, contato, tags de anúncio) ----------
create table if not exists public.mah_site (
  id int primary key default 1 check (id = 1),
  site_name text not null default 'FJ store' check (length(site_name) between 2 and 60),
  tagline text check (tagline is null or length(tagline) <= 160),
  responsible text check (responsible is null or length(responsible) <= 120),
  doc_id text check (doc_id is null or doc_id ~ '^[0-9./-]{11,20}$'),
  contact_email text check (contact_email is null or (position('@' in contact_email) > 1 and length(contact_email) <= 254)),
  whatsapp text check (whatsapp is null or whatsapp ~ '^[0-9]{10,15}$'),
  ga4_id text check (ga4_id is null or ga4_id ~ '^G-[A-Z0-9]{4,16}$'),
  gads_id text check (gads_id is null or gads_id ~ '^AW-[0-9]{6,16}$'),
  gads_click_label text check (gads_click_label is null or gads_click_label ~ '^[A-Za-z0-9_-]{4,40}$'),
  meta_pixel_id text check (meta_pixel_id is null or meta_pixel_id ~ '^[0-9]{8,20}$'),
  updated_at timestamptz not null default now()
);
insert into public.mah_site (id) values (1) on conflict (id) do nothing;
alter table public.mah_site enable row level security;
create policy "mah_site: público lê" on public.mah_site for select to anon, authenticated using (true);
create policy "mah_site: dono edita" on public.mah_site for update to authenticated
  using (public.mah_is_owner() and public.mah_aal2()) with check (public.mah_is_owner() and public.mah_aal2());
revoke insert, update, delete on public.mah_site from anon;
revoke insert, delete on public.mah_site from authenticated;
drop trigger if exists mah_site_touch on public.mah_site;
create trigger mah_site_touch before update on public.mah_site for each row execute function public.mah_touch();

-- ---------- Mercado Livre (tokens só pelo servidor; criptografados pela função) ----------
create table if not exists public.mah_ml_tokens (
  owner uuid primary key references auth.users(id) on delete cascade,
  ml_user_id bigint,
  nickname text,
  access_enc text not null,
  refresh_enc text not null,
  expires_at timestamptz not null,
  scope text,
  updated_at timestamptz not null default now()
);
alter table public.mah_ml_tokens enable row level security;
revoke all on public.mah_ml_tokens from anon, authenticated;

create table if not exists public.mah_ml_pending (
  state text primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  verifier text not null,
  created_at timestamptz not null default now()
);
alter table public.mah_ml_pending enable row level security;
revoke all on public.mah_ml_pending from anon, authenticated;

-- ---------- Spotify Controle (conector pessoal) ----------
create table if not exists public.spc_state (
  id int primary key default 1 check (id = 1),
  refresh_token text,
  access_token text,
  expires_at timestamptz,
  api_key_hash text,
  spotify_user text,
  scopes text,
  updated_at timestamptz not null default now()
);
alter table public.spc_state enable row level security;
revoke all on public.spc_state from anon, authenticated;
create table if not exists public.spc_pending (
  state text primary key,
  verifier text not null,
  created_at timestamptz not null default now()
);
alter table public.spc_pending enable row level security;
revoke all on public.spc_pending from anon, authenticated;

-- ---------- fotos da vitrine (Storage) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vitrine', 'vitrine', true, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy "vitrine: membro envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'vitrine' and public.mah_is_member() and public.mah_aal2() and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "vitrine: membro troca" on storage.objects for update to authenticated
  using (bucket_id = 'vitrine' and public.mah_is_member() and public.mah_aal2() and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "vitrine: membro apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'vitrine' and public.mah_is_member() and public.mah_aal2() and (storage.foldername(name))[1] = (select auth.uid())::text);

-- dono inicial
insert into public.mah_members (email, role) values ('felipesilva.marques03@gmail.com', 'dono')
on conflict (email) do update set role = 'dono';
