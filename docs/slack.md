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
   Bot scopes: `chat:write`, `assistant:write` (suggested prompts), `im:history`, `im:write` (DM answers to channel
   mentions), `users:read` and `users:read.email` (identity), `channels:history`
   and `groups:history` (channels Arete is invited to). No user token, no Socket Mode.
2. Install the app from **OAuth & Permissions** (reinstall after a scope change).
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

Slack must reach this endpoint without Vercel Authentication. The endpoint
verifies HMAC signatures and rejects requests older than five minutes before
parsing them. With `ARETE_AUTH=clerk`, `/slack/events` is a public path: Slack
sends no Clerk session, so the signature is its only credential. Calendar tools
stay unavailable from Slack because they need a verified Clerk session.

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
The session is marked `processing` before the coach starts. One native Slack
stream displays provisional answer text and task cards with French labels, never
tool arguments or raw tool results. Appends are batched at most once per second,
with hard limits of 240 appends, 100 pending chunks, 10,000 characters per batch,
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
Provisional messages carry a marker; history containing one is rejected, including
when a failed final update left partial text behind. Cleanup explicitly clears the
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
read-only planning summary. Check the loading indicator, streamed text/task cards,
the final formatted answer, and a follow-up in the same thread. Repeat from a
channel with public replies disabled: all progress must appear in a private DM.
Check one `Agent run:` log for each answered prompt. The production webhook still
points to production; local code changes alone do not change the installed app.

Migration 37 adds `app.slack_deliveries` (and `app.slack_execution`, unused since
migration 40). Migration 40 adds `app.slack_athletes`: per athlete, the public-reply
consent and the run reservation.
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
