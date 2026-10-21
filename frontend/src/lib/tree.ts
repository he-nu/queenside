// The variation tree (SPEC feature 3).
//
// A pure data structure over moves: nodes carry the FEN / SAN / UCI produced
// elsewhere (the chess-rules wrapper) and the tree itself knows nothing of
// chess rules — it does not import the rules library (architecture rule,
// AGENTS.md).
//
// The root is a real node (id 0) holding the starting position. Playing a
// move that already exists under the current node navigates to it; playing a
// different move adds a NEW sibling, so variations coexist. All functions are
// immutable: they return new trees and never mutate the input.

export type TreeNode = {
  id: number
  parentId: number | null
  san: string
  /** UCI including the promotion letter, e.g. `e7e8q`; '' on the root. */
  uci: string
  /** FEN of the position AFTER this node's move (root: starting position). */
  fen: string
  children: number[]
}

export type Tree = {
  rootId: number
  nodes: Record<number, TreeNode>
  nextId: number
}

export type TreeMove = {
  san: string
  uci: string
  fen: string
}

/** A fresh tree whose root is the position `rootFen`. */
export function createTree(rootFen: string): Tree {
  const root: TreeNode = { id: 0, parentId: null, san: '', uci: '', fen: rootFen, children: [] }
  return { rootId: 0, nodes: { 0: root }, nextId: 1 }
}

export function node(tree: Tree, id: number): TreeNode {
  const n = tree.nodes[id]
  if (!n) throw new Error(`No tree node ${id}`)
  return n
}

export function parentOf(tree: Tree, id: number): number | null {
  return node(tree, id).parentId
}

export function childrenOf(tree: Tree, id: number): number[] {
  return node(tree, id).children
}

/** Number of moves from the root to `id` (root has depth 0). */
export function depthOf(tree: Tree, id: number): number {
  return pathNodeIds(tree, id).length
}

/**
 * The id of a child of `nodeId` whose UCI is `uci`, or null. A same parent +
 * same legal move always reaches the same position, so an existing child with
 * the same UCI is the continuation of the same line (no duplicate needed).
 */
export function childWithUci(tree: Tree, nodeId: number, uci: string): number | null {
  return node(tree, nodeId).children.find((c) => node(tree, c).uci === uci) ?? null
}

/**
 * Add one move as a child of `parentId`. Never mutates `tree`.
 * Playing a different move at a position that already has children is how a
 * branch is created: the old children (other variations) are kept.
 */
export function addMove(tree: Tree, parentId: number, move: TreeMove): { tree: Tree; id: number } {
  const id = tree.nextId
  const child: TreeNode = {
    id,
    parentId,
    san: move.san,
    uci: move.uci,
    fen: move.fen,
    children: [],
  }
  const parent = node(tree, parentId)
  return {
    id,
    tree: {
      rootId: tree.rootId,
      nextId: id + 1,
      nodes: {
        ...tree.nodes,
        [id]: child,
        [parentId]: { ...parent, children: [...parent.children, id] },
      },
    },
  }
}

/**
 * FEN list used as the `history` for the node: every position from the root
 * up to (and including) the node's parent, oldest first. Excludes the node's
 * own FEN (that is the position being analyzed). Root -> [].
 */
export function pathTo(tree: Tree, nodeId: number): string[] {
  const out: string[] = []
  let cur = node(tree, nodeId)
  while (cur.parentId !== null) {
    cur = node(tree, cur.parentId)
    out.push(cur.fen)
  }
  return out.reverse()
}

/**
 * Node ids on the root -> nodeId path, oldest first; excludes the root itself
 * and includes `nodeId`. Root -> [].
 */
export function pathNodeIds(tree: Tree, nodeId: number): number[] {
  const out: number[] = []
  let cur = node(tree, nodeId)
  while (cur.parentId !== null) {
    out.push(cur.id)
    cur = node(tree, cur.parentId)
  }
  return out.reverse()
}

/**
 * Delete the branch rooted at `nodeId` (the node and every descendant).
 * Other variations of its parent are untouched. Throws for the root and for
 * ids that are not in the tree. Never mutates `tree`.
 */
export function deleteBranch(tree: Tree, nodeId: number): Tree {
  if (nodeId === tree.rootId) throw new Error('Cannot delete the root node')
  const victim = node(tree, nodeId)
  const subtree: number[] = [nodeId]
  const stack = [...victim.children]
  while (stack.length > 0) {
    const id = stack.pop()!
    subtree.push(id)
    stack.push(...node(tree, id).children)
  }
  const nodes: Record<number, TreeNode> = { ...tree.nodes }
  for (const id of subtree) delete nodes[id]
  const parentId = victim.parentId!
  const parent = node(tree, parentId)
  nodes[parentId] = { ...parent, children: parent.children.filter((c) => c !== nodeId) }
  return { rootId: tree.rootId, nextId: tree.nextId, nodes }
}
