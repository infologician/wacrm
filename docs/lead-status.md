# Smart lead-status reader

An internal, back-office feature that reads each conversation and sets the
contact's **lead status** automatically. It reuses the workspace's existing
bring-your-own AI key (OpenAI / Anthropic) through the same server-side
decrypt + provider path as the reply assistant, and is completely separate
from the customer-facing agent — it never sends a message and never changes
auto-reply behaviour.

## Statuses

| Status           | Meaning                                                                 | Badge  |
| ---------------- | ----------------------------------------------------------------------- | ------ |
| `new`            | Not yet classified.                                                      | neutral |
| `interested`     | Clear intent to move forward (shared number/time, asked to be called, agreed to a call, asked how to join or pay, "yes I want to start"). | green  |
| `need_time`      | Positive but not now ("let me think", "after exams", "next month").     | amber  |
| `pending`        | Still in play, undecided — actively asking/comparing, or we're waiting on them. | blue   |
| `not_interested` | Explicit decline ("not interested", "no thanks", "stop").               | grey   |
| `no_reply`       | Went silent — no reply to our last message for ≥ 24h.                    | red    |

The status is shown as a colored badge on the Contacts list and the
conversation/inbox header. Contacts can be filtered by status, and a human
can override the status from a dropdown (which stamps `source = 'manual'`).
The Dashboard shows a "Leads by status" breakdown.

## How it's set

`classifyLead()` (`src/lib/ai/lead-status.ts`) loads the conversation
chronologically, calls the workspace's configured model with a strict
JSON-output rubric, and writes the result to the contact. It is:

- **idempotent** — only calls the model when a conversation has messages
  newer than `contacts.last_classified_at`;
- **respectful of manual overrides** — never overwrites a `manual` status
  unless the new read is a strong signal (`interested` / `not_interested`);
- **deterministic for silence** — flips to `no_reply` (no model call) when
  our last message has gone unanswered for ≥ 24h;
- **non-throwing** — it runs in the webhook `after()` block and the cron
  sweep, so a provider hiccup never affects the webhook response.

## Triggers

1. **Inbound (debounced).** The WhatsApp webhook path calls `classifyLead`
   after handling an inbound message. A burst collapses to at most one call
   via a debounce (`LEAD_CLASSIFY_DEBOUNCE_MS`, default 2 min); the cron
   sweep re-reads once the thread settles.
2. **Cron sweep.** `GET /api/cron/lead-status` classifies settled,
   recently-active conversations with new messages and sets `no_reply` on
   silent ones. Protected by `CRON_SECRET`.

## Scheduling the sweep

Set `CRON_SECRET` in your environment, then hit the route every 15–30 min.

- **Any host / Vercel Hobby** — point an external scheduler (cron-job.org,
  a GitHub Action, your own cron) at the route with the secret header:

  ```
  */15 * * * *  curl -fsS -H "x-cron-secret: $CRON_SECRET" https://YOUR_HOST/api/cron/lead-status
  ```

  This mirrors how the automations cron (`AUTOMATION_CRON_SECRET`) is
  driven, and keeps deploys green on the Hobby plan (which rejects
  sub-daily `vercel.json` cron schedules at deploy time).

- **Vercel Pro** — you can let Vercel Cron call it. Add a `vercel.json`:

  ```json
  {
    "crons": [{ "path": "/api/cron/lead-status", "schedule": "*/15 * * * *" }]
  }
  ```

  Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>`
  when `CRON_SECRET` is set, which the route accepts.

## Migration

See `supabase/migrations/031_lead_status.sql`. It adds `lead_status`
(+ `_reason`, `_source`, `_updated_at`), `last_classified_at`, and
`interest_track` / `experience_level` / `best_callback_time` to `contacts`,
plus an `(account_id, lead_status)` index. RLS is unchanged — `contacts` is
already workspace-scoped.
