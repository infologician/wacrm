import { AiError, type ChatMessage } from '../types'
import { MAX_OUTPUT_TOKENS, MAX_EXTRACTION_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: {
    type?: string
    text?: string
    name?: string
    input?: unknown
  }[]
}

const LEAD_DETAILS_TOOL_NAME = 'record_lead_details'

/** Forces structured output: Anthropic has no JSON mode, so we define a
 *  single tool matching the lead-fields shape and require the model to
 *  call it. */
const LEAD_DETAILS_TOOL = {
  name: LEAD_DETAILS_TOOL_NAME,
  description:
    'Record the structured lead details confidently found in the conversation transcript.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The customer's full name" },
      email: { type: 'string', description: "The customer's email address" },
      company: {
        type: 'string',
        description: "The customer's company or organization",
      },
      notes: {
        type: 'string',
        description:
          'A short 1-2 sentence summary of what the customer wants or needs',
      },
    },
  },
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text (handoff parsing happens in
 * `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: normalizeForAnthropic(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  return text
}

/**
 * Call Anthropic's Messages endpoint with a forced tool call to pull
 * structured lead fields out of a conversation. Returns the tool input as
 * a JSON string (parsed by `extractLeadDetails`).
 */
export async function extractLeadAnthropic(args: ProviderArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_EXTRACTION_OUTPUT_TOKENS,
        messages: normalizeForAnthropic(messages),
        tools: [LEAD_DETAILS_TOOL],
        tool_choice: { type: 'tool', name: LEAD_DETAILS_TOOL_NAME },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const toolUse = data?.content?.find(
    (b) => b.type === 'tool_use' && b.name === LEAD_DETAILS_TOOL_NAME,
  )
  if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  return JSON.stringify(toolUse.input)
}
