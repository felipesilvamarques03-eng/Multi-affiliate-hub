# Multi Affiliate Hub · FJ store

Repositório privado. © Luiz Felipe da Silva Marques. Todos os direitos reservados.
O código é protegido pela Lei nº 9.609/1998 (software) e pela Lei nº 9.610/1998 (direitos autorais). Proibida a cópia, distribuição ou uso sem autorização por escrito.

- `public/`: vitrine pública (`/`), páginas legais e o portão de login do painel (`/app/`).
- `netlify/functions/panel.mjs`: entrega o código do painel só para quem tem login, 2FA e convite.
- `netlify/lib/panel_bundle.mjs`: painel gerado a partir da versão do Claude (não editar à mão).
- `supabase/`: migrações do banco e funções (ads-proxy, ml-connect, spotify-control, ig-sync). Segredos ficam só no painel do Supabase.
- `ig-sync`: busca o Instagram da loja no Windsor.ai a cada 3 horas (pg_cron) e guarda em `mah_ig_state`; a aba Instagram do painel lê de lá. A chave do Windsor é colada na própria aba (só o dono) e fica criptografada.

Publicação: cada envio para a branch `main` é publicado pelo Netlify.
