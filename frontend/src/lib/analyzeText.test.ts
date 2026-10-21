// Unit tests for the QUEEN output-text parser (analyzeText.ts). The
// shapes mirror the real fixture tests/fixtures/startpos_cli_t0.json
// (ANALYSIS prose, then BEST_MOVE / CRITICAL_LINE / PROMISING_MOVES /
// EVALUATION one-line sections).

import { describe, expect, it } from 'vitest'
import {
  formatEval,
  oneLine,
  parseAnalysisText,
  parseEvaluation,
  sectionLines,
} from './analyzeText'

const SAMPLE = [
  'ANALYSIS:',
  'The position arises after 1.e4 e5 2.d4, a symmetrical structure. The central tension',
  '',
  'The best move is 3...white pawn d2-d4, immediately challenging the center.',
  '',
  'The alternative 3...white knight g1-f3 is also sound.',
  'BEST_MOVE: white pawn d2-d4',
  'CRITICAL_LINE: white pawn d2-d4 black knight g8-f6',
  '  white pawn e2-e3',
  'PROMISING_MOVES: white pawn d2-d4 white knight g1-f3 white pawn e2-e3',
  'EVALUATION: the player holds a small advantage of approximately +0.20 pawns from the initiative.',
].join('\n')

describe('parseAnalysisText', () => {
  it('finds all five sections in order with their bodies', () => {
    const p = parseAnalysisText(SAMPLE)
    expect(p.hasStructure).toBe(true)
    expect(p.preamble).toBe('')
    expect(p.sections.map((s) => s.key)).toEqual([
      'ANALYSIS',
      'BEST_MOVE',
      'CRITICAL_LINE',
      'PROMISING_MOVES',
      'EVALUATION',
    ])
    expect(p.sections[4].body).toContain('+0.20 pawns')
  })

  it('keeps multi-line field bodies (CRITICAL_LINE wraps)', () => {
    const p = parseAnalysisText(SAMPLE)
    const cl = oneLine(p.sections.find((s) => s.key === 'CRITICAL_LINE'))
    expect(cl).toBe('white pawn d2-d4 black knight g8-f6 white pawn e2-e3')
  })

  it('splits the ANALYSIS body into paragraphs at blank lines', () => {
    const p = parseAnalysisText(SAMPLE)
    const paras = sectionLines(p.sections.find((s) => s.key === 'ANALYSIS'))
    expect(paras).toEqual([
      'The position arises after 1.e4 e5 2.d4, a symmetrical structure. The central tension',
      'The best move is 3...white pawn d2-d4, immediately challenging the center.',
      'The alternative 3...white knight g1-f3 is also sound.',
    ])
  })

  it('captures text before the first header as preamble', () => {
    const p = parseAnalysisText('some stray sentence\n\nANALYSIS:\nBody here.')
    expect(p.preamble).toBe('some stray sentence')
    expect(p.sections[0].key).toBe('ANALYSIS')
  })

  it('has no structure for plain (mock-style) text', () => {
    const p = parseAnalysisText(
      'Mock analysis: I recommend a2a3 here. This is canned deterministic text.',
    )
    expect(p.hasStructure).toBe(false)
    expect(p.sections).toEqual([])
    expect(p.preamble).toContain('a2a3')
    expect(oneLine(null)).toBe('')
    expect(sectionLines(undefined)).toEqual([])
  })
})

describe('parseEvaluation', () => {
  // Real model outputs left in .human/eval_output_examples.txt (player POV).
  const PLAYER_UP =
    'EVALUATION: the player is up approximately 5.36 pawns with a decisive material advantage, and castling consolidates the position while preparing to exploit the open <SQUARE_60>-<SQUARE_4> after the opponent\'s central pawns are eliminated.'
  const PLAYER_LOSING =
    'EVALUATION: the player is losing by approximately 7.25 pawns, as the opponent\'s material advantage is decisive despite the player\'s best defensive efforts.'

  it('extracts an engine-signed pawn value (absolute: same for both sides)', () => {
    expect(parseEvaluation(SAMPLE, 'white')).toBeCloseTo(0.2)
    expect(parseEvaluation(SAMPLE, 'black')).toBeCloseTo(0.2) // +0.20 is white-positive already
  })

  it('handles negative engine signs and zero (absolute)', () => {
    expect(parseEvaluation('EVALUATION: down -1.35 after the rook sac.', 'white')).toBeCloseTo(-1.35)
    expect(parseEvaluation('EVALUATION: down -1.35 after the rook sac.', 'black')).toBeCloseTo(-1.35) // absolute, no flip
    expect(parseEvaluation('EVALUATION: down −1.35 after the rook sac.', 'white')).toBeCloseTo(-1.35) // typographic minus U+2212
    expect(parseEvaluation('EVALUATION: it is 0.00, the position is balanced.', 'black')).toBe(0)
  })

  it('reads player-POV wording and flips for black to move', () => {
    expect(parseEvaluation(PLAYER_LOSING, 'white')).toBeCloseTo(-7.25) // white to move and losing -> white negative
    expect(parseEvaluation(PLAYER_LOSING, 'black')).toBeCloseTo(7.25) // black to move and losing -> white positive
    expect(parseEvaluation(PLAYER_UP, 'white')).toBeCloseTo(5.36)
    expect(parseEvaluation(PLAYER_UP, 'black')).toBeCloseTo(-5.36)
  })

  it('inverts when the wording frames the opponent', () => {
    const t = 'EVALUATION: the opponent retains a small edge of approximately 0.21 pawns in material.'
    expect(parseEvaluation(t, 'white')).toBeCloseTo(-0.21) // white to move, opponent up -> white negative
    expect(parseEvaluation(t, 'black')).toBeCloseTo(0.21)
  })

  it('returns null for an unsigned value with no polarity wording', () => {
    expect(parseEvaluation('EVALUATION: a 0.5 pawn edge remains.', 'white')).toBeNull()
  })

  it('returns null when there is no plausible number', () => {
    expect(parseEvaluation('EVALUATION: the position is roughly balanced.', 'white')).toBeNull()
    expect(parseEvaluation(SAMPLE.replace('EVALUATION: the', 'NOT_A_SECTION: the'), 'white')).toBeNull()
    expect(parseEvaluation('plain text with no sections at all', 'white')).toBeNull()
  })

  it('rejects absurd magnitudes', () => {
    expect(parseEvaluation('EVALUATION: advantage of +115 pawns.', 'white')).toBeNull()
  })
})

describe('formatEval', () => {
  it('formats with sign and one decimal', () => {
    expect(formatEval(0.2)).toBe('+0.2')
    expect(formatEval(-1.26)).toBe('-1.3')
    expect(formatEval(0)).toBe('0.0')
    expect(formatEval(3)).toBe('+3.0')
  })
})
