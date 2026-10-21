# Health, diagnostics and AI notes

Every TV gets a report card. **Simple** shows what a person needs to know: a grade, up to three things worth fixing, each with a fix. **Nerd mode** shows every signal Hearth collects.

## Where the numbers come from

| Layer | File | What it captures |
|---|---|---|
| Telemetry | `src/telemetry.js` | Every command (timed through `instrument()` on the driver): latency p50/p95/p99/max, success %, per-action stats, error counts. Online/power history: availability over 24 h and 7 d, "switched on" share. Connection drops, flagged as unexpected unless a power-off was sent in the 30 s before. Wake attempts with time-to-wake (90 s window). Screen time per app. Volume and mute history. Discovery sightings (SSDP or mDNS). Saved to `~/.hearth/telemetry.json` (0600, debounced). |
| Diagnostics | `src/diagnostics.js` | On demand and read-only. LG: system info, software version, network info, volume, power state, launch points, inputs (SSAP, via `LgDriver.diagnostics()`). Samsung: the full REST JSON on :8001. Roku: every `/query/device-info` field plus media player and app count. Google TV: Cast `eureka_info` (build, update waiting, uptime, Wi-Fi state). From the hub: TCP round trip ×5 (min/avg/max/jitter/loss), a scan of each brand's known ports, the ARP MAC, and the WOL broadcast address. |
| Rating | `src/health.js` | Six sub-scores, each with its evidence: Responsiveness, Reliability, Connection, Software, Wake from sleep, Control coverage. A weighted average over the scores that have data, then a grade A–F. Model year is decoded only where the naming scheme is certain (Samsung letter, LG series or OLED digit); otherwise the AI's estimate is used, marked "AI est.". Findings are sorted worst first. |

## AI notes (same architecture as COLD GAS)

```
browser ── POST /api/tvs/:id/insights (+ x-hearth-key if BYOK) ──▶ home hub
home hub ── anonymised report ──▶ https://mutaafaziz.com/hearth/api/insights (hearth Worker)
Worker ── Gemma 4 on Workers AI (default, free)  or  your Anthropic / OpenAI / xAI / Gemini key
```

- **The default brain** is `@cf/google/gemma-4-26b-a4b-it` with thinking off, falling back to `llama-3.1-8b`. It costs about 17 neurons per insight. Limits: 15 per IP per hour and 150 per UTC day. The free allowance of 10k neurons a day is shared with COLD GAS on the same account.
- **Bring your own key:**
  - The key is pasted in ⚙ and stays in that browser's localStorage. It's sent per call as `x-hearth-key`, and the hub passes it through untouched.
  - The Worker uses it once and never stores or logs it.
  - `POST /hearth/api/models` lists the provider's live models and suggests one. For Anthropic that's `claude-opus-5-5` at low effort with structured JSON output and the server-side refusal fallback.
- **What leaves the house:** the model, software version, scores, latency and usage stats, and app titles. Never names, IPs, MACs, serials, SSIDs or BSSIDs. `anonymise()` builds the payload, the hub re-sanitises it, and the Worker rebuilds it again with `sanitizePayload()` before any model sees it. ⚙ has an off switch; each TV page has "What's sent", which shows the exact JSON.
- **Caching:** results are cached for 6 h per TV, provider and model. The AI can move the grade by −10 to +5, with its reason shown.

## API

| Route | Returns |
|---|---|
| `GET /api/report` | The whole house: score, grade, verdict, worst finding |
| `GET /api/tvs/:id/health` | Rating, telemetry summary, last diagnostics, AI result, and the exact AI payload |
| `GET /api/tvs/:id/diagnostics` | Runs the read-only probes (about 0.1–3 s), then returns `health` |
| `POST /api/tvs/:id/insights` | `{ provider, model?, refresh? }` plus the optional `x-hearth-key` header; returns `health` |
| `POST /api/ai/models` | `{ provider: 'auto' \| … }` plus `x-hearth-key`; returns `{ provider, models, suggested }` |

`GET /api/health` stays the cheap liveness probe. The family portal's Home Server polls it every 10 s.

## Deploying the Worker

`wrangler.jsonc` now has `main: src/worker/index.js` and `run_worker_first: ["/hearth/api/*"]`, so static assets are unchanged. It also binds `ai` and a D1 database `hearth` for the rate-limit counters. That database has no `database_id`, so it's provisioned by name on the first deploy, as with COLD GAS. The Worker works without D1, but then there are no limits. `npm run deploy:site` deploys both.

Local test with real Workers AI: use a throwaway config without D1, then run `npx wrangler dev --remote -c <that config>`.
