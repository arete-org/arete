# Arete in Slack

Every athlete can talk to the coach in Slack: in **direct messages**, and in
**every channel Arete was invited to** when it is mentioned. It answers in a thread; replying in
that thread continues the conversation, and a new message starts a new one. It
uses the existing chat coach, including its training-write capabilities and
journal. Files, edits and shared channels are ignored. Slack and browser
conversations stay separate.

## Who is answered

The author of each message is identified from their Slack profile: a full member
of the workspace (no guest, bot or external account) with a confirmed address.
That address must belong to a **verified** Arete login (`app.users`) or to
`ARETE_OWNER_EMAIL`, and resolve to exactly one active athlete; otherwise Arete
replies that no account is linked and never invokes the coach. Each message runs
in its own author's athlete scope, so when another member replies in a channel
thread, the answer reads and writes **their** data. Other members' messages in
the thread are labelled `[Autre participant <@U…>]`, and the coach is told never
to attribute them to the athlete or store them in its memory.

In a channel, Arete answers a message that mentions it or that replies in one
of its threads; Slack only sends messages from channels the app is a member of. An answer is **public only if the athlete enabled** « Autoriser
Arete à me répondre en public dans les canaux Slack » (Réglages → Connexions, off by
default); otherwise the answer goes to the athlete's DM with a short note in the
thread. The coach's prompt says who will read the answer.

## Installation

1. At <https://api.slack.com/apps>, choose **Create New App → From a manifest**,
   select workspace `T0C7ZT5V0F7`, and paste [`slack-manifest.json`](../slack-manifest.json).
   Bot scopes: `chat:write`, `reactions:write` (logo acknowledgment), `assistant:write` (suggested prompts), `im:history`, `im:write` (DM answers to channel
   mentions), `users:read` and `users:read.email` (identity), `channels:history`
   and `groups:history` (channels Arete is invited to), `channels:read` and
   `groups:read` (recipient membership checks). No user token, no Socket Mode.
2. Install the app from **OAuth & Permissions** (reinstall after a scope change).
   The workspace's custom logo emoji must be named `image-5`.
   Set these variables on the Arete Vercel project, in Production only:

   | Variable | Value |
   |---|---|
   | `SLACK_SIGNING_SECRET` | Basic Information → App Credentials → Signing Secret |
   | `SLACK_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`) |
   | `SLACK_TEAM_ID` | `T0C7ZT5V0F7` |

   Pipe copied values through `tr -d '[:space:]'` into `vercel env add`; never put
   secrets in source, command arguments or chat. A new deployment applies them.
3. The manifest enables `agent_view` with three fixed French suggested prompts,
   and subscribes to `app_home_opened`, `message.im`, `message.channels` and
   `message.groups` at `https://arete-arete15.vercel.app/api/slack/events`. Invite
   Arete to each channel where it should answer (`/invite @Arete`); removing it stops it there.
4. Send Arete a DM, then mention it in the channel. Check one `Agent run:` log per
   answered message, and that a member without an Arete account gets the
   "no account" reply.

Slack must reach this endpoint without an interactive Vercel login. The endpoint
verifies HMAC signatures and rejects requests older than five minutes before
parsing them. With `ARETE_AUTH=clerk`, `/slack/events` is a public path: Slack
sends no Clerk session, so the signature is its only credential. Calendar tools
stay unavailable from Slack because they need a verified Clerk session.

### Development app

Keep the development Slack app separate from production. In its **App Manifest**,
add `channels:read` and `groups:read` to `oauth_config.scopes.bot`, preserving its
development name and event URL. Then **OAuth & Permissions → Reinstall to
Workspace** authorizes the additional scopes. The checked-in manifest's URL
targets production: do not paste it unchanged into the development app.

On Vercel, the **Preview** environment needs the development app's
`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` and workspace `SLACK_TEAM_ID`, plus
`LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY`. Redeploy after changing
variables. After merge and a successful main preview deployment, use the stable
event endpoint `https://arete-main-arete15.vercel.app/api/slack/events`. Before
merge, a PR labelled `preview` gets an ephemeral URL in its deployment comment;
that deployment is removed when the PR closes, so switch back to the stable URL.

For a protected preview, configure **Vercel → Settings → Deployment Protection →
Protection Bypass for Automation** and append `?x-vercel-protection-bypass=SECRET`
to the event URL in the private Slack app settings. Slack cannot attach a custom
authentication header; Vercel documents this [webhook configuration](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation#slack-bot-webhook-verification).
Never commit or share that secret. Leave cookie bypass disabled; Slack still signs
every event and Arete still checks the signature.

Verify the event URL in Slack, invite the development bot and a test recipient to
a test channel, and use an active **Arete administrator in the preview database**
whose verified login email matches their Slack email. Slack administrator status
alone is insufficient. Test a ping, a reminder followed by cancellation, and a
private athlete consultation from the channel before production rollout.

## Execution and limits

The endpoint acknowledges before its attached FastAPI background task imports
the coach, restores journal files or queries MotherDuck. The deployed Vercel
Python runtime must support the full ASGI response lifecycle (verified against
`vercel-runtime==0.23.2`, bundled by CLI 63.1.0). This is not a detached task or a
durable job queue. A process terminated after acknowledgment can lose the job;
it is deliberately not replayed. Cold app startup still runs schema initialization
before the route: validate Slack's three-second receipt deadline on the actual
deployment, including a cold start. Slack retries are deduplicated in the database.

One Slack coach run at a time per athlete, across instances; overlapping
requests from that athlete receive a busy response and are not queued. On MotherDuck two near-simultaneous
admissions can conflict on the reservation row; the loser is answered busy
too, and releasing a finished run retries its idempotent write up to five
times. Existing browser runs are independent. A turn
has a 240-second coaching/history/stream deadline. Each HTTP call has a 10-second
timeout and no retries. After that deadline, failure display and cleanup can take
up to three more HTTP calls (stop, replace the partial answer, clear status).
The chat runtime's model/tool limits and complete-context token guard still apply.
No model requests are added for Slack formatting, progress or suggestions.

History is read from Slack, at most 60 messages (16,000 characters per user
message, 39,000 per answer). Partial,
paginated or stale history, and other members' messages in a DM, are rejected
explicitly, never truncated.
The session is marked `processing` before the coach starts. Arete adds the
`image-5` reaction to the original user message; a failed reaction is logged and
does not block coaching or trigger a retry. The reaction remains as acknowledgment.
One native Slack stream starts with the first tool or text event, without a
placeholder message. It displays provisional answer text and task cards with
French labels, never tool arguments or raw tool results. Stream writes are batched
at most once per second, with hard limits of 240 writes, 100 pending chunks, 10,000 characters per batch,
64,000 streamed characters and 50 distinct task cards (Slack's plan limit).
The shared runtime projection accepts at most 12,000 events and 64,000 text
characters. Exceeding a bound fails explicitly; nothing is silently dropped.

When the graph finishes, only its completed, tool-free model answer becomes
canonical. The stream is stopped and the same message is replaced, removing
provisional text from earlier model attempts and task cards from conversation
history. Answers up to 12,000 escaped characters use a native Markdown block;
longer answers retain the full plain text, up to 39,000 characters. Mentions are
escaped in rich output and automatic mention parsing is disabled in final text.
The final `text` field serves both accessibility and subsequent Slack history.
If the provider produces no stream events, the completed answer is posted directly.
The delivery ledger records the destination thread before streaming. Threads with
an earlier running or failed delivery are rejected, including when a failed final
update left partial text behind. Legacy provisional markers are still recognized.
Cleanup explicitly clears the
session status before releasing the athlete's admission reservation.

For a channel request without public consent, Arete creates a DM root quoting the
athlete's request and streams under that root. No answer tokens or tool progress
are sent to the source channel; only the existing private-reply notice is posted
there after completion. No message text is stored in the delivery ledger. Existing
optional LangSmith tracing still includes the messages and Slack thread ID.

`app_home_opened` is acknowledged without model work; the manifest supplies fixed
suggested prompts. Stop events and interactive buttons are not enabled: stopping
an in-flight tool across server instances needs its own execution contract.

## Local verification and rollout

Run `make check` before shipping. Tests mock Slack HTTP and model execution; they
cover stream delivery, final-answer reconciliation, private routing, interruption,
deduplication, payload bounds and cleanup failures. No live Slack messages are sent.

After local validation and an authorized deployment, send a DM asking for a
read-only planning summary. Check the logo reaction, native loading indicator
without a placeholder message, streamed text/task cards,
the final formatted answer, and a follow-up in the same thread. Repeat from a
channel with public replies disabled: all progress must appear in a private DM.
Check one `Agent run:` log for each answered prompt. The production webhook still
points to production; local code changes alone do not change the installed app.

Migration 37 adds `app.slack_deliveries` (and `app.slack_execution`, unused since
migration 40). Migration 40 adds `app.slack_athletes`: per athlete, the public-reply
consent and the run reservation. Migration 42 adds nullable destination thread IDs
to deliveries, keeping interrupted output out of history without a visible marker.
The ledger stops accepting new events at 100,000 records, requiring operator
review rather than silently forgetting duplicate IDs.

## Interrupted runs

An interrupted coach can already have committed a write, and synchronous tools
may finish after cancellation. Its reservation therefore stays locked. Check the
event's logs, wait until its Vercel invocation and tools have stopped, and inspect
training data in Arete. Do not resend the original request blindly.

Once the outcome is understood, an operator can clear **that exact event's**
reservation in the MotherDuck SQL console (replace the literal event key):

```sql
UPDATE app.slack_athletes SET run_event_key = NULL
WHERE run_event_key = 'T0C7ZT5V0F7:Ev_REVIEWED_EVENT';
```

This unblocks only the athlete that event belonged to; other athletes were never
blocked.

Keep its delivery row: deleting it would allow an old Slack delivery to execute
again. This does not queue or replay any blocked messages. A send failure after a
completed coach run releases execution but is not retried, because Slack may
have accepted the message before the connection failed.

## References

- [Slack Events API acknowledgment and retries](https://docs.slack.dev/apis/events-api/)
- [Slack signature verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Thread history API](https://docs.slack.dev/reference/methods/conversations.replies/)
- [User profile and email](https://docs.slack.dev/reference/methods/users.info/)
- [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi)

## Administrator product assistant

Verified Arete administrators use the same Slack bot for product coordination.
Each of their messages is classified before graph selection or personal-data reads:
**coach** for their training, **product** for coordination, or a clarification when
intent is ambiguous. Other athletes incur no classification request. This feature
requires `LLM_PROVIDER=openrouter`; an unavailable or invalid classification performs
no action and reports the failure. Slack workspace administrator status grants no
Arete privileges.

Examples:

- `@Arete ping @Arthur pour ses tickets front` mentions Arthur in this thread.
- `Relance-le demain à 10 h` schedules a one-off reminder in the same thread.
- `Liste mes rappels` and `Annule le rappel …` inspect/cancel the caller's reminders.
- `Lis les données d’entraînement et le journal de Grégoire` opens an administrator
  DM before reading any data or streaming any progress.

The product identity uses a versioned brief about Arete, plus the current thread.
It has no live GitHub connector, ticket status, code-writing access, recurrent
reminders or autonomous monitoring. Human active Slack members can be contacted
without an Arete account. Names with multiple matches require clarification.
Destination defaults to the source thread; a target outside that channel requires
an explicit DM request. No automatic channel invitation or collective mention.
Product coordination does not use the athlete's public-coaching consent setting;
ordinary coaching retains that setting.

Private administrator reads are a new Arete permission: accounts, settings, cardio
and strength sessions, planning, health, facts, journals and stored document
extractions. Credentials and browser-local conversations are unavailable. The
service rechecks the actor's account and scopes each read to one active athlete;
audit logs record actor, target and section, not result text. Optional LangSmith
tracing continues to include inputs/results, including these private reads.
Missing document extraction is reported, not synthesized. Read windows and outputs
are bounded and paginated; narrowing a request never silently discards its history.

A thread that has entered private administration stays private and requires its
original active administrator on every turn, including after a topic change. It
has no outgoing-message or training-write tools. Mixed private-analysis/ping
requests ask for two separate threads. Removing admin rights blocks subsequent
privileged operations; already scheduled messages remain with Slack until cancelled.

The classifier uses the effective OpenRouter route and price cap, 1024 output
tokens, temperature 0, a 15-second timeout, and no SDK retry or model fallback.
One classification consumes one of the existing 24 model turns; stats include
it in the same `Agent run:` record. Graphs are cached by athlete, selected profile
and the effective GLM flag. Clients and Slack execution dependencies stay local to
the invocation; Slack never gains the browser's Calendar approval capability.

Slack accepts reminders at most 120 days ahead. The author's Slack timezone is
used, falling back to Europe/Paris (announced in the context and confirmation).
Missing hours and DST ambiguities require clarification. At most five Slack
writes per invocation, one recipient per message, and 2000 body characters.
Directory and channel membership lookups stop with an explicit error after ten
pages of 200 members. Scheduling uses `chat.scheduleMessage` with `thread_ts` and
without `metadata`; Slack owns delivery, requiring no scheduler or model at send time.
Cancellation is unavailable in the final 60 seconds. `scheduled` means Slack
accepted the request; a passed due date is not evidence of delivery.

Migration **44** adds `slack_identities`, `slack_private_threads` and
`slack_operations`. The latter retains the outgoing message body, actor, target,
destination and scheduled time as an operation receipt, not conversation history.
Before an external write its receipt is `uncertain`; only Slack's confirmed
response records success. A timeout, interruption or unconfirmed cancellation
is never replayed, even if the model repeats the tool call. Inspect Slack and
these receipts before issuing any new request after an ambiguous result.

Reinstall the manifest to grant `channels:read` and `groups:read` for membership
checks. Existing `chat:write`, `users:read` and `users:read.email` cover the other
new operations. After authorized deployment, use test accounts to verify immediate
mentions, scheduling/cancellation, private redirection, role revocation and a
non-admin coaching request. Never run these sends against real recipients in CI.

Normal tests mock models and Slack. An optional ten-request synthetic routing
quality evaluation sends no Slack messages and binds no tools:

```sh
ARETE_SURFACE_EVAL=1 ARETE_EVAL_DB=/path/to/copy.duckdb uv run pytest tests/test_slack_surface_evals.py -s
```

It reports decisions, accuracy failures, latency and request counts; the default
run skips it. It uses the configured free OpenRouter route, with no fallback.
