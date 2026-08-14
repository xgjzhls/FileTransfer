# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — constraints, settled decisions, open questions, glossary.
- **`decisions/adr/`** — read ADRs that touch the area you're about to work in. (This repo keeps ADRs under `decisions/adr/`, not `docs/adr/`.)
- Optionally **`SPEC.md`** at the repo root — the formal protocol/storage/signaling spec; protocol details take precedence over prose.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md
├── SPEC.md
├── decisions/adr/
│   ├── 0001-browser-webrtc-no-native-apps.md
│   └── 0005-resume-and-datachannel.md
├── AGENTS.md
└── docs/agents/          ← this setup's config (issue tracker, triage labels, domain docs)
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
