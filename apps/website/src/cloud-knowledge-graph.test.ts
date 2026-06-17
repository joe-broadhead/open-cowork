import test from 'node:test'
import assert from 'node:assert/strict'
import { computeKnowledgeGraphLayout, type KnowledgeGraph } from '@open-cowork/shared'

// The knowledge-graph layout is the shared, pure heart of the graph surface that
// both the desktop renderer and Cloud Web draw. Testing it here pins the
// clustering/tiering contract without needing a DOM.

function sampleGraph(): KnowledgeGraph {
  return {
    nodes: [
      { id: 'root', kind: 'root', label: 'Company OS' },
      { id: 's1', kind: 'space', label: 'People', spaceId: 's1' },
      { id: 's2', kind: 'space', label: 'Engineering', spaceId: 's2' },
      { id: 'p1', kind: 'page', label: 'Leave policy', spaceId: 's1' },
      { id: 'p2', kind: 'page', label: 'Onboarding', spaceId: 's1' },
      { id: 'p3', kind: 'page', label: 'Runbook', spaceId: 's2' },
    ],
    edges: [
      { id: 'e1', source: 'root', target: 's1', kind: 'contains' },
      { id: 'e2', source: 'root', target: 's2', kind: 'contains' },
      { id: 'e3', source: 's1', target: 'p1', kind: 'contains' },
      { id: 'e4', source: 's1', target: 'p2', kind: 'contains' },
      { id: 'e5', source: 's2', target: 'p3', kind: 'contains' },
      { id: 'e6', source: 'p1', target: 'p3', kind: 'links' },
    ],
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

void test('knowledge graph layout centres the root and tiers node radii by kind', () => {
  const layout = computeKnowledgeGraphLayout(sampleGraph())
  const root = layout.nodes.find((node) => node.kind === 'root')
  assert.ok(root)
  assert.equal(root.x, layout.width / 2)
  assert.equal(root.y, layout.height / 2)
  assert.equal(root.r, 22)
  assert.ok(layout.nodes.filter((node) => node.kind === 'space').every((node) => node.r === 14))
  assert.ok(layout.nodes.filter((node) => node.kind === 'page').every((node) => node.r === 8))
})

void test('knowledge graph layout preserves every edge and exposes page ids only on pages', () => {
  const graph = sampleGraph()
  const layout = computeKnowledgeGraphLayout(graph)
  assert.equal(layout.edges.length, graph.edges.length)
  assert.equal(layout.spaceCount, 2)
  assert.equal(layout.nodes.length, graph.nodes.length)
  const page = layout.nodes.find((node) => node.id === 'p1')
  assert.equal(page?.pageId, 'p1')
  assert.equal(layout.nodes.find((node) => node.kind === 'root')?.pageId, null)
  assert.equal(layout.nodes.find((node) => node.kind === 'space')?.pageId, null)
})

void test('knowledge graph layout clusters pages nearer their own space', () => {
  const layout = computeKnowledgeGraphLayout(sampleGraph())
  const byId = new Map(layout.nodes.map((node) => [node.id, node]))
  const p1 = byId.get('p1')
  const s1 = byId.get('s1')
  const s2 = byId.get('s2')
  assert.ok(p1 && s1 && s2)
  assert.ok(distance(p1, s1) < distance(p1, s2), 'a page should sit closer to its own space')
  assert.equal(p1.spaceIndex, s1.spaceIndex)
})
