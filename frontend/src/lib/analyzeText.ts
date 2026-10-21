// Parser for QUEEN's structured explanation text. The model emits sections
// opened by `NAME:` header lines (same grammar as the model package's
// utils/analysis.py FIELD regex): ANALYSIS, BEST_MOVE, CRITICAL_LINE,
// PROMISING_MOVES, EVALUATION. Text before the first header is preamble.
// Everything is best-effort: the UI falls back to showing the raw text
// when nothing structured is found (e.g. the mock engine's plain text).

export type TextSection = { key: string; body: string }

export type ParsedText = {
  /** Everything before the first section header. */
  preamble: string
  sections: TextSection[]
  /** True when at least one `SECTION:` header was found. */
  hasStructure: boolean
}

const HEADER =
  /^(ANALYSIS|BEST_MOVE|CRITICAL_LINE|PROMISING_MOVES|EVALUATION):\s?(.*)$/

/** Side to move — QUEEN phrases unsigned evaluations relative to the player. */
export type Side = 'white' | 'black'

/** Split raw text into sections; blank lines inside a section are kept. */
export function parseAnalysisText(text: string): ParsedText {
  const sections: TextSection[] = []
  const preambleLines: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const m = HEADER.exec(rawLine.trim())
    if (m) {
      sections.push({ key: m[1], body: m[2] ?? '' })
    } else if (sections.length > 0) {
      const last = sections[sections.length - 1]
      last.body = last.body === '' ? rawLine.trim() : last.body + '\n' + rawLine.trim()
    } else {
      preambleLines.push(rawLine.trim())
    }
  }
  const preamble = preambleLines.join('\n').trim()
  return { preamble, sections, hasStructure: sections.length > 0 }
}

/** The section's body as a single line (for one-line fields); '' if absent. */
export function oneLine(section: TextSection | null | undefined): string {
  if (!section) return ''
  return section.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
}

/** The section's non-empty lines (each prose line is one paragraph). */
export function sectionLines(section: TextSection | null | undefined): string[] {
  if (!section) return []
  return section.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * Extract the numeric evaluation (in pawns) from the EVALUATION section,
 * returned in the DISPLAY sign: positive = white's advantage, negative =
 * black's advantage.
 *
 * Two source conventions, both ending white-positive:
 * - A number the engine itself signed ("+0.20 pawns", "down -1.35",
 *   typographic "−" counts) is ABSOLUTE — already from white's
 *   perspective — and is passed through unconverted for either side to
 *   move. It takes precedence over the wording.
 * - An unsigned number relies on the polarity wording, which QUEEN writes
 *   relative to the PLAYER (the side to move): "the player is up …
 *   pawns", "the player is losing by … pawns" (framing it via "the
 *   opponent" inverts). For black-to-move positions the player-relative
 *   sign is flipped to white-positive.
 *
 * Null when the magnitude exceeds 10 (mate territory) or when both the
 * sign and the wording are unresolvable — no eval is better than a wrong
 * sign.
 */
export function parseEvaluation(text: string, sideToMove: Side): number | null {
  const { sections } = parseAnalysisText(text)
  const ev = sections.find((s) => s.key === 'EVALUATION')
  const body = ev ? ev.body.toLowerCase() : ''
  if (!body) return null

  let magnitude: number | null = null
  let playerSign: 1 | -1 | 0 = 0 // 0 = sign not yet known

  // Preferred: a number tied to a pawns-ish reading, e.g. "approximately
  // 5.36 pawns", a material deficit of 1.5 pawns"; optional engine sign.
  const pawnNum = body.match(/(?:([+\u2212-])\s*)?(\d+(?:\.\d+)?)\s*(?:[a-z]+\s+){0,4}?pawns?\b/)
  if (pawnNum) {
    magnitude = Number(pawnNum[2])
    if (pawnNum[1]) playerSign = pawnNum[1] === '-' || pawnNum[1] === '\u2212' ? -1 : 1
  } else {
    // Otherwise an explicitly signed number anywhere: "down -1.35".
    const signed = body.match(/([+\u2212-])\s*(\d+(?:\.\d+)?)/)
    if (signed) {
      magnitude = Number(signed[2])
      playerSign = signed[1] === '-' || signed[1] === '\u2212' ? -1 : 1
    }
  }
  if (magnitude === null) {
    // Zero: "0.00", "0.0", "0" — no sign needed.
    if (/(^|\s)0(?:\.0+)?(?![.\d])/.test(body)) return 0
    return null
  }
  if (magnitude > 10) return null // sanity: beyond ±10 this is not a pawn eval
  if (magnitude === 0) return 0

  // An explicitly signed number is absolute (white-positive) — pass it
  // through. Only an unsigned number reads its sign from the wording.
  if (playerSign === 0) {
    // Read the polarity wording. Prefer the sentence that carries the
    // number, then fall back to the whole body.
    const sentences = body.split(/(?<=[.!?])\s+/)
    const numSentence = sentences.find((s) => s.includes(String(magnitude)))
    playerSign = (numSentence && playerPolarity(numSentence)) || playerPolarity(body)
    if (playerSign === 0) return null
    // Player (side to move) POV -> white-positive display sign: a number
    // that is +5.36 for a black-to-move player is -5.36 from white's
    // perspective.
    return sideToMove === 'white' ? playerSign * magnitude : -playerSign * magnitude
  }
  return playerSign * magnitude
}

/** Words meaning the subject in scope holds the advantage. */
const UP_CORE = /\b(?:up|winning|ahead|leading|commanding|dominating|on\s+top)\b/
/** Words meaning the subject in scope is losing. */
const DOWN_CORE =
  /\b(?:down|losing|behind|trailing|outnumbered|outmatched|overwhelmed|suffering|conceding|deficit|disadvantag\w*|under\s+pressure)\b/
/** "<verb> … advantage/edge/superiority" (subject holds the advantage). */
const HAS_ADV =
  /\b(?:holds?|retains?|keeps?|enjoys?|maintains?|has|gains?|shows?|carries)\b[^.!?]{0,40}?\b(?:an?\s+)?\w*(?:\s+\w*){0,2}?\b(?:advantage|edge|superiority)\b/

/**
 * Which side does the wording favor? +1 = the player (side to move) holds
 * the advantage, -1 = the player is losing, 0 = undetermined.
 * "the player" is the default subject; clauses whose subject is "the
 * opponent" are scored separately and inverted.
 */
function playerPolarity(text: string): 1 | -1 | 0 {
  const oppClauses = text.match(/\bopponent[s]?\b[^.!?]*/g) ?? []
  const playerText = text.replace(/\bopponent[s]?\b[^.!?]*/g, ' ')
  const scoreScope = (t: string, isOpponent: boolean): number => {
    const flip = isOpponent ? -1 : 1
    let s = 0
    if (UP_CORE.test(t)) s += flip
    if (HAS_ADV.test(t)) s += flip
    if (DOWN_CORE.test(t)) s -= flip
    const bw = t.match(/\b(better|worse)\b/)
    if (bw) {
      const sign = bw[1] === 'better' ? 1 : -1
      if (/\bfor\s+(?:the\s+)?opponent\b/.test(t)) s += isOpponent ? sign : -sign
      else if (/\bfor\s+(?:the\s+)?player\b/.test(t)) s += isOpponent ? -sign : sign
      else s += sign * flip // default subject is the player
    }
    return s
  }
  const p = scoreScope(playerText, false) + scoreScope(oppClauses.join(' '), true)
  return p > 0 ? 1 : p < 0 ? -1 : 0
}

/** Signed, one-decimal display form: +0.2 / -1.3 / 0.0. */
export function formatEval(v: number): string {
  const r = Math.round(v * 10) / 10
  const a = Math.abs(r).toFixed(1)
  return r > 0 ? `+${a}` : r < 0 ? `-${a}` : a
}
