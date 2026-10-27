# Support triage: turning "it won't connect" into support

People send a report from the app when a TV won't connect ("Still stuck? Send
it to us" in setup, the connection doctor and a TV's guide). Each report is an
anonymised ticket in the hearth Worker's D1 queue: brand, model code, software
version, what went wrong (`symptom.when`), which doctor/setup steps failed,
which ports answered, a scrubbed error and an optional note. Never names,
rooms, IPs, MACs or serials. The app checks its tickets every ~6 h and tells
the person when theirs is `supported`, with the `resolution` text.

This runbook is for an agent (or a person) working the queue.

## Read the queue

```sh
npm run support                 # new tickets, grouped by brand + model, biggest group first
npm run support -- show <id>    # one ticket in full
```

Needs `SUPPORT_TOKEN` (the Worker secret) in the environment or `.env`.

## For each group (same brand + model + symptom)

1. Mark it `triaged`: `npm run support -- set <id> triaged`.
2. Work out what's wrong. In order:
   - **Already handled?** Read `src/devices.js` (`deviceGuide`) for that model.
     If the guide covers the symptom and the reporter is on an old app version,
     it's fixed: `set <id> supported "Fixed in the latest Hearth. Update and try again."`.
   - **A model the guide doesn't know** (`guideKnown: false`): research the model
     code (maker's support pages first), add it to the tables in `src/devices.js`
     with year-specific menu paths, and a test in `test/devices.test.js`.
   - **A protocol difference** (ports in the report don't match what the driver
     expects, e.g. a Samsung that only answers on 8002, a Roku that 403s): fix the
     driver in `src/drivers/`, with a fake-device test like `test/samsung.test.js`.
   - **A new brand** (`brand: other`): don't build a driver from one report.
     Collect them; open a GitHub issue "Brand request: <brand>" with the count,
     models and any ports seen, and mark the tickets `in-progress`.
3. `npm test` must pass. Commit with a message naming the model and symptom,
   push, then `set <id> supported "<one friendly sentence of what changed>"` for
   every ticket in the group. The sentence is shown to the person in the app, so
   write it for them: "Your Samsung 2016 now connects without the Allow box. Update Hearth."
4. Can't be fixed (a TV with no network control at all, a guest network):
   `set <id> wont-fix "<what they can do instead>"`. Repeats: `duplicate`.

## Rules

- Never paste a ticket's note into a public commit or issue verbatim; summarise.
- Never ask the reporter for contact details; the ticket id is the only link.
- Don't send anything to a real TV while working the queue. Use the fake devices
  in `test/` (and `npm run fake-tvs` in hearth-app for the phone).
- The AI guide (`POST /hearth/api/device`) caches one answer per model and symptom
  for 30 days in D1 (`device_guides`). After fixing the built-in guide for a model,
  stale AI answers don't matter: the built-in guide's `connect.how` always wins
  (`mergeGuide` in src/routes.js).
