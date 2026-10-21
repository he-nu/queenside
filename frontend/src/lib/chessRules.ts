// The ONLY file that imports chess.js (architecture rule, AGENTS.md).
// Everything else in the app uses these wrappers.
//
// chess.js 1.4.0 (installed) — note: `move()` THROWS `Error("Invalid move: ...")`
// on illegal moves instead of returning null; the `Chess` constructor THROWS on an
// invalid FEN. We catch both and re-throw as ChessRuleError with the library's
// message.

import { Chess, type Square } from 'chess.js'

export type Color = 'w' | 'b'
export type Promotion = 'q' | 'r' | 'b' | 'n'
export const PROMOTION_PIECES: Promotion[] = ['q', 'r', 'b', 'n']

export type MoveRecord = {
  san: string
  from: string
  to: string
  promotion?: Promotion
}

export class ChessRuleError extends Error {}

function board(fen: string): Chess {
  try {
    return new Chess(fen)
  } catch (e) {
    throw new ChessRuleError(e instanceof Error ? e.message : `Invalid FEN: ${fen}`)
  }
}

/** The standard initial position FEN. */
export function initialFen(): string {
  return new Chess().fen()
}

/** Color to move in `fen` (no game-over check; use gameStatus for display). */
export function turnToMove(fen: string): Color {
  return board(fen).turn()
}

export function isGameOver(fen: string): boolean {
  return board(fen).isGameOver()
}

/**
 * Human-readable status line: "White to move" / "Black to move" /
 * "Checkmate — Black wins" / "Stalemate — draw" / other draws.
 */
export function gameStatus(fen: string): string {
  const b = board(fen)
  if (b.isCheckmate()) return b.turn() === 'w' ? 'Checkmate — Black wins' : 'Checkmate — White wins'
  if (b.isStalemate()) return 'Stalemate — draw'
  if (b.isThreefoldRepetition()) return 'Draw — threefold repetition'
  if (b.isInsufficientMaterial()) return 'Draw — insufficient material'
  if (b.isDrawByFiftyMoves()) return 'Draw — fifty-move rule'
  if (b.isDraw()) return 'Draw'
  return b.turn() === 'w' ? 'White to move' : 'Black to move'
}

/** Piece on `square`, or null for an empty square. */
export function pieceAt(fen: string, square: string): { type: string; color: Color } | null {
  return board(fen).get(square as Square) ?? null
}

/**
 * Destination squares of legal moves for the side to move from `square`
 * (castling included, expressed as the king's destination).
 * Returns [] for empty squares, pieces not to move, or positions where no
 * move is legal; the game itself is never modified.
 */
export function legalTargets(fen: string, from: string): string[] {
  const b = board(fen)
  const piece = b.get(from as Square)
  if (!piece || piece.color !== b.turn()) return []
  return b
    .moves({ square: from as Square, verbose: true })
    .map((m) => m.to)
    .sort()
}

/** Whether the legal move `from` -> `to` (if any) is a pawn promotion. */
export function needsPromotion(fen: string, from: string, to: string): boolean {
  const b = board(fen)
  return b
    .moves({ square: from as Square, verbose: true })
    .some((m) => m.to === (to as Square) && m.promotion)
}

/**
 * Validate a pasted FEN. Throws ChessRuleError (with the library's message)
 * for empty or invalid input; returns the trimmed FEN on success.
 */
export function validateFen(fen: string): string {
  const trimmed = fen.trim()
  if (!trimmed) throw new ChessRuleError('FEN is empty')
  board(trimmed)
  return trimmed
}

/**
 * Load the MAINLINE of a PGN. The game must start from the standard initial
 * position, or from the position given in a `[FEN ...]` header tag. Variations
 * in parentheses and comments are parsed but not part of the returned line.
 * Returns `fens` (starting position first) and the mainline moves.
 * Throws ChessRuleError for empty or invalid PGN.
 */
export function loadPgnMainline(pgn: string): { fens: string[]; moves: MoveRecord[] } {
  const text = pgn.trim()
  if (!text) throw new ChessRuleError('PGN is empty')
  const loaded = new Chess()
  try {
    loaded.loadPgn(text)
  } catch (e) {
    throw new ChessRuleError(e instanceof Error ? e.message : `Invalid PGN: ${text}`)
  }
  // Replay the mainline to collect the FEN after each move, starting from the
  // position in the [FEN] header if the PGN has one.
  const headerFen = loaded.getHeaders()['FEN']
  const replay: Chess = headerFen ? board(headerFen) : new Chess()
  const fens: string[] = [replay.fen()]
  const moves: MoveRecord[] = []
  for (const m of loaded.history({ verbose: true })) {
    replay.move({ from: m.from, to: m.to, promotion: m.promotion })
    moves.push({
      san: m.san,
      from: m.from,
      to: m.to,
      promotion: (m.promotion ?? undefined) as Promotion | undefined,
    })
    fens.push(replay.fen())
  }
  return { fens, moves }
}

/**
 * Build a PGN (move text, no headers) from a SAN sequence: `1. e4 e5 2. Nf3`.
 * A SAN sequence re-imports to the same game (SAN is unambiguous per position).
 */
export function pgnFromSans(sans: string[]): string {
  const parts: string[] = []
  for (let i = 0; i < sans.length; i++) {
    parts.push(i % 2 === 0 ? `${i / 2 + 1}. ${sans[i]}` : sans[i])
  }
  return parts.join(' ')
}

/** Validate `fen` and return its canonical form (the board's own FEN). */
export function normalizeFen(fen: string): string {
  return board(fen).fen()
}

export type UciMove = { from: string; to: string; promotion?: Promotion }

/**
 * Parse a UCI move (`d2d3`, `e1g1`, `e7e8q`); null for malformed input.
 * Castling arrives as the king's destination (`e1g1` / `e1c1`).
 */
export function parseUci(uci: string): UciMove | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci)
  if (!m) return null
  return { from: m[1], to: m[2], promotion: m[3] ? (m[3] as Promotion) : undefined }
}

/**
 * Play one move. Returns the FEN after the move and its SAN annotation
 * (captures, promotion, castling, check all included in the SAN).
 * Throws ChessRuleError if the move is illegal; the passed FEN is never
 * mutated (a fresh board is used each call).
 */
export function makeMove(
  fen: string,
  from: string,
  to: string,
  promotion?: Promotion,
): { fen: string; san: string } {
  const b = board(fen)
  let m
  try {
    m = b.move({ from: from as Square, to: to as Square, promotion })
  } catch (e) {
    throw new ChessRuleError(e instanceof Error ? e.message : 'Invalid move')
  }
  return { fen: b.fen(), san: m.san }
}
