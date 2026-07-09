import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  extractLeadDetails: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    contact: null as Record<string, unknown> | null,
    contactUpdatePayload: null as Record<string, unknown> | null,
    noteInsertPayload: null as Record<string, unknown> | null,
    customFields: [] as { id: string; field_name: string }[],
    customValues: [] as { custom_field_id: string; value: string | null }[],
    customFieldInserts: [] as Record<string, unknown>[],
    customValueUpserts: [] as Record<string, unknown>[],
  },
}))

const ALL_CUSTOM_FIELD_NAMES = [
  'City',
  'Qualification',
  'Career Goal',
  'Interested in Call',
  'Preferred Call Time',
]

/** Fixture: all 5 custom fields already defined and already filled. */
function fullyFilledCustomFields() {
  const fields = ALL_CUSTOM_FIELD_NAMES.map((field_name, i) => ({
    id: `cf-${i + 1}`,
    field_name,
  }))
  const values = fields.map((f) => ({ custom_field_id: f.id, value: 'already set' }))
  return { fields, values }
}

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./lead-extraction', () => ({ extractLeadDetails: h.extractLeadDetails }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: h.state.contact, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            h.state.contactUpdatePayload = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'contact_notes') {
        return {
          insert: (payload: Record<string, unknown>) => {
            h.state.noteInsertPayload = payload
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'custom_fields') {
        return {
          select: () => ({
            eq: () => ({
              in: () =>
                Promise.resolve({ data: h.state.customFields, error: null }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            h.state.customFieldInserts.push(payload)
            const created = {
              id: `cf-new-${h.state.customFields.length + 1}`,
              field_name: payload.field_name as string,
            }
            h.state.customFields.push(created)
            return {
              select: () => ({
                single: () => Promise.resolve({ data: created, error: null }),
              }),
            }
          },
        }
      }
      if (table === 'contact_custom_values') {
        return {
          select: () => ({
            eq: () => ({
              in: () =>
                Promise.resolve({ data: h.state.customValues, error: null }),
            }),
          }),
          upsert: (payload: Record<string, unknown>) => {
            h.state.customValueUpserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.contact = { name: null, email: null, company: null }
  h.state.contactUpdatePayload = null
  h.state.noteInsertPayload = null
  h.state.customFields = []
  h.state.customValues = []
  h.state.customFieldInserts = []
  h.state.customValueUpserts = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.extractLeadDetails.mockResolvedValue(null)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
    expect(h.state.rpcCalls).toHaveLength(0)
  })
})

describe('dispatchInboundToAiReply — lead extraction', () => {
  it('fills in only the missing contact fields, without overwriting existing ones', async () => {
    h.state.contact = { name: null, email: 'existing@x.com', company: null }
    h.extractLeadDetails.mockResolvedValue({
      name: 'Jane Doe',
      email: 'ignored@x.com',
      company: 'Acme',
      notes: 'Wants a demo of the pro plan.',
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.contactUpdatePayload).toEqual({ name: 'Jane Doe', company: 'Acme' })
    expect(h.state.noteInsertPayload).toEqual({
      contact_id: 'contact-1',
      user_id: 'user-1',
      note_text: 'AI-extracted lead details: Wants a demo of the pro plan.',
    })
  })

  it('skips the extraction call entirely when contact + all custom fields are already fully populated', async () => {
    h.state.contact = { name: 'Jane', email: 'jane@x.com', company: 'Acme' }
    const { fields, values } = fullyFilledCustomFields()
    h.state.customFields = fields
    h.state.customValues = values
    await dispatchInboundToAiReply(ARGS)
    expect(h.extractLeadDetails).not.toHaveBeenCalled()
    expect(h.state.contactUpdatePayload).toBeNull()
  })

  it('updates nothing when extraction finds no usable details', async () => {
    h.extractLeadDetails.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.contactUpdatePayload).toBeNull()
    expect(h.state.noteInsertPayload).toBeNull()
  })

  it('still completes (reply already sent) if extraction throws', async () => {
    h.extractLeadDetails.mockRejectedValue(new Error('provider exploded'))
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()
    expect(h.engineSendText).toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — custom field extraction', () => {
  it('still runs extraction (does not early-skip) when core fields are filled but custom fields are missing', async () => {
    h.state.contact = { name: 'Jane', email: 'jane@x.com', company: 'Acme' }
    h.extractLeadDetails.mockResolvedValue({ city: 'Austin' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.extractLeadDetails).toHaveBeenCalled()
  })

  it('creates the custom_fields definition when missing, then upserts the value', async () => {
    h.extractLeadDetails.mockResolvedValue({ city: 'Austin', preferredCallTime: 'Mornings' })
    await dispatchInboundToAiReply(ARGS)

    expect(h.state.customFieldInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field_name: 'City',
          field_type: 'text',
          account_id: 'acct-1',
          user_id: 'user-1',
        }),
        expect.objectContaining({ field_name: 'Preferred Call Time' }),
      ]),
    )
    expect(h.state.customValueUpserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contact_id: 'contact-1', value: 'Austin' }),
        expect.objectContaining({ contact_id: 'contact-1', value: 'Mornings' }),
      ]),
    )
  })

  it('reuses an existing custom_fields row instead of creating a duplicate', async () => {
    h.state.customFields = [{ id: 'cf-city', field_name: 'City' }]
    h.state.customValues = [] // field exists, but no value yet
    h.extractLeadDetails.mockResolvedValue({ city: 'Austin' })
    await dispatchInboundToAiReply(ARGS)

    expect(h.state.customFieldInserts).toEqual([])
    expect(h.state.customValueUpserts).toEqual([
      { contact_id: 'contact-1', custom_field_id: 'cf-city', value: 'Austin' },
    ])
  })

  it('never overwrites a custom field that already has a value', async () => {
    h.state.customFields = [{ id: 'cf-city', field_name: 'City' }]
    h.state.customValues = [{ custom_field_id: 'cf-city', value: 'Existing City' }]
    h.extractLeadDetails.mockResolvedValue({ city: 'Austin', qualification: "Bachelor's" })
    await dispatchInboundToAiReply(ARGS)

    // City already has a value — no insert/upsert touches it.
    expect(h.state.customValueUpserts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ custom_field_id: 'cf-city' })]),
    )
    // Qualification was empty — it does get filled in.
    expect(h.state.customFieldInserts).toEqual(
      expect.arrayContaining([expect.objectContaining({ field_name: 'Qualification' })]),
    )
  })
})
