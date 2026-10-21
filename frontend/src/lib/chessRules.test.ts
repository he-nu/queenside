import { describe, expect, it } from 'vitest'
import {
  ChessRuleError,
  gameStatus,
  initialFen,
  isGameOver,
  legalTargets,
  loadPgnMainline,
  makeMove,
  needsPromotion,
  pieceAt,
  pgnFromSans,
  turnToMove,
  validateFen,
} from './chessRules'

const START = initialFen()
const FEN_WHITE_PROMO = '8/P7/8/8/8/8/8/k6K w - - 0 1'
const FEN_BLACK_PROMO = 'k7/8/8/8/8/8/1p3K2/8 b - - 0 1'

describe('legal moves', () => {
  it('lists legal targets for the side to move from the start position', () => {
    expect(legalTargets(START, 'e2').sort()).toEqual(['e3', 'e4'])
    expect(legalTargets(START, 'g1').sort()).toEqual(['f3', 'h3'])
    expect(legalTargets(START, 'b1').sort()).toEqual(['a3', 'c3'])
    // fully blocked pieces have no legal moves
    expect(legalTargets(START, 'a1')).toEqual([])
    expect(legalTargets(START, 'd1')).toEqual([])
    expect(legalTargets(START, 'e1')).toEqual([])
  })

  it('includes castling as the king destination', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
    expect(legalTargets(fen, 'e1').sort()).toEqual(['c1', 'd1', 'd2', 'e2', 'f1', 'f2', 'g1'])
  })

  it('returns [] for empty squares, pieces not to move, and off-board', () => {
    expect(legalTargets(START, 'e4')).toEqual([]) // empty
    expect(legalTargets(START, 'e7')).toEqual([]) // black pawn, white to move
    expect(legalTargets(START, 'x9')).toEqual([]) // off-board
  })

  it('reports the color to move', () => {
    expect(turnToMove(START)).toBe('w')
    expect(turnToMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1')).toBe('b')
  })

  it('reports the piece on a square', () => {
    expect(pieceAt(START, 'e2')).toEqual({ type: 'p', color: 'w' })
    expect(pieceAt(START, 'g8')).toEqual({ type: 'n', color: 'b' })
    expect(pieceAt(START, 'f8')).toEqual({ type: 'b', color: 'b' })
    expect(pieceAt(START, 'e4')).toBeNull()
  })
})

describe('promotion', () => {
  it('detects a white pawn promotion and makes it', () => {
    expect(needsPromotion(FEN_WHITE_PROMO, 'a7', 'a8')).toBe(true)
    const res = makeMove(FEN_WHITE_PROMO, 'a7', 'a8', 'q')
    expect(res.san).toMatch(/^a8=Q/)
    expect(pieceAt(res.fen, 'a8')).toEqual({ type: 'q', color: 'w' })
  })

  it('detects a black pawn promotion and makes it with any piece', () => {
    expect(needsPromotion(FEN_BLACK_PROMO, 'b2', 'b1')).toBe(true)
    const res = makeMove(FEN_BLACK_PROMO, 'b2', 'b1', 'n')
    expect(res.san).toMatch(/^b1=N/)
    expect(pieceAt(res.fen, 'b1')).toEqual({ type: 'n', color: 'b' })
  })

  it('throws ChessRuleError when a promotion move is played without a piece', () => {
    expect(() => makeMove(FEN_WHITE_PROMO, 'a7', 'a8')).toThrow(ChessRuleError)
    expect(() => makeMove(FEN_BLACK_PROMO, 'b2', 'b1')).toThrow(ChessRuleError)
  })

  it('does not flag a non-promotion move', () => {
    expect(needsPromotion(START, 'e2', 'e4')).toBe(false)
  })
})

describe('SAN', () => {
  it('annotates quiet moves, knight moves, captures, castling and promotion', () => {
    let res = makeMove(START, 'e2', 'e4')
    expect(res.san).toBe('e4')
    res = makeMove(res.fen, 'e7', 'e5')
    expect(res.san).toBe('e5')
    res = makeMove(res.fen, 'g1', 'f3')
    expect(res.san).toBe('Nf3')

    const captureFen = 'r3k3/8/8/2p5/1P6/8/4K3/8 b - - 0 1'
    const cap = makeMove(captureFen, 'c5', 'b4')
    expect(cap.san).toBe('cxb4')

    const castleFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
    expect(makeMove(castleFen, 'e1', 'g1').san).toBe('O-O')
    expect(makeMove(castleFen, 'e1', 'c1').san).toBe('O-O-O')
  })

  it('records captured pieces and check symbols in the resulting FEN/SAN', () => {
    const fen = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'
    expect(isGameOver(fen)).toBe(true)
    expect(gameStatus(fen)).toBe('Checkmate — Black wins')
  })

  it('reports stalemate and stalemate status for the side to move', () => {
    const staleFen = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'
    expect(isGameOver(staleFen)).toBe(true)
    expect(gameStatus(staleFen)).toBe('Stalemate — draw')
  })

  it('says who is to move in an open position', () => {
    expect(gameStatus(START)).toBe('White to move')
  })
})

describe('import / export', () => {
  // 10 half-moves, includes castling.
  const TEN_MOVE_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7'
  const TEN_MOVE_FINAL = 'r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 4 6'

  it('imports a known 10-move PGN and ends on the expected FEN', () => {
    const { fens, moves } = loadPgnMainline(TEN_MOVE_PGN)
    expect(moves.length).toBe(10)
    expect(fens.length).toBe(11)
    expect(fens[0]).toBe(START)
    expect(fens[10]).toBe(TEN_MOVE_FINAL)
    expect(moves.map((m) => m.san)).toEqual([
      'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7',
    ])
    // each record carries from/to (needed by the UI and the M7 history)
    for (const m of moves) expect(m.from).toMatch(/^[a-h][1-8]$/)
    for (const m of moves) expect(m.to).toMatch(/^[a-h][1-8]$/)
  })

  it('follows the mainline of a PGN with comments and variations', () => {
    const { moves } = loadPgnMainline('1. e4 {center} e5 2. Nf3 (2. d4 d5) Nc6 3. Bb5 a6')
    expect(moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'])
  })

  it('round-trips: FEN + PGN export re-import to the same game', () => {
    const { fens, moves } = loadPgnMainline(TEN_MOVE_PGN)
    const exported = pgnFromSans(moves.map((m) => m.san))
    expect(exported).toBe('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7')
    const again = loadPgnMainline(exported)
    expect(again.fens).toEqual(fens)
    expect(again.moves.map((m) => m.san)).toEqual(moves.map((m) => m.san))
    // and the final FEN re-imports to itself
    expect(validateFen(fens[10])).toBe(fens[10])
  })

  it('rejects invalid FENs with a ChessRuleError', () => {
    expect(() => validateFen('')).toThrow(ChessRuleError)
    expect(() => validateFen('   ')).toThrow(ChessRuleError)
    expect(() => validateFen('garbage')).toThrow(ChessRuleError)
    expect(() => validateFen('8/8/8/8/8/8/8/8 w - - 0 1')).toThrow(ChessRuleError)
    expect(validateFen(START)).toBe(START)
  })

  it('starts from the position in a [FEN] header when present', () => {
    const headerFen = '8/8/8/8/4k3/8/8/4K3 w - - 0 1'
    const { fens, moves } = loadPgnMainline(`[FEN "${headerFen}"]\n1. Ke2 Kd4`)
    expect(fens.length).toBe(3)
    expect(validateFen(fens[0])).toBe(fens[0])
    expect(pieceAt(fens[0], 'e1')).toEqual({ type: 'k', color: 'w' })
    expect(moves.map((m) => m.san)).toEqual(['Ke2', 'Kd4'])
  })

  it('rejects an empty PGN and an invalid PGN with a ChessRuleError', () => {
    expect(() => loadPgnMainline('   ')).toThrow(ChessRuleError)
    expect(() => loadPgnMainline('1. e4 e5 2. Nf3 zzz 3. d4')).toThrow(ChessRuleError)
    expect(() => loadPgnMainline('not a pgn at all')).toThrow(ChessRuleError)
  })

  it('builds PGN move text with correct numbering for odd move counts', () => {
    expect(pgnFromSans(['e4', 'e5', 'Nf3'])).toBe('1. e4 e5 2. Nf3')
    expect(pgnFromSans([])).toBe('')
  })
})

describe('invalid moves', () => {
  it('throws ChessRuleError for illegal moves and leaves nothing ambiguous', () => {
    expect(() => makeMove(START, 'e2', 'e5')).toThrow(ChessRuleError)
    expect(() => makeMove(START, 'e7', 'e5')).toThrow(ChessRuleError) // black pawn, white to move
    expect(() => makeMove(START, 'e1', 'd2')).toThrow(ChessRuleError) // onto own pawn
  })

  it('still allows the move after an illegal attempt (stateless wrapper)', () => {
    expect(() => makeMove(START, 'e2', 'e5')).toThrow()
    const res = makeMove(START, 'e2', 'e4')
    expect(res.san).toBe('e4')
    expect(res.fen).not.toBe(START)
  })
})
