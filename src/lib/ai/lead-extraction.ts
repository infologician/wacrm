import type { AiConfig, ChatMessage, LeadDetails } from './types'
import { LEAD_EXTRACTION_SYSTEM_PROMPT, aiRequestTimeoutMs } from './defaults'
import { extractLeadOpenAi } from './providers/openai'
import { extractLeadAnthropic } from './providers/anthropic'

export interface ExtractLeadDetailsArgs {
  config: AiConfig
  /** Conversation transcript, oldest first — same shape `generateReply`
   *  takes, ideally including the reply that was just sent. */
  messages: ChatMessage[]
}

/**
 * Best-effort extraction of structured lead fields from a conversation.
 * Never throws — any provider or parse failure is swallowed and reported
 * as `null`, since this runs after the customer-facing reply has already
 * been sent and must never surface as a dispatch failure.
 */
export async function extractLeadDetails(
  args: ExtractLeadDetailsArgs,
): Promise<LeadDetails | null> {
  const { config, messages } = args

  try {
    const providerArgs = {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: LEAD_EXTRACTION_SYSTEM_PROMPT,
      messages,
      timeoutMs: aiRequestTimeoutMs(),
    }

    let raw: string
    switch (config.provider) {
      case 'openai':
        raw = await extractLeadOpenAi(providerArgs)
        break
      case 'anthropic':
        raw = await extractLeadAnthropic(providerArgs)
        break
      default:
        return null
    }

    return parseLeadDetails(raw)
  } catch (err) {
    console.error('[lead-extraction] provider call failed:', err)
    return null
  }
}

/** Pull the known fields out of the model's JSON text, dropping anything
 *  that isn't a non-empty string. Returns `null` if nothing survived. */
function parseLeadDetails(raw: string): LeadDetails | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null

  const clean = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined

  const record = obj as Record<string, unknown>
  const details: LeadDetails = {
    name: clean(record.name),
    email: clean(record.email),
    company: clean(record.company),
    notes: clean(record.notes),
  }

  const hasAny = Object.values(details).some((v) => v !== undefined)
  return hasAny ? details : null
}
