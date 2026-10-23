import { handle } from './core.js';

Deno.serve((req: Request) => handle(req, { fetch: (u: string, i?: RequestInit) => fetch(u, i), env: (k: string) => Deno.env.get(k) || '', now: () => Date.now() }));
