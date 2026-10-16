# Supabase Migration Feasibility

## 1. Status

- **Document status:** Proposal
- **Implementation:** Not started
- **Current authority:** The Firebase release candidate remains authoritative.
- **Decision:** This is an architecture and feasibility proposal. It does not make a final decision to adopt Supabase, retire Firebase, or migrate production data.

For the current responsibility inventory, see [Firebase to Supabase Responsibility Map](./FIREBASE_TO_SUPABASE_MAP.md). For the intended operator experience, see [Non-Engineer Installation Experience](./NON_ENGINEER_INSTALLATION.md).

## 2. Background

### Confirmed current implementation

The repository currently contains a React/Vite client using Firebase Authentication and Cloud Firestore, Firebase Hosting configuration, Firebase Callable Functions, Firestore background triggers, a scheduled Function, and tests that use Firebase Emulator Suite. Functions are configured for Node.js 22 and the `asia-northeast1` region. The existing release-readiness record retains Firebase as the release candidate and records staging and browser-operation gates that remain outside the automated Emulator checks.

The Firebase-specific client adapters are primarily under `src/infrastructure/firebase/`; server actions and services are under `functions/src/`. `firebase.json` configures `dist` as the Hosting directory, an SPA rewrite, Functions predeploy build, and Auth/Firestore/Functions/Hosting Emulator endpoints.

### Proposed migration motivation

The project is exploring whether it can become an OSS application that:

- gives each university club an independent environment it owns;
- is approachable for a non-engineer club representative;
- may be able to start within provider free tiers, subject to current terms and quotas;
- does not require the installer to edit application code, paste SQL, or use a terminal;
- does not make the original maintainer the custodian of every club's participant or location data; and
- preserves or strengthens the current authorization, Session, privacy, replay, and atomicity boundaries.

**Free use is not confirmed or guaranteed.** Pricing, quotas, inactivity/pause behavior, commercial and educational-use terms, account requirements, and provider policies must be checked against the providers' current terms when a PoC is planned and before any club relies on it.

## 3. Goals

A migration proposal and later implementation should:

- preserve trusted server-side game rules and prevent clients from choosing authoritative results;
- preserve game Session isolation and reject stale-Session writes;
- preserve private-location privacy and the current audience/expiry rules for exposed location data;
- preserve idempotency, stable replay, and duplicate prevention where currently provided;
- preserve atomic game transitions across configuration, player, score, mission, and receipt state;
- reuse `src/game/` and as much of `src/application/` as practical;
- enable each club to own its deployment, provider accounts, billing relationship, and data lifecycle;
- provide a guided, browser-oriented installation with actionable diagnostics and recovery guidance; and
- keep service credentials, bootstrap secrets, and participant data out of source control, screenshots, Issues, and support chats.

## 4. Non-goals

This proposal does not:

- implement Supabase, Vercel, or a second backend;
- remove or weaken the Firebase release candidate;
- finalize a PostgreSQL schema, tenant model, RLS policy, migration mechanism, or operation-by-operation execution mechanism;
- deploy to Vercel or migrate production data;
- create a permanent dual-backend product architecture;
- change game rules or add gameplay features;
- relax current security boundaries to make onboarding easier;
- guarantee perpetual free use;
- reintroduce Docker; or
- select or configure a WSL 3/WSLC local development workflow. That workflow is a separate decision for a future PoC.

## 5. Current architectural boundary

### Confirmed

- `src/game/` has no Firebase SDK imports and contains the game/domain rules.
- `src/application/` has no Firebase SDK imports and contains use cases and ports.
- `src/infrastructure/firebase/` contains the main Firebase client adapters: Auth, subscriptions, callable gateways, player setup, location stores, and snapshot mappers.
- Functions services are separated from Firebase Admin-backed stores through Store/Transaction interfaces in the operation modules. The adapters in `functions/src/` implement those interfaces with Firestore transactions.
- Some Presentation components import concrete Firebase adapters directly. Those call sites would need to move behind an application-facing dependency boundary or otherwise be adapted; the current separation is not complete.
- Most game and application unit tests are backend-independent. Firebase Rules and Emulator integration tests are provider-specific and need replacement or a new harness.
- Current direct client writes are limited to player setup (a user plus that player's private location in one batch), the owner's private-location update, and the owner's individual exposed-location snapshot. Client writes to trusted scores, game state, missions, completions, receipts, Admin records, and Emergency Projections are denied by Rules.

### Evidence boundary

These are repository observations, not proof that every production project is configured identically. `README.md` and `firestore_design.md` contain older Firebase setup/model guidance; later migration work must identify the current supported operator procedure rather than treating every historical instruction as normative.

## 6. Proposed target architecture

The following are **candidates**, not settled decisions:

| Responsibility | Proposed candidate | Decision still required |
| --- | --- | --- |
| Web client | React + Vite | Preserve existing app and decide configuration/version delivery. |
| Static frontend hosting | Vercel | Verify account ownership, plan terms, environment-variable handling, build/deploy updates, and usage policy at PoC time. |
| Participant/Admin identity | Supabase Auth | Decide anonymous participant recovery and a recoverable Admin provider. |
| Persistent state | Supabase PostgreSQL | Design normalized tables, constraints, Session keys, indexes, retention, and migration versioning. |
| Authorization | PostgreSQL Row Level Security plus constraints and trusted server functions | Prove row and column privacy, write ownership, Admin authority, and Session enforcement. |
| Client subscriptions | Supabase Realtime | Test authorization at subscription and event delivery, including role/audience filtering. |
| Trusted operations | PostgreSQL RPC and/or Supabase Edge Functions | Choose per operation; do not route every operation to one mechanism by default. |
| State reconciliation | Database trigger, RPC transaction, Edge processing, worker, or transactional outbox | Compare ordering, retries, stale-event handling, and observability for each use case. |
| Scheduled Waiting lifecycle | Scheduled process candidate | Verify scheduler availability, latency, retry behavior, and plan compatibility. |
| Schema delivery | Versioned, migration-managed schema | Choose a repeatable, reviewable, rollback-aware method that does not require installers to paste SQL. |
| Ownership/deployment unit | One club-owned Vercel deployment and one club-owned Supabase project | Define a safe template/provisioning and update path without central access to club credentials. |

Important operations must be evaluated individually against PostgreSQL RPC, Edge Function, database trigger, scheduled process, and transactional outbox/queue options. A database transaction may be appropriate when a state transition and its receipt must commit atomically; an Edge Function may be appropriate for external/provider-facing orchestration. Triggers and schedules have separate delivery and retry characteristics and must not silently become security authorities.

## 7. Reusable components

| Classification | Current assets / work |
| --- | --- |
| Directly reusable | Most `src/game/` rules and their tests, subject to parity tests for timestamp and persistence assumptions. |
| Reusable behind new adapters | Application use cases and ports; UI subscriptions and actions after concrete Firebase imports are removed from Presentation call sites; selected Functions service logic where it can remain provider-neutral. |
| Requires replacement | Firebase Auth/Firestore adapters, Admin SDK stores, Callable/Trigger/Schedule wrappers, Firestore Rules, Firebase snapshot mappers, Emulator setup and provider-specific integration harness. |
| Requires new security tests | RLS SELECT/INSERT/UPDATE/DELETE, Admin assignment and bootstrap, Session mismatch, location privacy, Realtime authorization, service-role isolation, trusted transaction boundaries, replay and stale-event behavior. |

A migration must not assume that a Firebase snapshot mapper or Rules test automatically proves an equivalent PostgreSQL policy.

## 8. Principal migration risks

1. **Trusted Reset atomicity:** Reset touches Session/config, roster state, private/exposed locations, Emergency Projections, confirmation state, and a replay receipt. The new design must define exactly which changes are one transaction and how a large roster is handled without partial authoritative state.
2. **Mission completion duplicate prevention:** Current completion identity is scoped by Session/team/mission and score/player changes are committed with the completion. A database uniqueness constraint and atomic trusted operation must preserve this.
3. **Capture concurrency:** Competing captures can touch shared roles/scores and multiple player records. Isolation and conflict outcomes require concurrency tests.
4. **Admin authorization:** Admin authority is not self-assignable by a client. Every trusted operation must authorize the current identity on the server/database side, not trust a client-supplied role.
5. **Anonymous participant lifecycle:** Browser data loss can lose an anonymous identity. Rejoining, duplicate identities, participant cleanup, and abuse controls remain to be designed.
6. **Session mismatch rejection:** Session IDs must be checked in the same transaction or equivalent serialization boundary as authoritative writes.
7. **Emergency Projection lifecycle:** Reconcile on status and location changes, freshness/expiry, Session transitions, and cleanup without disclosing private location data. Background delivery does not imply a five-second or immediate-delivery guarantee.
8. **Location visibility audiences:** Individual, team, global, phase, Session, and expiry rules must be enforced on both direct reads and realtime events. A broad table subscription is not an acceptable substitute.
9. **Realtime authorization:** Verify authorization when subscribing and when row visibility changes; test stale subscriptions, revoked Admin access, expiry, and Session changes.
10. **Scheduled Waiting lifecycle:** Define late, duplicate, or delayed scheduler execution and idempotent processing of eligible participants.
11. **Receipts and replay:** Preserve request identity, payload-mismatch rejection, stable duplicate result, Session binding, and audit/retention rules. Current receipt cleanup/TTL is not implemented according to the release-readiness record.
12. **Database and provider limits:** Compare row counts, transaction limits, payload size, rate limits, Realtime limits, and provider-specific quotas with high-roster use.
13. **Schema migration and rollback:** Ensure repeatability, preflight checks, backup, compatibility, rollback boundaries, and a safe policy for destructive migrations.
14. **Non-engineer deployment safety:** A browser-only flow must provision infrastructure and apply reviewed schema without exposing service-role or database credentials to the client or relying on maintainer-held production credentials.
15. **Provider and license policy:** Free tiers, plan eligibility, Vercel Hobby terms, provider pauses, and any future centralized hosting/licensing implications require current review.

## 9. Staged migration plan

| Phase | Scope | Exit evidence |
| --- | --- | --- |
| A. Documentation and architecture decisions | This proposal, responsibility map, installation goals, and ADR. | Maintainers review boundaries and open questions. |
| B. Isolated local/hosted Supabase PoC | Separate non-production project; verify actual local workflow, hosted provisioning, schema migrations, and provider terms. | Repeatable create/reset, no Firebase production dependency, documented costs/limits. |
| C. Authentication and Session isolation | Supabase Auth identities, Admin membership, bootstrap/recovery, Session-scoped data access. | Security tests demonstrate deny-by-default and cross-Session denial. |
| D. Player Setup and Realtime | Player creation, own private location, roster/config subscriptions, exposed location audiences. | Owner and audience boundaries hold for reads, writes, and realtime delivery. |
| E. Trusted operations, one operation per PR | Implement operation adapters/transactions incrementally with no speculative bulk rewrite. | Per-operation domain/service/security/concurrency/replay tests pass. |
| F. Security and regression parity | RLS, constraints, Auth, Realtime, integration, E2E, offline/replay, migration and backup tests. | Supabase behavior is at least as safe as the Firebase baseline. |
| G. Non-engineer onboarding | Browser-first install, diagnostics, update, ownership transfer, recovery, and deletion path. | Usability testing meets agreed targets without secret mishandling. |
| H. Firebase retirement decision | Compare operational evidence and choose whether to retire Firebase. | A separate explicit decision after Supabase parity and release hardening. |

Firebase must not be removed until the Supabase implementation demonstrates equivalent or stronger security, behavior, and test coverage. Retirement is a separate decision, not an automatic outcome of a successful PoC.

## 10. PoC Go / No-Go criteria

A PoC cannot advance to a release candidate unless all applicable criteria are demonstrated:

- unauthenticated reads/writes are denied except explicitly documented public assets;
- cross-Session reads and writes are denied;
- private locations are owner-only except narrowly authorized trusted processing;
- Admin authority cannot be self-assigned or granted by client writes;
- service-role and database credentials are never shipped to the browser;
- trusted state transitions are atomic, including scores, player/config state, and receipts where required;
- duplicate requests safely replay the stored result or are rejected without partial writes;
- Realtime cannot disclose rows to an unauthorized identity or audience;
- schema migrations are repeatable and their failure/rollback behavior is documented;
- an installer can eventually complete setup without editing source or pasting SQL;
- provider account, free-tier, quota, pause, billing, and policy assumptions are verified using current provider information; and
- backups, data deletion, ownership transfer, Admin recovery, and support boundaries are documented.

Any failed security boundary is a No-Go; convenience does not compensate for weaker authorization.

## 11. Open questions

- Which operations belong in PostgreSQL RPC, Edge Functions, database triggers, a scheduler, or an outbox/worker?
- How should anonymous Auth identities be recovered or safely replaced?
- Which persistent Admin login provider and recovery method are accessible to club operators?
- How should scheduled Waiting transitions run, and what delivery latency/retry guarantees are acceptable?
- How should Emergency Projections be reconciled, expired, and observed without relying on immediate background execution?
- Should club ownership be represented by a single-project boundary only, or is any in-database club/tenant key needed?
- What backup, restore, retention, and event-deletion mechanisms are available on the selected plan?
- How can updates and schema migrations reach user-owned deployments without overwriting club customization?
- Which Vercel/Supabase integrations are stable, supported, and compatible with club ownership?
- Which WSL 3/WSLC local development workflow is practical for the project? This is deferred to a future PoC.
- What free-tier limits and provider terms apply at implementation time?
- What license or support implications arise if a centrally hosted option is considered later?
