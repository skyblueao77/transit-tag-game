# Hosted Supabase PoC Runbook

## Status

- **Status:** Implementation foundation only; the migration has not been applied.
- **Data:** No production data, real users, or location data may be used.
- **Authority:** The Firebase release candidate remains authoritative.
- **Scope:** This runbook is for a later, separately approved Hosted PoC validation. No cloud operation is authorized by this document or by the PR that adds it.
- **Isolation:** `poc_sessions` are a minimal PoC membership model, not a mirror of Firebase `game_config/current` or its game-session lifecycle. The trusted create RPC grants its creator Admin membership for that PoC Session; it does not implement installation-wide first-Admin bootstrap or gameplay administration.

## Hosted Project facts

These are the non-secret facts reported when the isolated PoC project was created; re-verify them in the provider console before any future destructive action:

- Project name: `Transit Tag Game PoC`
- Plan: Free
- Status at creation: Healthy
- Compute size: nano
- Assigned region: `ap-southeast-2`
- The observed Free-plan creation flow did not permit choosing a region.
- No GitHub repository is connected.
- No migrations have been applied.
- No backups have been created.

The assigned region is an observed project property, not a source-code or migration setting. This repository intentionally contains no project reference, URL, key, password, token, or connection string.

The initial join code is a high-entropy bearer capability stored in a non-readable table column and returned only by the trusted create RPC (including an idempotent replay to its creator). Treat it as sensitive: do not log or retain it. At-rest hashing, rotation, and revocation remain follow-up design questions.

## Prerequisites before application

Do not proceed until all of the following are true:

1. Review and merge the migration and its RLS/function boundaries.
2. Re-check the current provider plan, quotas, pause behavior, billing/card requirements, data location, terms, and project identity. Free use is not guaranteed.
3. Select an officially supported Supabase CLI installation method and pin an exact version for the operator session. This repository does not install or pin the CLI.
4. Obtain any required credentials directly from the provider using a trusted local credential flow. Never put them in this repository, a browser bundle, a screenshot, an Issue, or a chat.
5. Authenticate interactively only after approving the exact tool and credential-storage behavior.
6. Link only the project whose displayed name is `Transit Tag Game PoC`; verify that name immediately before every apply, reset, or destructive command.
7. Use fictional test identities and data only. Do not connect the Firebase application or import Firebase data.
8. Review the rollback and cleanup plan before applying anything.

If the selected CLI version's installation, authentication, linking, migration-inspection, or dry-run commands cannot be verified in current official documentation, stop and resolve that before proceeding. Do not substitute guessed commands.

## Application plan

These are future steps only. They were not performed while preparing the repository foundation.

1. Use the approved, exact CLI version and official instructions for the selected operator environment.
2. Authenticate interactively and link only the isolated PoC project.
3. Verify the linked project name and intended target before inspecting pending migrations.
4. Review the migration plan; use a supported dry-run/preflight if the selected CLI version provides one.
5. Apply the reviewed migration only after a second project-identity check.
6. Verify the `poc_schema_versions` marker, expected tables, RLS policies, grants, and trusted RPC signatures.
7. Enable/verify the Auth capability needed by the disposable test identities only after a separate decision. Anonymous Auth is not enabled by this repository migration.
8. Run the positive and negative tests in [Hosted PoC Validation](./HOSTED_POC_VALIDATION.md).
9. Configure Realtime for `public.poc_session_memberships` only as a separate, reviewed validation step. The migration deliberately does not modify a publication. Verify that unauthorized initial snapshots and subsequent events are not delivered.
10. Remove all fictional users, memberships, Sessions, and other fixtures; verify cleanup and record sanitized findings.
11. Decide Go/No-Go. A successful foundation test is not production or migration approval.

No exact CLI invocation is specified here because the CLI has not been installed, selected, or version-pinned for this PoC. Follow the selected version's current official documentation rather than copying an unverified command.

## Safety checklist

- [ ] No real users or real location data.
- [ ] No service-role key, database password, access token, or connection string in a browser or Git.
- [ ] No credentials in screenshots, Issues, logs, or chat.
- [ ] The displayed target project name is `Transit Tag Game PoC` and its status/plan are rechecked.
- [ ] Production and staging projects are not linked or used.
- [ ] The migration, transaction boundaries, and cleanup path have been reviewed.
- [ ] `poc_private` is not included in the Hosted project's exposed API schemas.
- [ ] The current Free-plan quota, inactivity/pause behavior, and provider terms have been checked.
- [ ] Realtime is enabled only for the intended PoC table after separate review.
- [ ] No Vercel deployment or Firebase change is part of this validation.
- [ ] The absence of backups is understood; no recovery capability is assumed.

## Rollback and cleanup strategy

- Prefer a separately reviewed **forward migration** that removes or replaces only PoC-owned objects.
- Never hand-edit migration history, repair migration records, or reset a Hosted database as a shortcut.
- Restrict destructive work to the `poc_*` objects, functions, policies, and any PoC-only Realtime publication entry.
- Keep `poc_private` out of exposed API schemas; its helper is an internal RLS implementation detail.
- Re-verify the project name and identifier inside the trusted provider workflow immediately before destructive work. Do not copy the identifier into this repository.
- If any real, non-fixture, or unexplained data exists, **stop**. Do not drop or reset anything; first determine ownership, retention, and recovery requirements.
- A rollback plan must include test Auth identities and data cleanup, not only schema DDL. Confirm that cleanup succeeds before declaring the PoC complete.
- No rollback SQL is automatically executed by this PR. The current project has no backups, and provider recovery features are not assumed.

## Related materials

- [PoC validation plan](./HOSTED_POC_VALIDATION.md)
- [Supabase CLI configuration reference](https://supabase.com/docs/guides/cli/config)
- [Supabase Postgres Changes documentation](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Migration architecture proposal](./SUPABASE_FEASIBILITY.md)
