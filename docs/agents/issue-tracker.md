# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`. The spec is `SPEC.md` at the repo root; `CONTEXT.md` holds the shared vocabulary (glossary / constraints).

## Conventions

- One feature per directory: `.scratch/<feature-slug>/` — this repo: `.scratch/transfer/`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md` — this repo uses `T01-`…`T10-` prefixed files (`.scratch/transfer/issues/`), never a single combined tickets file
- Triage state is recorded as a `状态:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Blocking edges: `阻塞:` / `被阻塞者:` lines near the top; work blockers-first
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/issues/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

> Note: this repo's existing tickets (`.scratch/transfer/issues/`) use the equivalent `状态:` / `阻塞:` / `被阻塞者:` vocabulary from `to-tickets`; wayfinder efforts are free to use `Status:` / `Blocked by:` as above.
