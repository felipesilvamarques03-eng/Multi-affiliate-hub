import { handle } from './core.js';
import { rest, seal, open, envKeys } from './mah.js';

const env = (k: string) => Deno.env.get(k) || '';
const deps0 = { fetch: (u: string, i?: RequestInit) => fetch(u, i), env, now: () => Date.now() };
const db = rest(deps0);

async function dec(v: string | null) { if (!v) return v; try { return await open(deps0, v); } catch (_) { return null; } }

const store = {
  async getState() {
    const r = (await db.select('spc_state', 'id=eq.1&select=*'))[0];
    if (!r) return null;
    return { ...r, refresh_token: await dec(r.refresh_token), access_token: await dec(r.access_token) };
  },
  async saveState(patch: Record<string, unknown>) {
    const p: Record<string, unknown> = { ...patch, id: 1, updated_at: new Date().toISOString() };
    if (typeof p.refresh_token === 'string') p.refresh_token = await seal(deps0, p.refresh_token);
    if (typeof p.access_token === 'string') p.access_token = await seal(deps0, p.access_token);
    await db.upsert('spc_state', p, 'id');
  },
  async putPending(state: string, verifier: string) {
    await db.remove('spc_pending', 'created_at=lt.' + new Date(Date.now() - 3600000).toISOString());
    await db.insert('spc_pending', { state, verifier });
  },
  async takePending(state: string) {
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(state)) return null;
    const r = await db.remove('spc_pending', 'state=eq.' + state);
    return (r && r[0]) || null;
  },
};

Deno.serve((req: Request) => handle(req, {
  clientId: env('SPOTIFY_CLIENT_ID'),
  baseUrl: envKeys(env).url + '/functions/v1/spotify-control',
  db: store,
  fetch: (u: string, i?: RequestInit) => fetch(u, i),
  now: () => Date.now(),
  randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
}));
