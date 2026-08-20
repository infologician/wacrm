import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { classifyLead, NO_REPLY_HOURS } from '@/lib/ai/lead-status'
import { leadClassifyInboundDebounceMs } from '@/lib/ai/defaults'

// ============================================================
// Lead-status sweep — Vercel Cron target.
//
// Runs every 15-30 min (see vercel.json). Two jobs, both idempotent:
//
//   1. Content classification (the "debounce"): conversations whose most
//      recent message is at least the debounce window old — i.e. the
//      thread has settled, "no new message for a few minutes" — and that
//      have messages newer than the contact's last_classified_at. This
//      is where a conversation that was mid-burst when the inbound hook
//      fired finally gets read with full context.
//
//   2. No-reply sweep: conversations where our last message has gone
//      unanswered for >= NO_REPLY_HOURS get flipped to `no_reply`
//      (no model call — `classifyLead` handles this deterministically).
//
// `classifyLead` is cheap-to-skip (no model call unless there is genuinely
// new content) and never throws, so overlapping runs are harmless.
//
// Protected by CRON_SECRET. Accepts either Vercel Cron's native
// `Authorization: Bearer <CRON_SECRET>` header or an `x-cron-secret`
// header (for manual / external pingers), mirroring the rest of the app.
// ============================================================

// How far back to look for candidate conversations. Bounds the sweep so
// it never walks the entire history — anything quieter than this is
// considered settled long ago and left alone.
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
// Max conversations touched per run. Each is a couple of cheap reads plus
// at most one model call; keeps a single invocation well within limits.
const MAX_PER_RUN = 60
const QUERY_LIMIT = 50

function authorized(request: Request, expected: string): boolean {
  const auth = request.headers.get('authorization')
  if (auth && auth === `Bearer ${expected}`) return true
  if (request.headers.get('x-cron-secret') === expected) return true
  return false
}

interface ConvRow {
  id: string
  account_id: string
  contact_id: string
  user_id: string
  last_message_at: string
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!authorized(request, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const now = Date.now()
  const settleBefore = new Date(now - leadClassifyInboundDebounceMs()).toISOString()
  const silenceBefore = new Date(now - NO_REPLY_HOURS * 60 * 60 * 1000).toISOString()
  const lookbackAfter = new Date(now - LOOKBACK_MS).toISOString()

  const cols = 'id, account_id, contact_id, user_id, last_message_at'

  // Settled threads with recent activity → content classification.
  const settled = await db
    .from('conversations')
    .select(cols)
    .not('last_message_at', 'is', null)
    .gte('last_message_at', lookbackAfter)
    .lte('last_message_at', settleBefore)
    .order('last_message_at', { ascending: false })
    .limit(QUERY_LIMIT)

  // Long-silent threads → no-reply candidates.
  const silent = await db
    .from('conversations')
    .select(cols)
    .not('last_message_at', 'is', null)
    .gte('last_message_at', lookbackAfter)
    .lte('last_message_at', silenceBefore)
    .order('last_message_at', { ascending: false })
    .limit(QUERY_LIMIT)

  if (settled.error || silent.error) {
    const message = settled.error?.message ?? silent.error?.message ?? 'query failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Merge + de-dupe by conversation id (a silent thread also matches the
  // settled window). Cap the total touched per run.
  const seen = new Set<string>()
  const candidates: ConvRow[] = []
  for (const row of [...(settled.data ?? []), ...(silent.data ?? [])] as ConvRow[]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    candidates.push(row)
    if (candidates.length >= MAX_PER_RUN) break
  }

  let classified = 0
  let noReply = 0
  let skipped = 0
  for (const conv of candidates) {
    const result = await classifyLead(db, {
      accountId: conv.account_id,
      conversationId: conv.id,
      contactId: conv.contact_id,
      trigger: 'cron',
    })
    if (!result.applied) {
      skipped++
    } else if (result.status === 'no_reply') {
      noReply++
    } else {
      classified++
    }
  }

  return NextResponse.json({
    scanned: candidates.length,
    classified,
    noReply,
    skipped,
  })
}
