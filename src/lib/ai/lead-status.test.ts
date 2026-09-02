import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Isolate the classifier orchestration from key decryption + message
// hydration; the providers themselves run for real against a stubbed
// fetch so the request bodies are asserted end-to-end.
vi.mock('./config', () => ({ loadAiConfig: vi.fn() }))
vi.mock('./context', () => ({ buildConversationContext: vi.fn() }))

import { classifyLead, parseClassification, NO_REPLY_HOURS } from './lead-status'
import { isStrongStatus, isLeadStatus, leadStatusLabel } from '@/lib/leads/status'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import type { AiConfig } from './types'

const loadAiConfigMock = vi.mocked(loadAiConfig)
const buildContextMock = vi.mocked(buildConversationContext)

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    apiKey: 'sk-ant-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function anthropicToolResponse(input: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'tool_use', name: 'record_lead_status', input }],
    }),
  } as unknown as Response
}

/**
 * Minimal chainable Supabase stand-in. `from(table)` yields a builder
 * whose terminal `.maybeSingle()` / awaited result / `.update().eq()` is
 * resolved from the scripted `opts`, and every `update` patch is captured
 * on `updates`.
 */
function makeDb(opts: {
  contact?: Record<string, unknown> | null
  lastMsg?: Record<string, unknown> | null
  newCount?: number
}) {
  const updates: { table: string; patch: Record<string, unknown> }[] = []

  function builder(table: string) {
    const b = {
      _isCount: false,
      _patch: null as Record<string, unknown> | null,
      select(_cols?: unknown, o?: { head?: boolean }) {
        if (o?.head) this._isCount = true
        return this
      },
      eq() {
        return this
      },
      gt() {
        return this
      },
      order() {
        return this
      },
      limit() {
        return this
      },
      update(patch: Record<string, unknown>) {
        this._patch = patch
        return this
      },
      maybeSingle() {
        if (table === 'contacts') return Promise.resolve({ data: opts.contact ?? null })
        if (table === 'messages') return Promise.resolve({ data: opts.lastMsg ?? null })
        return Promise.resolve({ data: null })
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        let result: unknown
        if (this._patch) {
          updates.push({ table, patch: this._patch })
          result = { data: null, error: null }
        } else if (this._isCount) {
          result = { count: opts.newCount ?? 0, error: null }
        } else {
          result = { data: [], error: null }
        }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return b
  }

  return { db: { from: (t: string) => builder(t) } as never, updates }
}

const BASE = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  loadAiConfigMock.mockReset()
  buildContextMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('parseClassification', () => {
  it('parses a full object and trims/limits fields', () => {
    const res = parseClassification(
      JSON.stringify({
        status: 'interested',
        reason: '  wants a call  ',
        name: ' Ada ',
        interest_track: 'Data Science',
        experience_level: 'Beginner',
        best_callback_time: 'Evenings',
        city: 'Lagos',
      }),
    )
    expect(res).toEqual({
      status: 'interested',
      reason: 'wants a call',
      name: 'Ada',
      city: 'Lagos',
      interest_track: 'Data Science',
      experience_level: 'Beginner',
      best_callback_time: 'Evenings',
    })
  })

  it('returns null on an invalid status', () => {
    expect(parseClassification(JSON.stringify({ status: 'maybe', reason: 'x' }))).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseClassification('not json')).toBeNull()
  })
})

describe('lead status helpers', () => {
  it('marks only interested/not_interested as strong', () => {
    expect(isStrongStatus('interested')).toBe(true)
    expect(isStrongStatus('not_interested')).toBe(true)
    expect(isStrongStatus('pending')).toBe(false)
    expect(isStrongStatus('no_reply')).toBe(false)
  })

  it('validates the vocabulary and labels unknowns as New', () => {
    expect(isLeadStatus('need_time')).toBe(true)
    expect(isLeadStatus('nope')).toBe(false)
    expect(leadStatusLabel('no_reply')).toBe('No reply')
    expect(leadStatusLabel(null)).toBe('New')
  })
})

describe('classifyLead — idempotency & no-reply', () => {
  it('flips to no_reply when our last message is unanswered past the window', async () => {
    const oldIso = new Date(Date.now() - (NO_REPLY_HOURS + 5) * 3_600_000).toISOString()
    const { db, updates } = makeDb({
      contact: { lead_status: 'pending', lead_status_source: 'ai', last_classified_at: oldIso },
      lastMsg: { sender_type: 'agent', created_at: oldIso },
      newCount: 0,
    })

    const res = await classifyLead(db, BASE)
    expect(res).toEqual({ status: 'no_reply', applied: true })
    expect(updates).toHaveLength(1)
    expect(updates[0].patch.lead_status).toBe('no_reply')
    // No new content → the idempotency anchor must NOT advance.
    expect(updates[0].patch.last_classified_at).toBeUndefined()
    expect(loadAiConfigMock).not.toHaveBeenCalled()
  })

  it.each(['interested', 'need_time'] as const)(
    'does not bury an AI-set %s status under no_reply after the window',
    async (status) => {
      // Going quiet for a day is not a change of mind. These statuses are
      // things the customer told us; the timer must not overwrite them or
      // warm leads become indistinguishable from people who never engaged.
      const oldIso = new Date(Date.now() - (NO_REPLY_HOURS + 5) * 3_600_000).toISOString()
      const { db, updates } = makeDb({
        contact: { lead_status: status, lead_status_source: 'ai', last_classified_at: oldIso },
        lastMsg: { sender_type: 'agent', created_at: oldIso },
        newCount: 0,
      })

      const res = await classifyLead(db, BASE)
      expect(res.applied).toBe(false)
      expect(res.skipped).toBe('no_new_messages')
      expect(updates).toHaveLength(0)
    },
  )

  it('does not flip a manual status to no_reply', async () => {
    const oldIso = new Date(Date.now() - (NO_REPLY_HOURS + 5) * 3_600_000).toISOString()
    const { db, updates } = makeDb({
      contact: { lead_status: 'interested', lead_status_source: 'manual', last_classified_at: oldIso },
      lastMsg: { sender_type: 'agent', created_at: oldIso },
      newCount: 0,
    })

    const res = await classifyLead(db, BASE)
    expect(res.applied).toBe(false)
    expect(res.skipped).toBe('no_new_messages')
    expect(updates).toHaveLength(0)
  })

  it('debounces when classified within minIntervalMs', async () => {
    const { db, updates } = makeDb({
      contact: {
        lead_status: 'new',
        lead_status_source: 'ai',
        last_classified_at: new Date(Date.now() - 10_000).toISOString(),
      },
      lastMsg: { sender_type: 'customer', created_at: new Date().toISOString() },
      newCount: 3,
    })

    const res = await classifyLead(db, { ...BASE, minIntervalMs: 120_000 })
    expect(res.skipped).toBe('throttled')
    expect(updates).toHaveLength(0)
    expect(loadAiConfigMock).not.toHaveBeenCalled()
  })
})

describe('classifyLead — content classification', () => {
  it('classifies new content and fills blank attributes', async () => {
    const nowIso = new Date().toISOString()
    loadAiConfigMock.mockResolvedValue(aiConfig())
    buildContextMock.mockResolvedValue([{ role: 'user', content: 'yes call me tonight' }])
    vi.mocked(fetch).mockResolvedValue(
      anthropicToolResponse({
        status: 'interested',
        reason: 'asked to be called tonight',
        interest_track: 'Sales course',
      }),
    )

    const { db, updates } = makeDb({
      contact: {
        lead_status: 'new',
        lead_status_source: 'ai',
        last_classified_at: null,
        name: 'Existing Name',
        interest_track: null,
      },
      lastMsg: { sender_type: 'customer', created_at: nowIso },
      newCount: 2,
    })

    const res = await classifyLead(db, BASE)
    expect(res).toEqual({ status: 'interested', applied: true })
    const patch = updates[0].patch
    expect(patch.lead_status).toBe('interested')
    expect(patch.lead_status_source).toBe('ai')
    expect(patch.last_classified_at).toBe(nowIso)
    expect(patch.interest_track).toBe('Sales course')
    // Never clobber an existing name.
    expect(patch.name).toBeUndefined()
  })

  it('keeps a manual status on a weak new signal but still advances the anchor', async () => {
    const nowIso = new Date().toISOString()
    loadAiConfigMock.mockResolvedValue(aiConfig())
    buildContextMock.mockResolvedValue([{ role: 'user', content: 'still comparing options' }])
    vi.mocked(fetch).mockResolvedValue(
      anthropicToolResponse({ status: 'pending', reason: 'comparing' }),
    )

    const { db, updates } = makeDb({
      contact: { lead_status: 'interested', lead_status_source: 'manual', last_classified_at: null },
      lastMsg: { sender_type: 'customer', created_at: nowIso },
      newCount: 1,
    })

    const res = await classifyLead(db, BASE)
    expect(res.applied).toBe(true)
    expect(res.status).toBeNull() // status not applied
    const patch = updates[0].patch
    expect(patch.lead_status).toBeUndefined()
    expect(patch.last_classified_at).toBe(nowIso)
  })

  it('overrides a manual status on a strong new signal', async () => {
    const nowIso = new Date().toISOString()
    loadAiConfigMock.mockResolvedValue(aiConfig())
    buildContextMock.mockResolvedValue([{ role: 'user', content: 'no thanks, stop' }])
    vi.mocked(fetch).mockResolvedValue(
      anthropicToolResponse({ status: 'not_interested', reason: 'declined' }),
    )

    const { db, updates } = makeDb({
      contact: { lead_status: 'interested', lead_status_source: 'manual', last_classified_at: null },
      lastMsg: { sender_type: 'customer', created_at: nowIso },
      newCount: 1,
    })

    const res = await classifyLead(db, BASE)
    expect(res.status).toBe('not_interested')
    expect(updates[0].patch.lead_status).toBe('not_interested')
  })

  it('forces the record_lead_status tool with the status enum', async () => {
    loadAiConfigMock.mockResolvedValue(aiConfig())
    buildContextMock.mockResolvedValue([{ role: 'user', content: 'hi' }])
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValue(anthropicToolResponse({ status: 'pending', reason: 'x' }))

    const { db } = makeDb({
      contact: { lead_status: 'new', lead_status_source: 'ai', last_classified_at: null },
      lastMsg: { sender_type: 'customer', created_at: new Date().toISOString() },
      newCount: 1,
    })
    await classifyLead(db, BASE)

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_lead_status' })
    expect(body.tools[0].input_schema.properties.status.enum).toEqual([
      'new',
      'interested',
      'need_time',
      'pending',
      'not_interested',
      'no_reply',
    ])
  })

  it('skips when no AI key is configured', async () => {
    loadAiConfigMock.mockResolvedValue(null)
    const { db, updates } = makeDb({
      contact: { lead_status: 'new', lead_status_source: 'ai', last_classified_at: null },
      lastMsg: { sender_type: 'customer', created_at: new Date().toISOString() },
      newCount: 1,
    })
    const res = await classifyLead(db, BASE)
    expect(res.skipped).toBe('no_ai_config')
    expect(updates).toHaveLength(0)
  })
})
