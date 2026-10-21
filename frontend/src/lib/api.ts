// The browser client for the backend API (same origin, relative URLs —
// AGENTS.md "Serving"). The frontend never sends `game_id`, `seed` or
// `temperature`: the backend applies its defaults (API.md).

export type MoveSource =
  | 'best_move'
  | 'critical_line'
  | 'promising_or_analysis'
  | 'no_legal_moves'
  | 'random_legal_fallback'

export type CriticalLineStep = { ply: number; uci: string; fen: string }

export type AnalysisResponse = {
  /** Canonical form of the analyzed position (may differ from the request). */
  fen: string
  text: string
  best_move_uci: string | null
  move_source: MoveSource
  finish_reason: string
  generated_tokens: number
  critical_line: {
    steps: CriticalLineStep[]
    /** null when the line is fully legal, otherwise {ply, reason}. */
    illegal_at: { ply: number; reason: string } | null
  }
  elapsed_ms: number
  /** Present (true) when the backend served a cached response. */
  cached?: boolean
}

/** A rejected POST /api/analyze; `status` is the HTTP status code. */
export class AnalysisError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AnalysisError'
    this.status = status
  }
}

// PLAN M7: no timeout under 120 s. A real-engine analyze can take a while
// (and a first request is served only once loading finished), so abort only
// after 5 minutes — far above any legitimate run.
const ANALYZE_TIMEOUT_MS = 300_000

function detailFromBody(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail
    if (typeof d === 'string' && d.length > 0) return d
  }
  return `Analyze failed (HTTP ${status})`
}

/**
 * Human-friendly text for a failed analyze: a specific message for 429
 * (engine busy) and 503 (engine loading); for all other errors the
 * server's exact `detail` string. Used for the error display.
 */
export function describeAnalyzeError(e: unknown): string {
  if (e instanceof AnalysisError) {
    if (e.status === 429) {
      return 'Another analysis is already running — please wait for it to finish and try again.'
    }
    if (e.status === 503) {
      return 'The engine is still loading — please wait a moment and try again.'
    }
    return e.message
  }
  return e instanceof Error ? e.message : 'Analyze failed'
}

/**
 * POST /api/analyze with the current position's FEN and its `history`
 * (the root-to-parent FEN list from the variation tree; the current FEN is
 * NOT included). Throws AnalysisError with the server's exact `detail`
 * string for 4xx/5xx responses.
 */
export async function analyzePosition(
  fen: string,
  history: string[],
): Promise<AnalysisResponse> {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fen, history }),
    signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new AnalysisError(detailFromBody(body, res.status), res.status)
  return body as AnalysisResponse
}
