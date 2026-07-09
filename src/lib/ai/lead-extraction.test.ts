import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractLeadDetails } from './lead-extraction'
import type { AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
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

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('extractLeadDetails — OpenAI', () => {
  it('parses a JSON-mode response into lead fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  name: 'Jane Doe',
                  email: 'jane@example.com',
                  company: 'Acme',
                  notes: 'Wants a demo.',
                }),
              },
            },
          ],
        }),
      ),
    )

    const res = await extractLeadDetails({
      config: config(),
      messages: [{ role: 'user', content: "I'm Jane from Acme, jane@example.com" }],
    })

    expect(res).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Acme',
      notes: 'Wants a demo.',
    })
  })

  it('requests JSON mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: '{}' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await extractLeadDetails({
      config: config(),
      messages: [{ role: 'user', content: 'hi' }],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('drops empty/non-string fields and returns null when nothing survives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          choices: [{ message: { content: JSON.stringify({ name: '', email: null }) } }],
        }),
      ),
    )

    const res = await extractLeadDetails({
      config: config(),
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res).toBeNull()
  })

  it('returns null (never throws) on malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ choices: [{ message: { content: 'not json' } }] }),
      ),
    )
    const res = await extractLeadDetails({
      config: config(),
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res).toBeNull()
  })

  it('returns null (never throws) on a provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(500, { error: 'boom' })),
    )
    const res = await extractLeadDetails({
      config: config(),
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res).toBeNull()
  })
})

describe('extractLeadDetails — Anthropic', () => {
  it('parses the forced tool_use input into lead fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          content: [
            {
              type: 'tool_use',
              name: 'record_lead_details',
              input: { name: 'Jane Doe', company: 'Acme' },
            },
          ],
        }),
      ),
    )

    const res = await extractLeadDetails({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      messages: [{ role: 'user', content: "I'm Jane from Acme" }],
    })

    expect(res).toEqual({ name: 'Jane Doe', company: 'Acme' })
  })

  it('forces the tool call via tool_choice', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'tool_use', name: 'record_lead_details', input: {} }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await extractLeadDetails({
      config: config({ provider: 'anthropic' }),
      messages: [{ role: 'user', content: 'hi' }],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_lead_details' })
    expect(body.tools).toHaveLength(1)
  })

  it('returns null (never throws) when no tool_use block is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'huh' }] })),
    )
    const res = await extractLeadDetails({
      config: config({ provider: 'anthropic' }),
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res).toBeNull()
  })
})
