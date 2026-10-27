// The support queue from the command line: the "it won't connect" reports
// people send from the app (src/worker, /hearth/api/support). For the triage
// agent (docs/SUPPORT-TRIAGE.md) and for humans.
//
//   npm run support                      what's new, grouped by brand + model
//   npm run support -- list [status]     every ticket (new, triaged, in-progress, supported, wont-fix, duplicate)
//   npm run support -- show <id>         one ticket, in full
//   npm run support -- set <id> <status> ["what changed, for the person"]
//
// Needs SUPPORT_TOKEN (the Worker secret) in the environment or in .env.
import { existsSync, readFileSync } from 'node:fs';

const API = (process.env.HEARTH_CLOUD || 'https://mutaafaziz.com/hearth/api').replace(/\/$/, '');
const fromEnvFile = () => (existsSync('.env') ? readFileSync('.env', 'utf8').match(/^SUPPORT_TOKEN=(.+)$/m)?.[1]?.trim() : null);
const TOKEN = process.env.SUPPORT_TOKEN || fromEnvFile();
if (!TOKEN) {
  console.error('No SUPPORT_TOKEN (environment or .env).');
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.error ?? ''}`);
  return data;
}

const when = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const line = (r) => `${r.id}  ${when(r.at)}  ${r.status.padEnd(11)} ${r.brand.padEnd(9)} ${(r.model || '?').padEnd(16)} ${r.sym}${r.report.note ? `  “${r.report.note.slice(0, 60)}”` : ''}`;

const [cmd = 'new', ...args] = process.argv.slice(2);
if (cmd === 'new') {
  const { items } = await call('GET', '/support?status=new&limit=200');
  const groups = new Map();
  for (const r of items) {
    const k = `${r.brand} ${(r.model || '?').toUpperCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  if (!items.length) console.log('Nothing new.');
  for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${k}  ×${rs.length}  (${[...new Set(rs.map((r) => r.sym))].join(', ')})`);
    for (const r of rs) console.log(`  ${line(r)}`);
  }
} else if (cmd === 'list') {
  const { items } = await call('GET', `/support?limit=200${args[0] ? `&status=${encodeURIComponent(args[0])}` : ''}`);
  for (const r of items) console.log(line(r));
} else if (cmd === 'show') {
  const { items } = await call('GET', '/support?limit=200');
  const r = items.find((x) => x.id === args[0]);
  if (!r) throw new Error('no such ticket in the last 200');
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'set') {
  const [id, status, ...words] = args;
  console.log(await call('PATCH', `/support/${id}`, { status, ...(words.length ? { resolution: words.join(' ') } : {}) }));
} else {
  console.error('npm run support -- [new | list [status] | show <id> | set <id> <status> ["note"]]');
  process.exit(1);
}
