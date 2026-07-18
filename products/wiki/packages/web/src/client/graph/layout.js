import { graphDegree, hashNumber } from "./utils.js";

function layoutNodes(graph, focusId, previousPositions = new Map()) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const degree = graphDegree(edges);
  return nodes
    .slice()
    .sort((left, right) => (degree.get(right.id) || 0) - (degree.get(left.id) || 0) || String(left.title).localeCompare(String(right.title)))
    .map((node, index, sorted) => {
      const previous = previousPositions.get(node.id);
      if (previous) {
        return { ...node, x: previous.x, y: previous.y, degree: degree.get(node.id) || 0 };
      }
      const seed = hashNumber(node.id || String(index));
      const angle = (seed % 6283) / 1000;
      const ring = Math.floor(index / Math.max(8, Math.ceil(Math.sqrt(sorted.length || 1))));
      const radius = node.id === focusId ? 0 : 80 + ring * 54 + (seed % 31);
      return { ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, degree: degree.get(node.id) || 0 };
    });
}

function scheduleGraphLayout(state, render) {
  const runId = state.layoutRun + 1;
  state.layoutRun = runId;
  state.layoutWorker?.terminate?.();
  revokeGraphLayoutWorkerUrl(state);
  state.layoutWorker = undefined;
  if (state.nodes.length <= 1) {
    render();
    return;
  }
  let worker;
  try {
    state.layoutWorkerUrl = URL.createObjectURL(new Blob([graphLayoutWorkerSource()], { type: "text/javascript" }));
    worker = new Worker(state.layoutWorkerUrl);
  } catch {
    revokeGraphLayoutWorkerUrl(state);
    render();
    return;
  }
  state.layoutWorker = worker;
  worker.onmessage = (event) => {
    if (runId !== state.layoutRun) return;
    const positions = event.data?.nodes;
    if (Array.isArray(positions)) {
      const byId = new Map(positions.map((node) => [node.id, node]));
      state.nodes = state.nodes.map((node) => {
        const positioned = byId.get(node.id);
        return positioned ? { ...node, x: positioned.x, y: positioned.y } : node;
      });
      render();
    }
    if (event.data?.final) {
      worker.terminate();
      if (state.layoutWorker === worker) {
        state.layoutWorker = undefined;
        revokeGraphLayoutWorkerUrl(state);
      }
    }
  };
  worker.onerror = () => {
    worker.terminate();
    if (state.layoutWorker === worker) {
      state.layoutWorker = undefined;
      revokeGraphLayoutWorkerUrl(state);
    }
    render();
  };
  worker.postMessage({
    nodes: state.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, degree: node.degree || 0, pinned: state.pinnedNodeIds.has(node.id) })),
    edges: state.edges.map((edge) => ({ from_id: edge.from_id, to_id: edge.to_id, weight: edge.weight || 1 })),
    focusId: state.focusId,
    reducedMotion: state.reducedMotion,
    iterations: graphLayoutIterations(state.nodes.length, state.reducedMotion),
  });
}

function revokeGraphLayoutWorkerUrl(state) {
  if (state.layoutWorkerUrl) {
    URL.revokeObjectURL(state.layoutWorkerUrl);
    state.layoutWorkerUrl = undefined;
  }
}

function graphLayoutIterations(nodeCount, reducedMotion) {
  if (reducedMotion) return nodeCount > 600 ? 80 : 140;
  if (nodeCount > 1000) return 120;
  if (nodeCount > 500) return 160;
  return 240;
}

function graphLayoutWorkerSource() {
  return `
self.onmessage = function(event) {
  var data = event.data || {};
  var nodes = (data.nodes || []).map(function(node) {
    return { id: node.id, x: Number(node.x) || 0, y: Number(node.y) || 0, vx: 0, vy: 0, degree: Number(node.degree) || 0, pinned: node.pinned === true };
  });
  var byId = new Map(nodes.map(function(node) { return [node.id, node]; }));
  var edges = (data.edges || []).map(function(edge) {
    return { from: byId.get(edge.from_id), to: byId.get(edge.to_id), weight: Math.max(1, Number(edge.weight) || 1) };
  }).filter(function(edge) { return edge.from && edge.to; });
  var iterations = Math.max(1, Number(data.iterations) || 220);
  var reduced = data.reducedMotion === true;
  var cellSize = nodes.length > 900 ? 128 : 96;
  for (var tick = 0; tick < iterations; tick += 1) {
    var alpha = 1 - tick / iterations;
    var cells = new Map();
    for (var i = 0; i < nodes.length; i += 1) {
      var nodeForCell = nodes[i];
      var cellX = Math.floor(nodeForCell.x / cellSize);
      var cellY = Math.floor(nodeForCell.y / cellSize);
      var key = cellX + ":" + cellY;
      var bucket = cells.get(key);
      if (!bucket) {
        bucket = [];
        cells.set(key, bucket);
      }
      bucket.push(nodeForCell);
    }
    for (var i = 0; i < nodes.length; i += 1) {
      var left = nodes[i];
      var baseX = Math.floor(left.x / cellSize);
      var baseY = Math.floor(left.y / cellSize);
      for (var gx = baseX - 1; gx <= baseX + 1; gx += 1) {
        for (var gy = baseY - 1; gy <= baseY + 1; gy += 1) {
          var nearby = cells.get(gx + ":" + gy);
          if (!nearby) continue;
          for (var j = 0; j < nearby.length; j += 1) {
            var right = nearby[j];
            if (right === left) continue;
            var dx = right.x - left.x || 0.01;
            var dy = right.y - left.y || 0.01;
        var distSq = Math.max(36, dx * dx + dy * dy);
        var dist = Math.sqrt(distSq);
            var strength = (34 + (left.degree + right.degree) * 1.5) * alpha / distSq;
        var fx = dx / dist * strength;
        var fy = dy / dist * strength;
        left.vx -= fx;
        left.vy -= fy;
          }
        }
      }
    }
    for (var e = 0; e < edges.length; e += 1) {
      var edge = edges[e];
      var sx = edge.to.x - edge.from.x || 0.01;
      var sy = edge.to.y - edge.from.y || 0.01;
      var sdist = Math.max(1, Math.sqrt(sx * sx + sy * sy));
      var desired = Math.max(70, 128 - Math.min(edge.weight, 8) * 7);
      var pull = (sdist - desired) * 0.012 * alpha;
      var px = sx / sdist * pull;
      var py = sy / sdist * pull;
      edge.from.vx += px;
      edge.from.vy += py;
      edge.to.vx -= px;
      edge.to.vy -= py;
    }
    for (var n = 0; n < nodes.length; n += 1) {
      var node = nodes[n];
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      var centerStrength = node.id === data.focusId ? 0.045 : 0.009;
      node.vx += -node.x * centerStrength * alpha;
      node.vy += -node.y * centerStrength * alpha;
      node.vx *= 0.84;
      node.vy *= 0.84;
      node.x += node.vx;
      node.y += node.vy;
    }
    if (!reduced && tick % 35 === 0) {
      self.postMessage({ final: false, nodes: nodes.map(function(node) { return { id: node.id, x: node.x, y: node.y }; }) });
    }
  }
  self.postMessage({ final: true, nodes: nodes.map(function(node) { return { id: node.id, x: node.x, y: node.y }; }) });
};`;
}

export { layoutNodes, scheduleGraphLayout };
