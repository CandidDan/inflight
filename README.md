# inflight

Mission control: one page that answers **where is every project up to, and is the automation
alive?** — computed live in your browser at the moment you open it, so it cannot go stale.

**Open it:** https://candiddan.github.io/inflight/

Paste a read-only fine-grained PAT (Contents, Actions, Issues, Pull requests, Metadata — all
read-only) and press Load. The page asks the token who it is and discovers every repo carrying the
`flow` topic that account owns; you never type a username. "Remember on this device" is opt-in and
writes the token to this browser's `localStorage` only.

**Read-only, mechanically.** Every call the page makes is a REST `GET`. GraphQL is deliberately
unused — every GraphQL call is an HTTP `POST`, and `bin/mission-control.test.mjs` asserts the
absence of write-capable methods by scanning the source.

**Nothing is served but static files.** No backend, no build step, no secrets in this repository.

## Why this is its own repo

Flow's `VISION.md` (G7) says a Flow repo reports its own state, and that *cross-project
aggregation is not that goal — it is a consumer of it*. This is that consumer. See
ADR-0006 in the Flow authoring repo.

## Tests

```sh
npm test     # node --test over bin/
npm run lint # node --check over the two modules
```
