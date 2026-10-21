import { describe, expect, it } from 'vitest'
import { initialFen, makeMove } from './chessRules'
import {
  addMove,
  childWithUci,
  createTree,
  deleteBranch,
  depthOf,
  node,
  pathNodeIds,
  pathTo,
} from './tree'

const START = initialFen()

// Play e4 / e5 / Nf3 from the real position, returning the exact FEN and a
// UCI, so the tests exercise real FEN strings instead of placeholders.
function line() {
  const e4 = makeMove(START, 'e2', 'e4')
  const e5 = makeMove(e4.fen, 'e7', 'e5')
  const nf3 = makeMove(e5.fen, 'g1', 'f3')
  return { e4, e5, nf3 }
}

// A small 1.e4 1...e5 2.Nf3 tree, built through the same API the app uses.
function buildTree() {
  const { e4, e5, nf3 } = line()
  let tree = createTree(START)
  const a = addMove(tree, 0, { san: e4.san, uci: 'e2e4', fen: e4.fen })
  tree = a.tree
  const b = addMove(tree, a.id, { san: e5.san, uci: 'e7e5', fen: e5.fen })
  tree = b.tree
  const c = addMove(tree, b.id, { san: nf3.san, uci: 'g1f3', fen: nf3.fen })
  tree = c.tree
  return { tree, e4, e5, nf3, e4Id: a.id, e5Id: b.id, nf3Id: c.id }
}

describe('createTree', () => {
  it('has one root node holding the starting FEN', () => {
    const tree = createTree(START)
    expect(tree.rootId).toBe(0)
    const root = node(tree, 0)
    expect(root).toEqual({ id: 0, parentId: null, san: '', uci: '', fen: START, children: [] })
    expect(pathTo(tree, 0)).toEqual([])
  })
})

describe('add move', () => {
  it('adds a child under the parent with san/uci/fen', () => {
    const { e4 } = line()
    const { tree, id } = addMove(createTree(START), 0, { san: e4.san, uci: 'e2e4', fen: e4.fen })
    expect(id).toBe(1)
    const n = node(tree, id)
    expect(n.parentId).toBe(0)
    expect(n.san).toBe('e4')
    expect(n.uci).toBe('e2e4')
    expect(n.fen).toBe(e4.fen)
    expect(node(tree, 0).children).toEqual([id])
    expect(depthOf(tree, id)).toBe(1)
  })

  it('does not mutate the original tree', () => {
    const { e4 } = line()
    const before = createTree(START)
    addMove(before, 0, { san: e4.san, uci: 'e2e4', fen: e4.fen })
    expect(node(before, 0).children).toEqual([])
    expect(Object.keys(before.nodes)).toEqual(['0'])
  })
})

describe('branch', () => {
  it('playing a different move at a past node keeps the old branch', () => {
    const { e4 } = line()
    const c4 = makeMove(START, 'c2', 'c4')
    let tree = createTree(START)
    const a = addMove(tree, 0, { san: e4.san, uci: 'e2e4', fen: e4.fen })
    tree = a.tree
    const b = addMove(tree, 0, { san: c4.san, uci: 'c2c4', fen: c4.fen })
    tree = b.tree
    // both variations coexist under the root
    expect(node(tree, 0).children).toEqual([a.id, b.id])
    expect(node(tree, a.id).fen).toBe(e4.fen)
    expect(node(tree, b.id).fen).toBe(c4.fen)
    expect(node(tree, b.id).children).toEqual([])
  })

  it('playing a move that already exists navigates (no duplicate child)', () => {
    const built = buildTree()
    expect(childWithUci(built.tree, 0, 'e2e4')).toBe(built.e4Id)
    expect(childWithUci(built.tree, 0, 'd2d4')).toBeNull()
  })

  it('a branch grown deeper keeps both lines intact', () => {
    const { e4 } = line()
    const c4 = makeMove(START, 'c2', 'c4')
    const e4e5 = makeMove(e4.fen, 'e7', 'e5')
    let tree = createTree(START)
    const a = addMove(tree, 0, { san: e4.san, uci: 'e2e4', fen: e4.fen })
    tree = a.tree
    const a2 = addMove(tree, a.id, { san: e4e5.san, uci: 'e7e5', fen: e4e5.fen })
    tree = a2.tree
    const b = addMove(tree, 0, { san: c4.san, uci: 'c2c4', fen: c4.fen })
    tree = b.tree
    expect(node(tree, 0).children).toEqual([a.id, b.id])
    expect(node(tree, a.id).children).toEqual([a2.id])
    expect(depthOf(tree, a2.id)).toBe(2)
  })
})

describe('navigate', () => {
  it('finds parents and depths along the path', () => {
    const built = buildTree()
    expect(node(built.tree, built.e4Id).parentId).toBe(0)
    expect(node(built.tree, built.e5Id).parentId).toBe(built.e4Id)
    expect(node(built.tree, built.nf3Id).parentId).toBe(built.e5Id)
    expect(depthOf(built.tree, built.nf3Id)).toBe(3)
    expect(pathNodeIds(built.tree, built.nf3Id)).toEqual([built.e4Id, built.e5Id, built.nf3Id])
    expect(pathNodeIds(built.tree, 0)).toEqual([])
  })
})

describe('pathTo', () => {
  it('returns the FENs from the root to the parent, excluding the current node', () => {
    const built = buildTree()
    expect(pathTo(built.tree, built.e4Id)).toEqual([START])
    expect(pathTo(built.tree, built.e5Id)).toEqual([START, built.e4.fen])
    expect(pathTo(built.tree, built.nf3Id)).toEqual([START, built.e4.fen, built.e5.fen])
    // the current node's own FEN is never part of its history
    for (const id of [built.e4Id, built.e5Id, built.nf3Id]) {
      expect(pathTo(built.tree, id)).not.toContain(node(built.tree, id).fen)
      expect(pathTo(built.tree, id)).toHaveLength(depthOf(built.tree, id))
    }
  })

  it('follows the branch that was taken, not a sibling branch', () => {
    const { e4 } = line()
    const c4 = makeMove(START, 'c2', 'c4')
    const e5b = makeMove(c4.fen, 'e7', 'e5')
    const c4nf3 = makeMove(e5b.fen, 'g1', 'f3')
    let tree = createTree(START)
    const a = addMove(tree, 0, { san: e4.san, uci: 'e2e4', fen: e4.fen })
    tree = a.tree
    const b = addMove(tree, 0, { san: c4.san, uci: 'c2c4', fen: c4.fen })
    tree = b.tree
    const b2 = addMove(tree, b.id, { san: e5b.san, uci: 'e7e5', fen: e5b.fen })
    tree = b2.tree
    const c = addMove(tree, b2.id, { san: c4nf3.san, uci: 'g1f3', fen: c4nf3.fen })
    tree = c.tree
    // 1.c4 e5 Nf3 history must be start + c4 + e5 positions, NOT the e4 line
    expect(pathTo(tree, c.id)).toEqual([START, c4.fen, e5b.fen])
    expect(pathTo(tree, c.id)).not.toContain(e4.fen)
  })
})

describe('deleteBranch', () => {
  it('removes the node and its descendants, keeping sibling branches', () => {
    const built = buildTree()
    const after = deleteBranch(built.tree, built.e4Id)
    expect(node(after, 0).children).toEqual([])
    expect(after.nodes[built.e4Id]).toBeUndefined()
    expect(after.nodes[built.e5Id]).toBeUndefined()
    expect(after.nodes[built.nf3Id]).toBeUndefined()
    // original tree untouched
    expect(node(built.tree, 0).children).toEqual([built.e4Id])
  })

  it('keeps other variations of the parent', () => {
    const { e4 } = line()
    const c4 = makeMove(START, 'c2', 'c4')
    let tree = createTree(START)
    const a = addMove(tree, 0, { san: e4.san, uci: 'e2e4', fen: e4.fen })
    tree = a.tree
    const b = addMove(tree, 0, { san: c4.san, uci: 'c2c4', fen: c4.fen })
    tree = b.tree
    const after = deleteBranch(tree, a.id)
    expect(node(after, 0).children).toEqual([b.id])
    expect(node(after, b.id).fen).toBe(c4.fen)
  })

  it('refuses to delete the root and throws for unknown ids', () => {
    const built = buildTree()
    expect(() => deleteBranch(built.tree, 0)).toThrowError(/root/)
    expect(() => deleteBranch(built.tree, 999)).toThrowError()
  })
})
