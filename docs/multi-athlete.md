# Private athletes in one database

Each Clerk subject maps to a login account in `app.users` and one private athlete
in `app.athletes`. A new account receives empty training data and its own settings.
The first account to sign in with a verified address listed in `ARETE_OWNER_EMAIL`
claims the historical athlete (ID 1). A listed address on another person's account
gets its own athlete instead: athlete 1's data and Garmin session stay with the
address that holds it. Attaching a second login of the owner is a deliberate
`UPDATE app.users SET athlete_id = 1`. Subsequent email changes update contact
details without changing that mapping.
Email is retained with its verification timestamp; storing it does not subscribe
the account to a newsletter or implement an email delivery service.

[Approved Excalidraw diagram](multi-athlete.excalidraw) ·
[Excalidraw link](https://excalidraw.com/#json=eRirgE5b-k__cxd7rUetg,KgW6uORe5ugr29JEDThaYA)

## Connect an athlete end to end

1. Enable `ARETE_AUTH=clerk`, configure Clerk's public/secret keys and the verified
   historical owner address in `ARETE_OWNER_EMAIL`. Without authentication the
   installation remains a single, implicit athlete; it is not a public multi-user mode.
2. Sign in to Arete. In **Réglages → Connexions**, choose **Connecter Garmin**,
   enter that athlete's Garmin email/password, and complete MFA if requested.
3. Choose **Synchroniser**. Imported activities, health data, training plans,
   strength sessions, goals, analytics, game state and coaching belong to that athlete.
   Detailed health/range sync controls remain in the System tab.
4. **Déconnecter Garmin** removes that athlete's session, including any pending
   login, while retaining imported workouts. It cannot disconnect another athlete.

`GARMIN_EMAIL` and `GARMIN_PASSWORD` are no longer read. Existing saved tokens
remain with athlete 1; new accounts must connect independently. The current
integration uses the pinned `garminconnect` library, not Garmin's partner OAuth API.
Passwords are used for the login call and are not persisted. MFA continuations
store bounded JSON (128 KiB, at most 128 cookies) in private database rows for
10 minutes, not live Python objects. Completion consumes the row before calling
Garmin; an expired/failed completion requires starting the connection again.
The serialization adapter follows SDK 0.3.17's private MFA fields, so SDK upgrades
must exercise portal, iOS and widget continuations. This preserves cookies and
TLS impersonation across workers without storing a password or using pickle.

## Ownership contract

- Authentication, signed OAuth state and the scheduler establish a trusted
  `athlete_scope`. Request bodies and model arguments cannot choose another owner.
- `dataio.db.connect()` sets a **connection-local** `arete_athlete_id`. Domain reads
  use `app.visible_<table>` projections; writes explicitly filter by owner, and
  inserts get an owner default from that connection. Authenticated connections
  without a scope see no private rows and cannot insert a default owner.
- Historical `user_id` columns mean athlete ID. New private columns use
  `athlete_id`; this avoids renaming existing API fields. Natural keys such as
  file paths, game settings and push endpoints are unique within an athlete.
- Domain services validate referenced parents through live private projections.
  Child projections require a live parent. This is application-enforced isolation,
  **not DuckDB row-level security or universal composite foreign keys**. The server
  credential is privileged. New SQL requires both a scope review and cross-account
  behavior tests; the structural test catches literal raw private-table reads.
- Sessions, goals and accounts use soft deletion. Account deactivation closes all
  mapped logins and retains the login email; reactivation reopens them. Explicit document deletion, forgotten
  facts and disconnected credentials retain their existing physical purge semantics.
- Files live under the historical root for athlete 1 and `athletes/<id>/` for
  others. Database file mirrors, Garmin MFA and coach caches are partitioned.
  Remote Garmin tokens are read from the database for each fresh client so another
  worker's logout is observed. Requests already running cannot be forcibly revoked.
- Browser conversations use athlete-specific storage keys; account changes clear
  API/query caches and remount the app. Private API responses are network-only in
  the service worker. Switching accounts revokes the old device push channel.

## Roles and administration

`app.users.role` is `athlete` or `admin` (migration 39). The owner, every login of
athlete 1, administers by right whatever the column says; `/auth/me` returns
`role` and `is_admin`. **Réglages → Administration**, shown to administrators,
lists each athlete with its logins, role, last activity (refreshed hourly with the
Clerk profile) and daily sync, and acts on the account tables only, never on an
athlete's private data:

- **Désactiver / Réactiver** an athlete: its logins are refused (within the
  bound below) and its data is hidden, then restored as it was. Nobody deactivates athlete 1, and only
  the owner deactivates an administrator's athlete.
- **Libérer la synchro**: clears a lease kept by a failed or stopped daily run, so
  the next window runs the day again. Check first what that run already did at
  Garmin, Strava or the calendar. A lease within its 15 minutes belongs to a run
  in progress and is not released.
- **Nommer admin / Retirer admin**: the owner only, never on its own logins.

A change applies at the account's next request on the instance that made it.
Each instance reuses a resolved account (the login and whether its athlete is
live, read in one query) for 30 seconds (`ACCOUNT_TTL_SECONDS` in
`api/auth.py`, at most 60), so other instances follow within that bound.

## Migrations and deployment

Migrations **35 and 36** are versioned in the monorepo. They preserve old account
mappings, map null legacy owners to athlete 1, inherit child ownership from parents,
and rebuild private tables transactionally to add non-null owners and scoped keys.
Migration 36 is replayable after a commit interrupted before version recording.
Missing older migration versions still run. Global IDs and existing data remain.

The rollout requires a maintenance cutover: old application versions read base
tables without filtering, and cannot safely coexist with newly onboarded athletes.
Back up the database; stop old Docker/API processes, cron and accessible old
production deployments; migrate and start only this version; verify the original
account and a second empty account before reopening access. Restore the backup
and old application together if rollback is needed. Do not run the old application
against a migrated database containing multiple athletes.

**This change has only local validation.** No production migration is applied.
A preview with `VERCEL_ENV=preview` and `ARETE_DB=md:arete` refuses database access
before connecting, including initialization. Configure a separate preview database
and token/environment first. Verify MotherDuck migration and concurrent cursor
behavior there before production rollout. Do not label a PR `preview` until that
configuration is ready. Production uses the repository's manual deployment workflow.

## Daily sync

Each athlete is synced once a day: Garmin activities and health, plan
adaptation, Strava, the calendar and the session feedback, then the briefing
and, on Mondays, the week's review when Sunday evening's was missed (the
last window, 16:00 UTC, writes it on Sunday: `docs/architecture.md`). Vercel's Hobby plan runs a cron at most once
a day, so `vercel.json` lists ten daily windows on the same path, from 07:00 to
16:00 UTC (each fires within its hour). Two earlier windows, 05:00 and 06:00
UTC on `/api/cron/checkin`, only send the morning check-in push, between
06:00 and 12:00 on the athlete's clock and outside their quiet hours; the
answer then reaches the day's decision. The first window waits for Garmin to
have the night's sleep and HRV, which arrive when the watch syncs after waking.

An athlete is owed from 07:00 on their own clock (their timezone setting), or
from `ARETE_AUTO_SYNC_HOUR` when set, and never during their quiet hours
(21:30-07:00 by default): a run there would sync before the night's data and
lose the briefing, feedback and review pushes that quiet hours drop. With the
default quiet hours, athletes from UTC-9 to UTC+5 run in their morning, those
further east in their afternoon or evening; west of UTC-9 no window falls after
07:00 local, so the scheduler skips them until a later window is added to
`vercel.json`.

A dispatch reads the athletes still owed today, least recent run or claim
first, and claims them one at a time. Time bounds it rather than a count: one
athlete's run lasts from seconds to minutes, and Vercel stops the function at
300 seconds. No
athlete is claimed after 120 seconds and no briefing or review starts after 210;
a deferred briefing is written by the dashboard's own request (`POST
/tips/daily`) when the athlete opens it, and the review stays one click away in
Planning. Later windows take whoever is still owed; a window with nothing to do
costs one query, which also reads each athlete's timezone and quiet hours. A
dispatch that reaches the 500-athlete scan bound reports `deferred` like one
stopped by time.

Each athlete carries a daily marker (`last_sync_at`) and a lease
(`sync_lease_until`), both naive UTC timestamps written from the dispatch's
clock, so Docker and Vercel writers agree whatever their timezone. Both are
dated by the claim: a run claimed at 23:58 that ends after midnight counts for
the day it started, and skips its briefing and review once that day has ended.
Markers stored by a non-UTC writer before this rule are read as UTC: shifted by
that writer's offset, they can skip one day or hold a lease longer, once. A
failed or stopped run keeps its lease for the rest of the day, so the same day
never replays it. The next day's dispatch reclaims a lease
dated before today and starts a new day: every step is idempotent per day
(activities are deduplicated by id, the scheduler writes one briefing a day and
one review a week). Overlapping windows skip what the other claimed. To park an
athlete, set its `sync_lease_until` far in the future; to force a run at the
next window, clear both columns. An always-on Docker scheduler dispatches every
five minutes around the clock; `ARETE_AUTO_SYNC_HOUR` is read on each athlete's
clock, not the host's. No queue infrastructure is introduced.

## Local validation

`make check` covers static checks, backend/frontend tests and the production build.
`npm --prefix frontend run test:browser` covers browser workflows. Tests mock
external Garmin/Clerk calls and use temporary local databases. In particular,
`test_multi_athlete.py` exercises two independent HTTP logins, MFA across workers,
Garmin import/disconnect, shared storage, files, documents, coach memory and jobs.
The browser connection test covers the visible form → MFA → sync → logout flow.
A real Garmin login and a dedicated MotherDuck preview remain rollout checks.

### Private administrator consultation in Slack

The Slack product assistant additionally permits verified Arete administrators
to read an active athlete's settings, training, health, facts, journal and stored
document extraction. This is separate from the administration HTTP endpoints,
which retain their account-management scope. Reads are restricted to an
administrator-owned DM, audited by actor/target/section, and have no training
writes or outbound communication tools. Revocation is checked at each privileged
operation. A private consultation thread never becomes a public product thread.
See [Slack administrator behavior](slack.md#administrator-product-assistant).
