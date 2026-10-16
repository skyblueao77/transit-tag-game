# ADR-001: Club-Owned Supabase and Vercel Deployments

- **Status:** Proposed
- **Date:** 2026-10-16
- **Decision owners:** Project maintainers
- **Scope:** Future Supabase migration and deployment model

## Context

The current authoritative release candidate is a Firebase implementation: a React/Vite client uses Firebase Authentication and Firestore; Firebase Hosting serves the frontend; Callable Functions perform trusted actions; Firestore triggers and a scheduled Function handle background lifecycle work. Firebase Rules deny client writes to authoritative game state and protect private, exposed, and Emergency location data.

The project is exploring an OSS deployment path for university clubs whose operators may not be software developers. The target is an independently owned environment that can be initialized and diagnosed through a browser without source-code edits, manual SQL, or terminal commands. Provider free-tier suitability and an installation flow meeting that target have not yet been verified.

## Decision

The following is a **Proposed decision**, subject to PoC and policy review:

- each club owns an independent deployment and its provider accounts/data lifecycle;
- frontend hosting is provisionally Vercel;
- backend/database/auth are provisionally Supabase;
- participant and Admin authentication have different persistence and recovery requirements;
- trusted game operations remain server-authoritative;
- PostgreSQL authorization is deny-by-default, with constraints and trusted functions in addition to RLS;
- service-role credentials remain server-only;
- first-Admin bootstrap is one-time and server-validated;
- Firebase remains authoritative until behavioral and security parity is demonstrated;
- migration proceeds through isolated PoCs and small, reviewable PRs;
- local development workflow for WSL 3/WSLC is selected separately in a future PoC; and
- this ADR does not reintroduce Docker or decide to use Docker/WSLC for local Supabase.

This ADR does not authorize production migration, a Supabase implementation, or Firebase retirement.

## Alternatives considered

| Alternative | Advantages | Disadvantages / unresolved risks |
| --- | --- | --- |
| 1. Continue with Firebase and require Blaze | Keeps the tested architecture and existing Functions/Rules model; low migration risk. | May not meet the intended no-cost onboarding for every club; current billing/quota suitability must still be verified. |
| 2. One maintainer-owned deployment for all clubs | Central updates and support could be simpler. | Centralizes private participant/location data and operational responsibility; increases tenant-isolation and privacy obligations; conflicts with club ownership goal. |
| 3. Require each club to configure infrastructure manually | Flexible and transparent to technical operators. | Console, CLI, SQL, and secret handling are difficult for non-engineers and prone to configuration drift. |
| 4. Use a no-code platform | Could reduce initial setup and hosting effort. | Trusted transactional game logic, location privacy, migration portability, provider limits, and testability need proof; not selected. |
| 5. Self-host the full backend | Maximum control over provider and data lifecycle. | Each club would inherit server operations, backups, upgrades, monitoring, security response, and more complex setup; not currently suitable as the default target. |
| 6. Club-owned Vercel and Supabase deployments | Aligns data/project ownership with each club and allows independent deletion and quota accounting. | Every club must manage accounts and updates; browser-only provisioning and safe bootstrap are difficult; provider terms and limits remain open. |

## Consequences

### Positive

- Club data is isolated by independently owned provider projects rather than stored in one maintainer-owned production database.
- Each club controls its provider relationship, quotas, billing, and deletion decisions.
- Independent deletion and ownership transfer can be documented per club.
- A limited failure or quota issue at one club need not directly mutate another club's data.

### Negative

- Each club must manage provider accounts, access recovery, and ownership succession.
- Updates and schema migrations across forks or independent deployments are harder than one centrally managed service.
- Support and diagnostics must work without maintainer access to production credentials or data.
- The design depends on provider product terms, quotas, integrations, and lifecycle behavior.
- One-time Admin bootstrap and account recovery add security-sensitive complexity.
- Achieving browser-oriented setup without manual SQL or service credentials requires substantial provisioning automation and usability testing.

## Security consequences

- The proposal avoids a central store of all clubs' participant and location data, but independent deployment does not remove the need for strong per-club controls.
- Service-role credentials must be isolated to trusted server execution and never exposed in browser bundles, `VITE_` variables, logs, screenshots, or support channels.
- RLS, constraints, trusted functions, Realtime subscriptions, and Admin bootstrap require explicit security regression tests.
- Admin recovery must be controlled, auditable, and independent of reopening bootstrap.
- Schema migration, backup, rollback, and destructive reset/deletion boundaries must be documented and tested.
- A provider Marketplace link or service integration is not authorization; project ownership, token scopes, and server-side checks still require review.
- No decision to weaken Firebase Rules or permit client writes to authoritative state is made by this ADR.

## Open questions

- Which trusted operations use PostgreSQL RPC versus Edge Functions, triggers, scheduled processing, or an outbox?
- How will participant anonymous identity loss and Admin account recovery be handled?
- How will first-Admin bootstrap be authorized and closed atomically?
- How will club ownership transfer work when the original student graduates?
- Which Vercel/Supabase plans, quotas, pause behavior, and use policies apply at implementation time?
- How are database migrations applied and rolled back without installer SQL or maintainer production access?
- What backup/export/restore features are available on the chosen plans?
- How are updates delivered without overwriting club-owned changes?
- What schema/tenant model and retention policy are required?
- Does any future centrally hosted option require a license, support, or privacy model change?
- Which WSL 3/WSLC local development workflow is practical? This ADR intentionally does not decide it.

## Revisit criteria

Revisit this ADR if:

- provider free-tier or usage terms change;
- Vercel Hobby terms do not fit the project's intended use;
- Supabase quota, inactivity, pause, backup, or billing behavior is unsuitable;
- club onboarding cannot meet the usability target without unsafe credential handling;
- self-hosting becomes operationally feasible for the intended audience;
- a central multi-tenant hosting model becomes necessary; or
- the selected WSL 3/WSLC local workflow is insufficient for secure PoC development.
