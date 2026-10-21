import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Board, type BoardArrow, type PromotionRequest } from './components/Board'
import { analyzePosition, describeAnalyzeError, type AnalysisResponse, type MoveSource } from './lib/api'
import {
  formatEval,
  oneLine,
  parseAnalysisText,
  parseEvaluation,
  sectionLines,
} from './lib/analyzeText'
import {
  gameStatus,
  initialFen,
  isGameOver,
  legalTargets,
  loadPgnMainline,
  makeMove,
  needsPromotion,
  normalizeFen,
  parseUci,
  pieceAt,
  pgnFromSans,
  turnToMove,
  validateFen,
  type Promotion,
} from './lib/chessRules'
import { addMove, childWithUci, createTree, node, pathNodeIds, pathTo, type Tree } from './lib/tree'
import './App.css'

const START_FEN = initialFen()

/** Best-effort SAN for a critical-line step; falls back to the UCI. */
function stepLabel(s: { fen: string; uci: string }): string {
  const mv = parseUci(s.uci)
  if (!mv) return s.uci
  try {
    return makeMove(s.fen, mv.from, mv.to, mv.promotion).san
  } catch {
    return s.uci
  }
}

/** Per-API.md notes for the non-default `move_source` values. */
function moveSourceNote(source: MoveSource): ReactNode {
  switch (source) {
    case 'random_legal_fallback':
      return (
        <div className="source-note warning" role="alert">
          QUEEN produced no usable move. The move shown is a RANDOM legal
          move — it is not QUEEN's recommendation.
        </div>
      )
    case 'critical_line':
      return (
        <div className="source-note info">
          The move was recovered from QUEEN's critical-line text.
        </div>
      )
    case 'promising_or_analysis':
      return (
        <div className="source-note info">
          The move was recovered from QUEEN's promising/analysis text.
        </div>
      )
    case 'no_legal_moves':
      return (
        <div className="source-note info">
          The position has no legal moves — the game is over.
        </div>
      )
    case 'best_move':
      return null
  }
}

/**
 * FENs previewed while stepping the critical line: the analyzed position
 * first, then the position after each line move. Pure display data — the
 * game tree is never touched (SPEC feature 5).
 */
function linePreviewFens(r: AnalysisResponse): string[] {
  const steps = r.critical_line.steps
  const out: string[] = [r.fen]
  for (let i = 0; i < steps.length; i++) {
    const next = steps[i + 1]
    if (next !== undefined) {
      out.push(next.fen) // steps[i+1].fen is the position before move i+1
    } else {
      // The final position is not in the response; play the last step.
      const s = steps[i]
      const mv = parseUci(s.uci)
      if (mv) {
        try {
          out.push(makeMove(s.fen, mv.from, mv.to, mv.promotion).fen)
        } catch {
          out.push(s.fen)
        }
      } else {
        out.push(s.fen)
      }
    }
  }
  return out
}

function App() {
  // Variation tree (M6): `tree` holds every position ever played (all
  // branches included); `nodeId` is the position currently shown on the
  // board. The root is a real node holding the starting position.
  const [tree, setTree] = useState<Tree>(() => createTree(START_FEN))
  const [nodeId, setNodeId] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [orientation, setOrientation] = useState<'white' | 'black'>('white')
  const [promotion, setPromotion] = useState<PromotionRequest | null>(null)
  const [fenInput, setFenInput] = useState('')
  const [pgnInput, setPgnInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'fen' | 'pgn' | null>(null)
  // Analyze (M7): request state, the results keyed by canonical position FEN
  // (UI cache: navigating back to an analyzed position reopens its result;
  // the backend cache separately makes re-analysis instant), and the
  // critical-line preview index (0 = analyzed position, steps.length = after
  // the last line move).
  const [analyzing, setAnalyzing] = useState(false)
  const [results, setResults] = useState<Map<string, AnalysisResponse>>(
    () => new Map(),
  )
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [lineIdx, setLineIdx] = useState<number | null>(null)

  const node_ = node(tree, nodeId)
  const fen = node_.fen
  const turn = turnToMove(fen)
  const gameOver = isGameOver(fen)
  // The current position's result, when analyzed (a cached result reopens
  // when the player navigates back to the position).
  const fenNorm = useMemo(() => normalizeFen(fen), [fen])
  const res = !analyzing && analyzeError === null ? (results.get(fenNorm) ?? null) : null
  const steps = res ? res.critical_line.steps : []
  const previewIdx = res !== null && lineIdx !== null ? Math.min(lineIdx, steps.length) : null
  const previewFens = res ? linePreviewFens(res) : []
  // What the board actually shows: the line preview position while stepping
  // the critical line, otherwise the real position of the current node.
  const displayFen = previewIdx !== null ? previewFens[previewIdx] : fen
  let boardArrows: BoardArrow[] = []
  if (previewIdx !== null) {
    if (previewIdx < steps.length) {
      const mv = parseUci(steps[previewIdx].uci)
      if (mv) boardArrows = [{ from: mv.from, to: mv.to }]
    }
  } else if (res !== null && res.best_move_uci !== null) {
    const mv = parseUci(res.best_move_uci)
    if (mv) boardArrows = [{ from: mv.from, to: mv.to }]
  }
  const displayStatus = gameStatus(displayFen)
  const displayedGameOver = isGameOver(displayFen)
  const bestLabel = useMemo(() => {
    if (res === null || res.best_move_uci === null) return ''
    const mv = parseUci(res.best_move_uci)
    if (!mv) return res.best_move_uci
    try {
      return makeMove(res.fen, mv.from, mv.to, mv.promotion).san
    } catch {
      return res.best_move_uci
    }
  }, [res])
  const targets = useMemo(() => (selected ? legalTargets(fen, selected) : []), [fen, selected])

  // Evaluations to display next to the move that REACHES the position
  // (keyed by the position's FEN), converted to the display sign:
  // positive = white's advantage, negative = black's advantage. Engine-
  // signed numbers are absolute already; unsigned ones are read from the
  // player-POV wording and flipped for black-to-move FENs (see
  // parseEvaluation).
  const evalByFen = useMemo(() => {
    const m = new Map<string, number>()
    for (const [f, r] of results) {
      const side: 'white' | 'black' = f.split(' ')[1] === 'b' ? 'black' : 'white'
      const e = parseEvaluation(r.text, side)
      if (e === null) continue
      m.set(f, e)
    }
    return m
  }, [results])

  // Parsed QUEEN output-text sections (lib/analyzeText); when the text has
  // no `SECTION:` structure the raw text is shown instead.
  const parsed = useMemo(() => (res ? parseAnalysisText(res.text) : null), [res])
  const evSection = parsed
    ? (parsed.sections.find((s) => s.key === 'EVALUATION') ?? null)
    : null
  const panelEval = res ? evalByFen.get(res.fen) : undefined
  const prose = useMemo((): string[] => {
    if (res === null || parsed === null) return []
    if (!parsed.hasStructure) return [res.text]
    const parts = parsed.preamble ? [parsed.preamble] : []
    parts.push(...sectionLines(parsed.sections.find((s) => s.key === 'ANALYSIS')))
    return parts
  }, [res, parsed])

  // A square selected in one position is meaningless in another; the line
  // preview belongs to the old position too.
  useEffect(() => {
    setSelected(null)
    setPromotion(null)
    setLineIdx(null)
  }, [nodeId])
  // The newest move (bottom row) is always visible as the move list grows.
  const moveListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = moveListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [tree])

  // Navigation along the current path / the most recent continuation:
  const goStart = () => setNodeId(tree.rootId)
  const goBack = () => {
    if (node_.parentId !== null) setNodeId(node_.parentId)
  }
  const goForward = () => {
    const children = node_.children
    if (children.length > 0) setNodeId(children[children.length - 1])
  }
  const goEnd = () => {
    let cur = nodeId
    for (;;) {
      const children = node(tree, cur).children
      if (children.length === 0) break
      cur = children[children.length - 1]
    }
    setNodeId(cur)
  }
  const atRoot = node_.parentId === null
  const atLeaf = node_.children.length === 0

  // Arrow keys / Home / End navigate the tree (SPEC feature 2), but ignore
  // keystrokes that originate in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') goBack()
      else if (e.key === 'ArrowRight') goForward()
      else if (e.key === 'Home') goStart()
      else if (e.key === 'End') goEnd()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Playing a move: if the current position already has a child with the
  // same UCI, navigate to it (same line); otherwise create a branch.
  // Previous moves of other branches are kept (SPEC feature 3).
  const playMove = (from: string, to: string, promo?: Promotion): boolean => {
    if (gameOver) return false
    if (previewIdx !== null) return false // board shows a preview position
    const uci = from + to + (promo ?? '')
    const existing = childWithUci(tree, nodeId, uci)
    if (existing !== null) {
      setNodeId(existing)
    } else {
      const res = makeMove(fen, from, to, promo)
      const added = addMove(tree, nodeId, { san: res.san, uci, fen: res.fen })
      setTree(added.tree)
      setNodeId(added.id)
    }
    setSelected(null)
    setPromotion(null)
    return true
  }

  // Analyze (M7): POST the current position's FEN plus its root-to-parent
  // FENs as history. game_id/seed/temperature are never sent (API.md).
  const runAnalyze = async () => {
    if (analyzing) return
    setAnalyzing(true)
    setAnalyzeError(null)
    setLineIdx(null)
    try {
      const result = await analyzePosition(fen, pathTo(tree, nodeId))
      // Store by the position itself: if the player navigated away while it
      // ran, the result is kept anyway — navigating back (re)opens it.
      setResults((prev) => {
        const next = new Map(prev)
        next.set(result.fen, result)
        return next
      })
    } catch (e) {
      setAnalyzeError(describeAnalyzeError(e))
    } finally {
      setAnalyzing(false)
    }
  }

  const playBest = () => {
    if (res === null || res.best_move_uci === null) return
    const mv = parseUci(res.best_move_uci)
    if (mv) playMove(mv.from, mv.to, mv.promotion)
  }

  const handleSquareClick = (square: string) => {
    if (previewIdx !== null) return // no board interaction while previewing
    if (promotion) {
      setPromotion(null) // clicking anywhere cancels the promotion prompt
      return
    }
    if (selected && square === selected) {
      setSelected(null)
      return
    }
    if (selected) {
      if (targets.includes(square)) {
        if (needsPromotion(fen, selected, square)) {
          setPromotion({ from: selected, to: square, color: turn })
        } else {
          playMove(selected, square)
        }
        return
      }
      const piece = pieceAt(fen, square)
      if (piece && piece.color === turn && !gameOver) {
        setSelected(square)
        return
      }
      setSelected(null)
      return
    }
    const piece = pieceAt(fen, square)
    if (piece && piece.color === turn && !gameOver) setSelected(square)
  }

  const handlePieceDrop = (from: string, to: string): boolean => {
    if (gameOver) return false
    if (previewIdx !== null) return false
    if (needsPromotion(fen, from, to)) {
      setPromotion({ from, to, color: turn })
      return false // board reverts until a promotion piece is chosen
    }
    try {
      return playMove(from, to)
    } catch {
      // Illegal drop (e.g. the side not to move): we must RETURN false, not
      // let chess.js's "Invalid move" throw escape — react-chessboard only
      // clears the translucent drag ghost when onPieceDrop returns, so a
      // throw here would leave the source piece at 50% opacity.
      return false
    }
  }

  const handlePromote = (piece: Promotion) => {
    if (!promotion) return
    const { from, to } = promotion
    playMove(from, to, piece)
  }

  // Reset: after a confirmation, erase the whole recorded tree (every
  // branch) and the analysis state; back to the standard starting position.
  const resetBoard = () => {
    if (
      !window.confirm(
        'Reset the board? This erases all recorded moves (including all branches) and the current analysis.',
      )
    )
      return
    setTree(createTree(START_FEN))
    setNodeId(0)
    setSelected(null)
    setPromotion(null)
    setLineIdx(null)
    setResults(new Map())
    setAnalyzeError(null)
  }

  // Import / export (SPEC feature 4). Importing replaces the whole tree; an
  // imported FEN has no move history, so it becomes a one-node tree.
  const importFen = () => {
    try {
      const fen = validateFen(fenInput)
      setTree(createTree(fen))
      setNodeId(0)
      setFenInput('')
      setImportError(null)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Invalid FEN')
    }
  }

  const importPgn = () => {
    try {
      const { fens, moves } = loadPgnMainline(pgnInput)
      let t = createTree(fens[0])
      let cur = t.rootId
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i]
        const added = addMove(t, cur, {
          san: m.san,
          uci: m.from + m.to + (m.promotion ?? ''),
          fen: fens[i + 1],
        })
        t = added.tree
        cur = added.id
      }
      setTree(t)
      setNodeId(cur) // navigate to the end of the imported mainline
      setPgnInput('')
      setImportError(null)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Invalid PGN')
    }
  }

  const copyExport = async (kind: 'fen' | 'pgn', text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setImportError('Could not copy to the clipboard')
    }
  }

  // PGN of the line from the root to the current node (path only, no
  // variations — PGN export of the whole tree is out of scope).
  const pathPgnsans = pathNodeIds(tree, nodeId).map((id) => node(tree, id).san)

  // Move list: one row per full move — n. | white | black. The preferred
  // line (first child of each node) fills the rows; a side branch of the
  // position at that depth is a dim, smaller nested line under the move,
  // following its own preferred line and its own nested branches. Move
  // fonts are hierarchical so the mainline reads at a glance:
  // big/bright mainline > small/dim variations > faint turn numbers.
  const mainPath: number[] = []
  {
    let cur = tree.rootId
    for (;;) {
      const kids = node(tree, cur).children
      if (kids.length === 0) break
      cur = kids[0]
      mainPath.push(cur)
    }
  }
  const mainDepth = mainPath.length

  const moveButton = (id: number) => (
    <button
      type="button"
      className={nodeId === id ? 'active' : ''}
      onClick={() => setNodeId(id)}
    >
      {node(tree, id).san}
    </button>
  )

  // The eval pill for the position reached by the move at depth `d`, shown
  // in that row's right-hand eval column (dimmed; the sign is explicit).
  const evalPill = (d: number): ReactNode => {
    if (d > mainDepth) return null
    const ev = evalByFen.get(node(tree, mainPath[d - 1]).fen)
    if (ev === undefined) return null
    return <span className="eval">{formatEval(ev)}</span>
  }

  const numLabel = (depth: number) => {
    const moveNo = Math.floor(depth / 2) + 1
    return depth % 2 === 1 ? `${moveNo}.` : `${moveNo}...`
  }

  // The preferred path from node `id` (at `depth`) as inline nodes, each
  // level's side branches in nested lines.
  const renderSubtree = (id: number, depth: number): ReactNode[] => {
    const n = node(tree, id)
    const out: ReactNode[] = [
      <span key={`sn${id}`} className="num">
        {numLabel(depth)}
      </span>,
      moveButton(id),
    ]
    for (const c of n.children.slice(1)) {
      out.push(
        <span key={`sv${c}`} className="variation-line">
          {renderSubtree(c, depth + 1)}
        </span>,
      )
    }
    if (n.children.length > 0) out.push(...renderSubtree(n.children[0], depth + 1))
    return out
  }

  // Cell for the preferred line's move at depth `d`, plus one variation
  // line per sibling at that depth.
  const renderCell = (d: number) => {
    const mainId = mainPath[d - 1]
    const parentPos = d === 1 ? tree.rootId : mainPath[d - 2]
    const parent = node(tree, parentPos)
    return (
      <span className="move-cell">
        {moveButton(mainId)}
        {parent.children.slice(1).map((c) => (
          <span key={`cv${c}`} className="variation-line">
            {renderSubtree(c, d)}
          </span>
        ))}
      </span>
    )
  }

  return (
    <div className="app">
      <section className="analyze-section">
        <button
          type="button"
          className="analyze-btn"
          onClick={() => void runAnalyze()}
          disabled={analyzing}
        >
          {analyzing ? 'Analyzing…' : 'Analyze'}
        </button>
        {analyzing && (
          <div className="analyzing" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>This can take up to about a minute. Please wait.</span>
          </div>
        )}
        {analyzeError !== null && (
          <div className="io-error" role="alert">
            {analyzeError}
          </div>
        )}
        {res !== null && (
          <div className="analysis-results">
            {res.best_move_uci !== null ? (
              <div className="result-row">
                <span>
                  QUEEN's best move: <strong>{bestLabel}</strong>
                </span>
                <button
                  type="button"
                  onClick={playBest}
                  disabled={previewIdx !== null}
                  title="Play QUEEN's best move as the next real move (creates a branch if needed)"
                >
                  Play it
                </button>
              </div>
            ) : (
              <div className="result-row muted">
                {res.move_source === 'no_legal_moves'
                  ? 'The position has no legal moves — the game is over.'
                  : 'QUEEN returned no best move for this position.'}
              </div>
            )}
            {moveSourceNote(res.move_source)}
            {panelEval !== undefined && (
              <div className="eval-box">
                <span className={"eval-number"}>
                  {formatEval(panelEval)}
                </span>
                <span className="eval-text">
                  {evSection
                    ? oneLine(evSection)
                    : 'QUEEN evaluation (positive = white advantage)'}
                </span>
              </div>
            )}
            {prose.length > 0 && (
              <div className="explanation">
                <h3>QUEEN's explanation (may be inaccurate)</h3>
                <div className="explanation-box">
                  {prose.map((p, i) => (
                    <p
                      key={i}
                      className={
                        parsed && parsed.hasStructure ? 'explanation-p' : 'explanation-text'
                      }
                    >
                      {p}
                    </p>
                  ))}
                </div>
                {res.finish_reason === 'length' && (
                  <div className="source-note info">
                    QUEEN's output was cut off at the token limit.
                  </div>
                )}
              </div>
            )}
            {parsed &&
              parsed.sections
                .filter(
                  (s) => !['ANALYSIS', 'BEST_MOVE', 'CRITICAL_LINE', 'EVALUATION'].includes(s.key),
                )
                .map((s) => (
                  <div className="extra-section" key={s.key}>
                    <h3>{s.key.replace(/_/g, ' ')}</h3>
                    <div className="extra-body">{oneLine(s)}</div>
                  </div>
                ))}
            {steps.length > 0 ? (
              <div className="critline">
                <div className="critline-head">
                  <h3>Critical line</h3>
                  <button
                    type="button"
                    onClick={() => setLineIdx(previewIdx === null ? 0 : null)}
                    title="Preview the line on the board, position by position (does not change the move list)"
                  >
                    {previewIdx === null ? 'Preview' : 'Close ✕'}
                  </button>
                </div>
                {previewIdx !== null && (
                  <div className="io-row step-ctrl">
                    <button
                      type="button"
                      onClick={() => setLineIdx(Math.max(0, previewIdx - 1))}
                      disabled={previewIdx <= 0}
                      title="Previous line position"
                    >
                      ◀
                    </button>
                    <span>
                      position {previewIdx}/{steps.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => setLineIdx(Math.min(steps.length, previewIdx + 1))}
                      disabled={previewIdx >= steps.length}
                      title="Next line position"
                    >
                      ▶
                    </button>
                  </div>
                )}
                <div className="critline-steps">
                  {steps.map((s, i) => (
                    <button
                      key={`${s.ply}-${s.uci}`}
                      type="button"
                      className={previewIdx === i ? 'active' : ''}
                      onClick={() => setLineIdx(i)}
                      title={`${s.uci} (ply ${s.ply}) — show this position on the board`}
                    >
                      {stepLabel(s)}
                    </button>
                  ))}
                </div>
                {res.critical_line.illegal_at !== null && (
                  <div className="source-note info">
                    The line becomes illegal at ply{' '}
                    {res.critical_line.illegal_at.ply} ({res.critical_line.illegal_at.reason}).
                  </div>
                )}
              </div>
            ) : (
              <div className="result-row muted">No critical line.</div>
            )}
          </div>
        )}
      </section>

      <Board
        fen={displayFen}
        orientation={orientation}
        selected={selected}
        legalTargets={targets}
        gameOver={displayedGameOver}
        promotion={promotion}
        arrows={boardArrows}
        onSquareClick={handleSquareClick}
        onPieceDrop={handlePieceDrop}
        onPromote={handlePromote}
        onPromotionCancel={() => setPromotion(null)}
      />
      <div className="sidebar">
        <div className="status">{displayStatus}</div>
        <div className="controls">
          <button type="button" onClick={goStart} disabled={atRoot} title="Start (Home)">
            ⏮
          </button>
          <button type="button" onClick={goBack} disabled={atRoot} title="Back (←)">
            ◀
          </button>
          <button type="button" onClick={goForward} disabled={atLeaf} title="Forward (→)">
            ▶
          </button>
          <button type="button" onClick={goEnd} disabled={atLeaf} title="End (End)">
            ⏭
          </button>
          <button
            type="button"
            onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
            title="Flip board"
          >
            Flip
          </button>
          <button type="button" onClick={resetBoard} title="Reset the board: erase all recorded moves (asks first)">
            Reset
          </button>
        </div>
        <div className="movelist" ref={moveListRef}>
          {Array.from({ length: Math.ceil(mainDepth / 2) }, (_, k) => (
            <div key={`${tree.nextId}.${k}`} className="move-row">
              <span className="row-num">{k + 1}.</span>
              {2 * k + 1 <= mainDepth ? (
                renderCell(2 * k + 1)
              ) : (
                <span className="move-cell" />
              )}
              <span className="eval-cell">{evalPill(2 * k + 1)}</span>
              {2 * k + 2 <= mainDepth ? (
                renderCell(2 * k + 2)
              ) : (
                <span className="move-cell" />
              )}
              <span className="eval-cell">{evalPill(2 * k + 2)}</span>
            </div>
          ))}
        </div>
        {/* Import/Export is an occasional tool: collapsed by default so it
            does not compete with the move tree for the sidebar. */}
        <details className="io-section">
          <summary className="io-summary">Import / Export</summary>
          <div className="io-body">
          <div className="io-field">
            <label htmlFor="fen-import">Import FEN</label>
            <div className="io-row">
              <input
                id="fen-import"
                type="text"
                placeholder="paste a FEN"
                value={fenInput}
                onChange={(e) => {
                  setFenInput(e.target.value)
                  if (importError) setImportError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') importFen()
                }}
              />
              <button type="button" onClick={importFen} disabled={!fenInput.trim()}>
                Load
              </button>
            </div>
          </div>
          <div className="io-field">
            <label htmlFor="pgn-import">Import PGN</label>
            <div className="io-row">
              <textarea
                id="pgn-import"
                placeholder="paste a PGN"
                rows={4}
                value={pgnInput}
                onChange={(e) => {
                  setPgnInput(e.target.value)
                  if (importError) setImportError(null)
                }}
              />
              <button type="button" onClick={importPgn} disabled={!pgnInput.trim()}>
                Load
              </button>
            </div>
          </div>
          {importError && (
            <div className="io-error" role="alert">
              {importError}
            </div>
          )}
          <div className="io-row">
            <button
              type="button"
              onClick={() => copyExport('fen', fen)}
              title="Copy the FEN of the current position"
            >
              {copied === 'fen' ? 'FEN copied ✓' : 'Export FEN'}
            </button>
            <button
              type="button"
              onClick={() => copyExport('pgn', pgnFromSans(pathPgnsans))}
              disabled={atRoot}
              title="Copy the PGN of the line from the start to the current position (disabled at the start position)"
            >
              {copied === 'pgn' ? 'PGN copied ✓' : 'Export PGN'}
            </button>
          </div>
          </div>
        </details>
      </div>
    </div>
  )
}

export default App
