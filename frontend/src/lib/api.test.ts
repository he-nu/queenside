// Unit tests for the API client (PLAN M7: "Unit test for the API client
// mapping errors"). `fetch` is stubbed globally; no network is touched.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalysisError, analyzePosition, describeAnalyzeError } from './api'

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

type Case = {
  status: number
  body?: unknown
  jsonFails?: boolean
}

function jsonResponse({ status, body, jsonFails }: Case): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonFails) throw new Error('not json')
      return body
    },
  } as unknown as Response
}

function stubFetch(c: Case): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => jsonResponse(c))
  vi.stubGlobal('fetch', fn)
  return fn
}

async function expectError(status: number, message: string): Promise<void> {
  try {
    await analyzePosition(FEN, [FEN])
    throw new Error('expected analyzePosition to throw')
  } catch (e) {
    expect(e).toBeInstanceOf(AnalysisError)
    expect((e as AnalysisError).status).toBe(status)
    expect((e as AnalysisError).message).toBe(message)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('analyzePosition', () => {
  it('POSTs exactly {fen, history} to /api/analyze — never game_id/seed/temperature', async () => {
    const body = {
      fen: FEN,
      text: 't',
      best_move_uci: 'a2a3',
      move_source: 'best_move' as const,
      finish_reason: 'stop',
      generated_tokens: 64,
      critical_line: { steps: [], illegal_at: null },
      elapsed_ms: 5,
    }
    const fn = stubFetch({ status: 200, body })
    const res = await analyzePosition(FEN, ['h1'])
    expect(res).toEqual(body)
    expect(fn).toHaveBeenCalledTimes(1)
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/analyze')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    const sent = JSON.parse(init.body as string) as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['fen', 'history'])
    expect(sent.fen).toBe(FEN)
    expect(sent.history).toEqual(['h1'])
  })

  it('accepts an empty history without special-casing it', async () => {
    const body = {
      fen: FEN,
      text: 't',
      best_move_uci: null,
      move_source: 'no_legal_moves' as const,
      finish_reason: 'stop',
      generated_tokens: 64,
      critical_line: { steps: [], illegal_at: null },
      elapsed_ms: 5,
    }
    stubFetch({ status: 200, body })
    const res = await analyzePosition(FEN, [])
    expect(res.best_move_uci).toBeNull()
    expect(res.move_source).toBe('no_legal_moves')
  })

  // The detail strings are the exact ones from API.md.
  it('maps 429 to the exact "engine busy" detail', async () => {
    stubFetch({ status: 429, body: { detail: 'engine busy' } })
    await expectError(429, 'engine busy')
  })

  it('maps 503 to the exact "engine loading" detail', async () => {
    stubFetch({ status: 503, body: { detail: 'engine loading' } })
    await expectError(503, 'engine loading')
  })

  it('maps 400 to the exact validation details', async () => {
    stubFetch({ status: 400, body: { detail: 'invalid FEN' } })
    await expectError(400, 'invalid FEN')

    stubFetch({ status: 400, body: { detail: 'invalid history FEN at index 2' } })
    await expectError(400, 'invalid history FEN at index 2')

    stubFetch({ status: 400, body: { detail: 'history too long (max 512)' } })
    await expectError(400, 'history too long (max 512)')
  })

  it('maps 5xx to the server detail when present', async () => {
    stubFetch({ status: 500, body: { detail: 'engine crashed' } })
    await expectError(500, 'engine crashed')
  })

  it('falls back to a message with the HTTP status when the body is not JSON', async () => {
    stubFetch({ status: 502, jsonFails: true })
    await expectError(502, 'Analyze failed (HTTP 502)')
  })

  it('falls back to a message when the JSON body has no string detail', async () => {
    stubFetch({ status: 500, body: { detail: null } })
    await expectError(500, 'Analyze failed (HTTP 500)')
  })

  it('describeAnalyzeError: friendly text for 429/503, exact detail otherwise', () => {
    expect(describeAnalyzeError(new AnalysisError('engine busy', 429))).toContain(
      'already running',
    )
    expect(describeAnalyzeError(new AnalysisError('engine loading', 503))).toContain('loading')
    expect(describeAnalyzeError(new AnalysisError('invalid FEN', 400))).toBe('invalid FEN')
    expect(describeAnalyzeError(new AnalysisError('boom', 500))).toBe('boom')
    expect(describeAnalyzeError(new Error('network down'))).toBe('network down')
    expect(describeAnalyzeError(null)).toBe('Analyze failed')
  })
})
