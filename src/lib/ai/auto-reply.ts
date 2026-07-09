import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { extractLeadDetails } from './lead-extraction'
import { buildSystemPrompt } from './defaults'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import type { AiConfig, ChatMessage } from './types'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and leave the inbound unanswered so it surfaces in
      // the inbox for a human. Sticky until an admin re-enables.
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr || claimed !== true) return

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
    })

    // Best-effort: pull structured lead details out of the conversation
    // now that the reply landed. Isolated in its own try/catch — a
    // failure here must never read as an auto-reply dispatch failure,
    // since the customer-facing send already succeeded.
    try {
      await extractAndSaveLeadDetails({
        db,
        config,
        accountId,
        contactId,
        configOwnerUserId,
        messages: [...messages, { role: 'assistant', content: text }],
      })
    } catch (err) {
      console.error('[lead-extraction] failed:', err)
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/** LeadDetails key -> the exact account-facing custom field name it maps
 *  to. The single source of truth tying extraction output to CRM fields. */
const CUSTOM_FIELD_NAME_BY_KEY: Record<
  'city' | 'qualification' | 'careerGoal' | 'interestedInCall' | 'preferredCallTime',
  string
> = {
  city: 'City',
  qualification: 'Qualification',
  careerGoal: 'Career Goal',
  interestedInCall: 'Interested in Call',
  preferredCallTime: 'Preferred Call Time',
}
const CUSTOM_FIELD_NAMES = Object.values(CUSTOM_FIELD_NAME_BY_KEY)

/**
 * Fill in whatever `contacts` fields (name/email/company) and custom
 * fields (City, Qualification, Career Goal, Interested in Call, Preferred
 * Call Time) are still empty, from the model's best-effort read of the
 * transcript, and log a short summary note if one was found. Never
 * overwrites data already present. Skips the LLM call entirely only once
 * every one of those fields already has a value.
 */
async function extractAndSaveLeadDetails(args: {
  db: SupabaseClient
  config: AiConfig
  accountId: string
  contactId: string
  configOwnerUserId: string
  messages: ChatMessage[]
}): Promise<void> {
  const { db, config, accountId, contactId, configOwnerUserId, messages } = args

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('name, email, company')
    .eq('id', contactId)
    .maybeSingle()
  if (contactErr || !contact) return

  // Custom fields are looked up by name, scoped to this account, so we
  // know both which of the 5 already have a value and (for the ones that
  // do) their custom_field_id — reused below instead of a second lookup.
  const { data: fieldRows } = await db
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId)
    .in('field_name', CUSTOM_FIELD_NAMES)
  const fieldIdByName = new Map<string, string>(
    (fieldRows ?? []).map((f) => [f.field_name as string, f.id as string]),
  )

  const filledCustomNames = new Set<string>()
  const fieldIds = [...fieldIdByName.values()]
  if (fieldIds.length > 0) {
    const { data: valueRows } = await db
      .from('contact_custom_values')
      .select('custom_field_id, value')
      .eq('contact_id', contactId)
      .in('custom_field_id', fieldIds)
    const nameByFieldId = new Map(
      [...fieldIdByName.entries()].map(([name, id]) => [id, name]),
    )
    for (const v of valueRows ?? []) {
      if (typeof v.value === 'string' && v.value.trim()) {
        const name = nameByFieldId.get(v.custom_field_id as string)
        if (name) filledCustomNames.add(name)
      }
    }
  }

  const coreFilled = Boolean(contact.name && contact.email && contact.company)
  const customFilled = CUSTOM_FIELD_NAMES.every((n) => filledCustomNames.has(n))
  if (coreFilled && customFilled) return // nothing left to fill in anywhere

  const details = await extractLeadDetails({ config, messages })
  if (!details) return

  const patch: Record<string, string> = {}
  if (!contact.name && details.name) patch.name = details.name
  if (!contact.email && details.email) patch.email = details.email
  if (!contact.company && details.company) patch.company = details.company

  if (Object.keys(patch).length > 0) {
    await db.from('contacts').update(patch).eq('id', contactId)
  }

  if (details.notes) {
    await db.from('contact_notes').insert({
      contact_id: contactId,
      user_id: configOwnerUserId,
      note_text: `AI-extracted lead details: ${details.notes}`,
    })
  }

  for (const [key, fieldName] of Object.entries(CUSTOM_FIELD_NAME_BY_KEY) as [
    keyof typeof CUSTOM_FIELD_NAME_BY_KEY,
    string,
  ][]) {
    if (filledCustomNames.has(fieldName)) continue // never overwrite
    const value = details[key]
    if (!value) continue

    let customFieldId = fieldIdByName.get(fieldName)
    if (!customFieldId) {
      const { data: created, error: createErr } = await db
        .from('custom_fields')
        .insert({
          field_name: fieldName,
          field_type: 'text',
          user_id: configOwnerUserId,
          account_id: accountId,
        })
        .select('id')
        .single()
      if (createErr || !created) continue
      customFieldId = created.id as string
      fieldIdByName.set(fieldName, customFieldId)
    }

    await db
      .from('contact_custom_values')
      .upsert(
        { contact_id: contactId, custom_field_id: customFieldId, value },
        { onConflict: 'contact_id,custom_field_id' },
      )
  }
}
