# Firebase to Supabase Responsibility Map

## 1. Purpose and status

This is a **Proposed** mapping of responsibilities, authority, and test boundaries. It is not a final PostgreSQL schema, tenant model, RLS policy, or decision to replace Firebase. Firebase remains authoritative until an explicit migration and retirement decision.

The current implementation was reviewed in `src/infrastructure/firebase/`, `functions/src/`, `firestore.rules`, and the existing test definitions. Supabase table names below are illustrative placeholders only.

## 2. Platform mapping

| Current Firebase responsibility | Supabase-side candidate | Status / notes |
| --- | --- | --- |
| Firebase Hosting (`dist`, SPA rewrite) | Vercel static deployment | Candidate; hosting, plan terms, ownership and update path need a PoC. |
| Firebase Authentication | Supabase Auth | Candidate; participant and Admin recovery needs differ. |
| Firestore documents and transactions | PostgreSQL tables, constraints, transactions | Candidate; final schema and atomic boundaries are open. |
| Firestore Security Rules | PostgreSQL constraints + RLS + trusted RPC/Edge authorization | Candidate; must preserve or strengthen every boundary. |
| Firestore `onSnapshot` | Supabase Realtime | Candidate; event-level authorization and audience filtering must be demonstrated. |
| Callable Functions | PostgreSQL RPC and/or Edge Functions | Candidate per operation, not a one-size-fits-all choice. |
| Firestore Triggers | Database trigger, trusted RPC, Edge processing, worker, or transactional outbox | Candidate; ordering, retries, and stale-event behavior remain open. |
| Scheduled Functions | Scheduled process/worker | Candidate; scheduling availability and plan compatibility need verification. |
| Firebase Emulator Suite | Supabase local/test project and PostgreSQL/Auth/Realtime test harness | Candidate; local workflow is undecided and does not imply Docker/WSLC configuration in this PR. |

## 3. Data responsibility map

**Access terminology:** “Authenticated read” means the current Firestore Rules allow a signed-in identity to read the relevant document(s); it does not imply that every field should be exposed by a future API. “Functions-only write” means client Rules deny writes and trusted Admin SDK code performs the write. Proposed table names are placeholders.

| Current Firestore area / identity | Current purpose and authority | Session, realtime, transaction | Proposed PostgreSQL representation and boundary | Open issue |
| --- | --- | --- | --- | --- |
| `game_config/current` | Singleton game phase/config, team roles/scores, mission selection, reveal deadlines, Session metadata, and bounded game log data. Authenticated client read; client write denied; trusted Functions write. | Contains current `gameSessionId` and Session schema fields. Realtime subscription is used. Many trusted transitions transact on it with related rows and/or receipts. | Placeholder `game_config` row plus separate `game_sessions`/event tables only if normalization is justified; RLS SELECT for authenticated current participants, narrowly authorized trusted write function. | Decide whether logs and Session history are embedded or normalized, and how legacy initialization is migrated. |
| `users/{uid}` | Player profile/game state keyed by Auth UID: team, role, score, status, powers/waiting state and Session. Authenticated read; client may create its own initial constrained player and update only its own name; trusted Functions change authoritative fields. | Session-bound; current-player and roster realtime subscriptions. Gameplay and Admin transitions transact with config and/or other players. | Placeholder `players` table with Auth FK, Session FK, validated state constraints; RLS SELECT scoped to intended participants and safe fields, INSERT for constrained self-setup, UPDATE restricted to profile fields, trusted state changes through RPC/Edge. | Current authenticated read is broad; PostgreSQL row policy alone does not hide columns. Decide safe roster view/column exposure. |
| `admins/{uid}` | Admin membership keyed by Auth UID. User may read their own membership; client writes denied. Trusted Functions check membership. Repository README describes privileged Console bootstrap for the Firebase version; it is not a proposed Supabase flow. | Admin identity is not a game Session row; Admin operations also validate current Session as required. No ordinary realtime use identified. | Placeholder `admin_memberships` in a private schema or tightly controlled table; no client INSERT/UPDATE/DELETE; trusted authorization function or Edge authorization. | Define one-time bootstrap, persistent Admin recovery, revocation, and audit. |
| `missions/{missionId}` | Mission catalog and details. Authenticated read; client write denied; Admin Callable synchronizes catalog. | Session/phase/assignment governs active use. Mission subscription is used. Catalog sync and mission administration use trusted transactions. | Placeholder `missions` table with constraints and keys; RLS SELECT for authenticated users, trusted catalog mutation only. | Identify stable catalog versioning and preserve completion references across updates. |
| `missionCompletions/{completionId}` | Authoritative completion record. Authenticated read; client write denied; `completeMission` writes it with player/team score updates. | Completion ID is Session/team/mission scoped; transactional duplicate check/create and score/player update. Not currently a general request-receipt collection. | Placeholder `mission_completions` table with foreign keys and a unique key over Session/team/mission; RLS SELECT limited to intended game users; INSERT only through trusted function. | Confirm whether client should read every completion or only an aggregate/view. |
| `privateLocations/{uid}` | One current private location per Player. Client can read/write only its own document, with current Session and coordinate/timestamp validation; Functions read it for trusted processing. | Session-bound. Owner subscription and location updates are used; writes cause Emergency Projection reconciliation triggers. | Placeholder `private_locations`, ideally isolated in a private schema or protected table; RLS SELECT/INSERT/UPDATE for owner and narrowly scoped trusted processing; DELETE policy restricted to reset/retention authority. | Preserve heartbeat freshness, no cross-player reads, and safe use in trusted functions without exposing the row to general Admin/client queries. |
| `exposedLocations/{uid}` | Short-lived individual or reveal-scope public-to-authorized-game snapshot. Owner may write a constrained individual snapshot; read is a document get gated by viewer/current participant, Session, phase, scope, expiry, and target state; list is denied. | Session, reveal audience and expiration are checked. Client subscribes to individual documents for selected Player IDs. Reveal operation writes snapshots transactionally with config/receipt. | Placeholder `exposed_location_snapshots`; RLS SELECT must include viewer identity, target, audience, active phase, Session and expiry; owner INSERT/UPDATE only for individual self snapshot; trusted reveal function for broader scope. | Determine whether RLS can safely express subscription filtering, or a filtered view/RPC/realtime channel is required. |
| `emergencyLocationProjections/{uid}` | Derived current Emergency location projection. Admin-only document read; all client writes denied; Firebase Functions reconcile on Player and private-location writes. | Session-bound, freshness/expiry-bound; Admin UI subscribes to individual projections. Trigger delivery is eventual, not a five-second guarantee. | Placeholder private-schema projection table or view/materialized state, readable only through authorized Admin path; writes/deletes by trusted reconciliation only. | Choose synchronous versus asynchronous reconcile, expiry cleanup, observability, and acceptable operational latency. |
| `admins/{uid}/...Requests` | Trusted Admin receipts for role swap, mission mode, mission assignment, catalog sync, phase transition, reveal, score adjustment, Session initialization, and reset. Client read/write denied. | Request ID is the document ID; receipt and authoritative transition are transactionally coordinated for covered operations. Release record notes receipt TTL cleanup is not implemented. | Placeholder `operation_receipts` keyed by Admin/action/request ID, private to trusted function; unique constraints and atomic receipt/state changes. | Normalize current nested receipt collections, payload fingerprint mismatch behavior, retention and deletion. |
| `admins/{uid}/resetConfirmations/{tokenId}` | Reset preview confirmation authorization; Client read/write denied. Trusted reset consumes it and stores replay result. | Admin and old/current Session-bound preview data; confirmation use, reset state and request receipt are transactionally coordinated. | Placeholder `reset_confirmations`, one-time unique token hash, short expiry, atomic consume within trusted reset. | Token generation, raw-token handling, expiry, re-preview behavior, and recovery policy. |

No separate `location_logs` collection is evidenced in the current implementation reviewed here; older `firestore_design.md` describes a historical model. Current game logs are stored within `game_config/current`. Do not add tables based only on the older design document.

### Nested Admin receipt collections observed

Current nested receipt names include `roleSwapRequests`, `missionModeRequests`, `missionAssignmentRequests`, `missionCatalogSyncRequests`, `phaseTransitionRequests`, `revealRequests`, `scoreAdjustmentRequests`, `sessionInitializationRequests`, and `gameResetRequests`; reset preview tokens are stored under `resetConfirmations`. These names document current Firestore organization, not proposed SQL names.

## 4. Trusted operation map

All listed operations are exposed through Firebase Callable Functions except the Waiting scheduler and Emergency Projection Firestore triggers. Callable requests require Firebase authentication; operations marked Admin additionally check membership in `admins/{uid}` server-side. Player operations derive the acting UID from Auth and validate the expected Session where applicable. Supabase candidate mechanisms are provisional.

| Operation / current entry point | Caller, authority, and client intent | Current write/transaction and replay boundary | Supabase candidate; unacceptable weakening; parity needed |
| --- | --- | --- | --- |
| `initializeGameSession` | Admin; intent includes Session initialization request and expected state. Server creates/sets authoritative Session metadata and binds eligible roster Players. | Firestore transaction; Admin-scoped `sessionInitializationRequests` receipt keyed by request ID. | RPC or Edge calling a single atomic DB function. Reject stale Session; test Admin gate, eligible roster, replay and excluded users. |
| `completeMission` | Authenticated Player; supplies mission ID and expected Session, not score/result. Server validates active mission/team/phase and computes reward/score. | Firestore transaction creates Session/team/mission-scoped completion and updates Player/team score. Duplicate completion rejected by deterministic completion identity; no generic request receipt. | RPC transaction candidate. Preserve unique completion, score atomicity, Session rejection and duplicate test. |
| `capturePlayer` | Authenticated Player; supplies target ID and expected Session. Server checks roster, role/status/phase and computes capture state, role and reward. | Firestore transaction over config and relevant Players. No request receipt identified; state validation prevents invalid repeated transitions. | RPC candidate; test simultaneous captures, score and Player state atomicity, stale Session and domain rejection. |
| `startWaiting` | Authenticated Player; expected Session. Server validates current Player and calculates Waiting state/deadline. | Firestore transaction updates Player and game log/config. No request receipt identified. | RPC candidate; preserve deadline semantics, legal state transitions and concurrent request behavior. |
| `resumeWaiting` | Authenticated Player; expected Session. Server validates eligibility and resolves resume state. | Firestore transaction updates Player and game log/config. No request receipt identified. | RPC candidate; preserve eligibility, expiry and Session behavior. |
| `activateInvincibility` | Authenticated Player; expected Session. Server checks role, card balance, phase/status and computes duration/state. | Firestore transaction updates Player and config log. No request receipt identified. | RPC candidate; atomic card decrement/activation, one-use behavior and stale Session tests. |
| `requestSafetyAction` | Authenticated Player; submits action/reason and expected Session. Server changes safety status and emits logs; projection refresh is attempted after the state transaction. | Player/config update in Firestore transaction; Emergency Projection also has two background reconcile triggers. No generic receipt identified. | RPC for state plus separately selected reconcile/outbox mechanism. Preserve fail-safe behavior, privacy, eventual freshness/cleanup and avoid promising immediate delivery. |
| `swapTeamRoles` | Admin; request ID and expected Session. Server derives roster and computes role swap. | Firestore transaction updates config/Players and creates `roleSwapRequests` receipt; same request replays stored result. | Atomic RPC candidate. Preserve Admin check, Session scope, payload mismatch behavior, replay and roster consistency. |
| `resumePlayer` | Admin; target ID and expected Session. Server validates Player state and computes resumed state. | Firestore transaction updates Player and config log. No request receipt identified. | RPC candidate. Preserve Admin and Session checks and state constraints; define response-loss semantics. |
| `revealPlayerLocations` | Admin; supplies scope/intent and request ID with expected Session. Server selects eligible audience/snapshots and expiry. | Firestore transaction updates reveal deadline/config, writes exposed snapshots, and creates `revealRequests` receipt. | RPC transaction or Edge orchestration invoking one atomic DB function. Preserve audience/phase/expiry and no private data leakage. |
| `transitionGamePhase` | Admin; phase intent, request ID and expected Session. Server validates allowed transition and required mission/config. | Firestore transaction updates config and creates `phaseTransitionRequests` receipt. | RPC candidate. Preserve transition graph, Session checks, replay and required mission validation. |
| `setMissionMode` | Admin; supplies mode, request ID, expected Session. Server validates mode/state. | Firestore transaction updates config and creates `missionModeRequests` receipt. | RPC candidate; Admin authorization, validation, replay and atomic receipt parity. |
| `assignMissions` | Admin; supplies assignment intent, request ID, expected Session. Server validates catalog/selection and chooses allowed assignments. | Firestore transaction updates config and creates `missionAssignmentRequests` receipt. | RPC or Edge+RPC candidate; preserve assignment constraints, Session and deterministic replay. |
| `syncMissionCatalog` | Admin; supplies catalog-sync intent and request ID. Server validates/upserts catalog and stores operation result. | Firestore transaction with `missionCatalogSyncRequests` receipt. | Reviewed migration/catalog job or Edge+RPC candidate; preserve stable IDs, validation, replay and safe catalog replacement. |
| `adjustTeamScore` | Admin; supplies team/delta/reason intent, request ID and expected Session. Server validates range and computes resulting score/log. | Firestore transaction updates config score/log and creates `scoreAdjustmentRequests` receipt. | Atomic RPC candidate; preserve bounds, audit trail, Session binding and replay/payload mismatch checks. |
| `prepareGameReset` | Admin; requests preview for current state. Server computes counts/fingerprint and issues confirmation token. | Firestore transaction creates Admin-scoped `resetConfirmations` token. This is a preparation, not the reset mutation. | Trusted RPC/Edge candidate; one-time authorization, expiry, fingerprint and no client-created confirmation. |
| `executeGameReset` | Admin; supplies confirmation token, request ID and expected old Session. Server revalidates preview and resets authoritative state into a new Session. | Firestore transaction covers reset state and Admin receipt/confirmation consumption; reset also reconciles/deletes Session-scoped location/projection documents. Same request ID returns stored result. | Carefully sized DB transaction/RPC or staged design with explicit atomic boundary. Preserve zero partial authoritative reset, stable replay, stale confirmation rejection, old Session rejection and retained records. |

The table describes current code boundaries at a functional level. The Supabase implementation must derive trusted results server-side and must not accept client-supplied scores, roles, authorization flags, expiry extensions, or reset outcomes.

## 5. Firestore Rules to PostgreSQL boundary map

A compatible design will combine database-level constraints and trusted authorization; RLS alone does not replace input validation or atomic game logic.

| Existing guarantee / invariant | PostgreSQL-side candidate |
| --- | --- |
| Required identity, Session IDs, numeric ranges, enum values, expiry ordering | `NOT NULL`, `CHECK`, domain constraints and application validation. |
| Player/Auth, Player/Session, completion/Mission relationships | Foreign keys with deliberate deletion behavior. |
| One completion per Session/team/mission; one receipt per actor/action/request ID | Unique constraints. |
| Authenticated reads currently permitted for config/catalog/completions and roster | RLS SELECT policy narrowed to intended fields/audience; safe views may be needed. |
| Self Player creation and profile update only | RLS INSERT/UPDATE policy with immutable identity and allowed-column boundary, or a constrained setup function. |
| Owner-only private location reads/writes | RLS SELECT/INSERT/UPDATE scoped to `auth.uid()` plus Session check; private schema/trusted access path for backend work. |
| Exposed snapshot audience, phase, Session and expiry | RLS SELECT/INSERT/UPDATE policies or filtered view/RPC enforcing all dimensions. |
| Admin membership is trusted, not client-assignable | Private schema/table, no client mutation policy, security-definer function or Edge authorization. |
| Scores, game state, mission catalog, completion, projections and receipts cannot be client-written | RLS INSERT/UPDATE/DELETE deny policies; trusted RPC/Edge functions only. |
| Reset token use and request replay | Unique keys plus atomic security-definer function/RPC; keep receipt/token tables private. |
| Reject stale Session data | Foreign keys/constraints plus current Session check inside the same transaction as the authoritative write. |

Required principles:

- deny by default;
- a Client cannot assign Admin authority;
- a Client cannot write trusted score or gameplay state;
- a Client cannot read another Player's private location;
- stale or wrong-Session data is rejected;
- a Client cannot create or alter receipts or reset confirmations;
- a Client cannot extend event expiry or broaden location audience;
- authenticated does not automatically mean authorized; and
- service-role bypass requires explicit trusted authorization and must never be shipped to a browser.

## 6. Realtime and location visibility

Current client subscriptions include the Player roster, current Player, mission catalog, game config, own private location, selected exposed-location documents, and selected Emergency Projection documents. The existing Rules distinguish the viewer from the target and check current Session, game phase, reveal scope, expiry, target status, and Admin status where applicable.

Any Realtime design must retain these dimensions:

- viewer identity and current authorization;
- target Player identity and current Session;
- individual, team, or global audience scope;
- active game phase and current reveal deadline;
- snapshot/projection expiry and Player safety status; and
- access revocation after Session transition, Admin removal, or event expiry.

Whether Supabase Realtime RLS is sufficient for every filtered subscription, or whether a filtered view/RPC/channel is required, is an **Open question**. Tests must prove no unauthorized initial snapshot or subsequent event is emitted; filtering only in React is insufficient.

## 7. Trigger and schedule replacement analysis

Current server-side background behavior includes `onPlayerWritten` and `onPrivateLocationWritten` to reconcile Emergency Projections, plus `processWaitingLifecycleSchedule` on a one-minute schedule.

| Candidate | Atomicity | Retry / ordering / stale events | Observability | Free-tier / local test |
| --- | --- | --- | --- | --- |
| Synchronous database trigger | Can share transaction for database-local work; may increase write latency. | Database ordering differs from asynchronous Firebase triggers; recursive work and failures need analysis. | Database logs/metrics and trace correlation required. | Provider limits and local behavior must be tested. |
| Trusted RPC transaction | Strongest fit where caller action and derived state must commit atomically. | Explicitly serializes logic; retry contract remains operation-specific. | Function result and database audit can be structured. | Simple to test with transaction-level integration tests. |
| Edge Function | Useful for auth, orchestration, and external calls; separate DB transaction still required. | Network retries and response loss require idempotency; do not assume ordering. | Request IDs and sanitized structured logs required. | Runtime/plan and local test support are open. |
| Scheduled worker/process | Appropriate for periodic Waiting expiry or cleanup candidates. | Must tolerate delay, overlap, duplicate run and partial batch; use idempotent claims. | Run IDs, skipped/failed counts and lag metrics required. | Scheduler availability and quota are open. |
| Transactional outbox/queue | Commits intent with source transaction; consumer performs asynchronous reconcile. | Supports retry and explicit ordering keys, but requires dedupe and stale-event guards. | Strong correlation via outbox IDs and consumer status. | Adds schema/worker complexity and provider/plan dependencies. |

No option is selected by this PR. In particular, Emergency Projection is an operational location-sharing aid, not guaranteed immediate delivery or emergency-service notification.

## 8. Test migration map

| Existing test asset | Supabase migration treatment | PoC priority |
| --- | --- | --- |
| Core domain tests under `tests/game/` | Retain unchanged where semantics remain provider-neutral; add parity tests for time/serialization assumptions. | Required. |
| Application tests under `tests/application-*.test.mjs` | Retain unchanged or adapt ports only if contracts change. | Required for implemented use cases. |
| Firebase service tests under `functions/test/*Service.test.mjs` | Reuse service behavior if services remain provider-neutral; replace Firebase store adapters and test transaction semantics in PostgreSQL. | Required per migrated operation. |
| Snapshot mapper tests (`tests/infrastructure-snapshot-mappers.test.mjs`) | Replace Firebase mapper expectations with Supabase/PostgreSQL serialization adapter tests. | Required when adapter is introduced. |
| Firestore Rules tests (`tests/firestore-rules.test.mjs`) | Rewrite as PostgreSQL RLS/constraint tests using real Auth claims and role boundaries. | Required before any Supabase user data is exposed. |
| Functions Emulator integration tests | Rewrite around Supabase Auth, database, RPC/Edge and Realtime behavior; retain scenario intent, not Firebase harness. | Required for each PoC operation. |
| Continuous release flow / Reset / Setup concurrency tests | Rebuild against a single persistent Postgres dataset and prove atomicity, replay, new Session and races. | Required before release candidate. |
| Emergency Projection stability tests | Replace event/trigger-specific harness with selected reconcile mechanism; assert eventual state and exact privacy/schema, not an unsupported fixed latency. | Required if that feature is ported. |
| UI popup tests | Retain if Presentation behavior is unchanged. | Low-risk reuse. |
| Offline/reconnect, browser and release-operation checks | Re-run against deployed staging; Firebase Emulator success does not prove Supabase operations. | Before general release. |

## 9. Migration sequencing

First establish a Supabase-only isolated PoC and security parity tests. Migrate a bounded responsibility at a time, preserve stable domain contracts where possible, and keep Firebase as the authoritative release candidate during evaluation. Compare authorization, transactional outcomes, replay, performance/operational limits, and recovery before changing any user-facing release path.

Do not build or recommend a permanent dual-backend product architecture. Any temporary comparison harness must have a defined owner, data boundary, and removal criterion. Firebase removal requires a separate explicit decision after Supabase demonstrates equal or stronger security and regression coverage.
