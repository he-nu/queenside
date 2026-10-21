// The ONLY file that imports react-chessboard (architecture rule, AGENTS.md).
//
// Installed react-chessboard is 5.12.1: a single `<Chessboard options={...} />`
// API (no v4-style separate props). `position` accepts a FEN string,
// `onPieceDrop` returns a boolean (false puts the piece back),
// `onSquareClick` gets `{ piece, square }`.

import type { CSSProperties } from 'react'
import { Chessboard } from 'react-chessboard'
import { PROMOTION_PIECES, type Color, type Promotion } from '../lib/chessRules'

export type PromotionRequest = {
  from: string
  to: string
  color: Color
}

/** A board arrow (best move / critical-line preview), in plain squares. */
export type BoardArrow = {
  from: string
  to: string
}

type BoardProps = {
  fen: string
  orientation: 'white' | 'black'
  selected: string | null
  legalTargets: string[]
  gameOver: boolean
  promotion: PromotionRequest | null
  arrows: BoardArrow[]
  onSquareClick: (square: string) => void
  /** Return true if the piece may stay on the target square, false to revert. */
  onPieceDrop: (from: string, to: string) => boolean
  onPromote: (piece: Promotion) => void
  onPromotionCancel: () => void
}

const GLYPHS: Record<Promotion, string> = { q: '♛', r: '♜', b: '♝', n: '♞' }
const GLYPH_NAMES: Record<Promotion, string> = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }
const ARROW_COLOR = 'rgba(139, 195, 74, 0.8)'

export function Board({
  fen,
  orientation,
  selected,
  legalTargets,
  gameOver,
  promotion,
  arrows,
  onSquareClick,
  onPieceDrop,
  onPromote,
  onPromotionCancel,
}: BoardProps) {
  const squareStyles: Record<string, CSSProperties> = {}
  if (selected) squareStyles[selected] = { backgroundColor: 'rgba(255, 213, 79, 0.55)' }
  // Green targets are readable on both cream and brown squares (the board
  // moved off green so this never blends in).
  for (const square of legalTargets)
    squareStyles[square] = { backgroundColor: 'rgba(76, 175, 80, 0.55)' }

  return (
    <div className="board-wrap">
      <Chessboard
        options={{
          position: fen,
          boardOrientation: orientation,
          squareStyles,
          // Lichess-classic palette (cream + brown): keeps the green
          // legal-move indicator unambiguous (the old green board made it
          // nearly invisible on dark squares).
          lightSquareStyle: { backgroundColor: '#f0d9b5' },
          darkSquareStyle: { backgroundColor: '#b58863' },
          darkSquareNotationStyle: { color: '#f0d9b5' },
          lightSquareNotationStyle: { color: '#b58863' },
          arrows: arrows.map((a) => ({
            startSquare: a.from,
            endSquare: a.to,
            color: ARROW_COLOR,
          })),
          allowDragging: !gameOver,
          onSquareClick: ({ square }) => onSquareClick(square),
          onPieceDrop: ({ sourceSquare, targetSquare }) => {
            if (!targetSquare) return false
            return onPieceDrop(sourceSquare, targetSquare)
          },
        }}
      />
      {promotion ? (
        <div className="board-overlay promotion">
          <div className="promotion-panel">
            <span>Promote to:</span>
            {PROMOTION_PIECES.map((piece) => (
              <button
                key={piece}
                type="button"
                title={`${GLYPH_NAMES[piece]} (${promotion.color === 'b' ? 'black' : 'white'} ${piece})`}
                onClick={() => onPromote(piece)}
              >
                {GLYPHS[piece]}
              </button>
            ))}
            <button type="button" className="cancel" onClick={onPromotionCancel}>
              ✕
            </button>
          </div>
        </div>
      ) : gameOver ? (
        <div className="board-overlay over">
          <span>Game over</span>
        </div>
      ) : null}
    </div>
  )
}
