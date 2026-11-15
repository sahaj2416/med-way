const { haversineDistance, MAX_SPEED_MS, DEFAULT_SPEED_KMH } = require('./Graph');

function haversineKm(lat1, lon1, lat2, lon2) {
  return haversineDistance(lat1, lon1, lat2, lon2) / 1000;
}

class PriorityQueue {
  constructor() {
    this.heap = [];
  }

  push(item, priority) {
    this.heap.push({ item, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) {
      return null;
    }
    const top = this.heap[0];
    const bottom = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.bubbleDown(0);
    }
    return top.item;
  }

  isEmpty() {
    return this.heap.length === 0;
  }

  bubbleUp(index) {
    let idx = index;
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.heap[idx].priority >= this.heap[parentIdx].priority) {
        break;
      }
      const temp = this.heap[idx];
      this.heap[idx] = this.heap[parentIdx];
      this.heap[parentIdx] = temp;
      idx = parentIdx;
    }
  }

  bubbleDown(index) {
    let idx = index;
    const length = this.heap.length;
    while (true) {
      let smallest = idx;
      const leftChild = 2 * idx + 1;
      const rightChild = 2 * idx + 2;

      if (leftChild < length && this.heap[leftChild].priority < this.heap[smallest].priority) {
        smallest = leftChild;
      }
      if (rightChild < length && this.heap[rightChild].priority < this.heap[smallest].priority) {
        smallest = rightChild;
      }
      if (smallest === idx) {
        break;
      }
      const temp = this.heap[idx];
      this.heap[idx] = this.heap[smallest];
      this.heap[smallest] = temp;
      idx = smallest;
    }
  }
}

/**
 * Admissible travel-time heuristic in seconds.
 * Assumes theoretical maximum speed (80 km/h) along straight-line Haversine distance.
 */
function travelTimeHeuristicSeconds(lat1, lon1, lat2, lon2) {
  const distMeters = haversineDistance(lat1, lon1, lat2, lon2);
  return distMeters / MAX_SPEED_MS;
}

/**
 * High-performance In-Memory LRU Route Cache.
 * Caches calculated A* routes for recurring corridor trips (e.g. ambulance stations,
 * repeat patient scenes, and regional hospital entrances).
 */
class LRURouteCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.misses++;
      return null;
    }
    this.hits++;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRatio: total > 0 ? Math.round((this.hits / total) * 1000) / 1000 : 0
    };
  }
}

const routeCache = new LRURouteCache(1000);

/**
 * Fastest-path A* search minimizing travel time while adhering to one-way directionality.
 */
function aStar(graph, startNodeId, targetNodeId) {
  const startId = String(startNodeId);
  const targetId = String(targetNodeId);

  const startNode = graph.getNode(startId);
  const targetNode = graph.getNode(targetId);

  if (!startNode || !targetNode) {
    return {
      coordinates: [],
      path: [],
      distanceKm: 0,
      totalDistanceKm: 0,
      durationSeconds: 0,
      durationMinutes: 0
    };
  }

  if (startId === targetId) {
    const coords = [[startNode.lat, startNode.lon]];
    return {
      coordinates: coords,
      path: coords,
      distanceKm: 0,
      totalDistanceKm: 0,
      durationSeconds: 0,
      durationMinutes: 0
    };
  }

  // 1. In-Memory LRU Route Cache Check (< 0.05ms lookup)
  const cacheKey = `${startId}->${targetId}`;
  const cachedRoute = routeCache.get(cacheKey);
  if (cachedRoute) {
    const coordsCopy = cachedRoute.coordinates.map(pt => [pt[0], pt[1]]);
    return {
      coordinates: coordsCopy,
      path: coordsCopy,
      distanceKm: cachedRoute.distanceKm,
      totalDistanceKm: cachedRoute.totalDistanceKm,
      durationSeconds: cachedRoute.durationSeconds,
      durationMinutes: cachedRoute.durationMinutes,
      fromCache: true
    };
  }

  // O(1) Disconnected Component Guard:
  // If both nodes have been component-indexed and belong to different subgraphs,
  // there is no valid path. Terminate immediately without searching 200,000+ nodes.
  if (
    startNode.componentId !== null &&
    startNode.componentId !== undefined &&
    targetNode.componentId !== null &&
    targetNode.componentId !== undefined &&
    startNode.componentId !== targetNode.componentId
  ) {
    return {
      coordinates: [],
      path: [],
      distanceKm: 0,
      totalDistanceKm: 0,
      durationSeconds: 0,
      durationMinutes: 0,
      unreachable: true
    };
  }

  const pq = new PriorityQueue();
  const gScore = new Map();
  const cameFrom = new Map();
  const visited = new Set();

  gScore.set(startId, 0);
  const initialH = travelTimeHeuristicSeconds(startNode.lat, startNode.lon, targetNode.lat, targetNode.lon);
  pq.push(startId, initialH);

  let expansions = 0;
  const MAX_EXPANSIONS = 60000;

  while (!pq.isEmpty()) {
    if (++expansions > MAX_EXPANSIONS) {
      break;
    }

    const currentId = pq.pop();

    if (currentId === targetId) {
      break;
    }

    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const currentNode = graph.getNode(currentId);
    if (!currentNode) {
      continue;
    }

    const currentG = gScore.get(currentId);
    const neighbors = graph.getNeighbors(currentId);

    for (let i = 0; i < neighbors.length; i++) {
      const edge = neighbors[i];
      const neighborId = String(edge.to);

      if (visited.has(neighborId)) {
        continue;
      }

      const neighborNode = graph.getNode(neighborId);
      if (!neighborNode) {
        continue;
      }

      const edgeDurationSec = (typeof edge.weight === 'number' && edge.weight > 0)
        ? edge.weight
        : (haversineDistance(currentNode.lat, currentNode.lon, neighborNode.lat, neighborNode.lon) / (DEFAULT_SPEED_KMH / 3.6));

      const tentativeG = currentG + edgeDurationSec;

      const recordedG = gScore.get(neighborId);
      if (recordedG === undefined || tentativeG < recordedG) {
        cameFrom.set(neighborId, { prevId: currentId, edge });
        gScore.set(neighborId, tentativeG);
        const h = travelTimeHeuristicSeconds(neighborNode.lat, neighborNode.lon, targetNode.lat, targetNode.lon);
        const fScore = tentativeG + h;
        pq.push(neighborId, fScore);
      }
    }
  }

  if (!cameFrom.has(targetId)) {
    return {
      coordinates: [],
      path: [],
      distanceKm: 0,
      totalDistanceKm: 0,
      durationSeconds: 0,
      durationMinutes: 0
    };
  }

  const coordinates = [];
  let totalDistanceMeters = 0;
  let curr = targetId;

  while (curr) {
    const node = graph.getNode(curr);
    if (node) {
      coordinates.push([node.lat, node.lon]);
    }
    if (curr === startId) {
      break;
    }

    const step = cameFrom.get(curr);
    if (!step) {
      break;
    }

    if (step.edge && step.edge.distanceMeters) {
      totalDistanceMeters += step.edge.distanceMeters;
    } else if (step.prevId) {
      const prevNode = graph.getNode(step.prevId);
      if (prevNode && node) {
        totalDistanceMeters += haversineDistance(prevNode.lat, prevNode.lon, node.lat, node.lon);
      }
    }

    curr = step.prevId;
  }

  coordinates.reverse();

  const totalDistanceKm = Math.round((totalDistanceMeters / 1000) * 100) / 100;
  const durationSeconds = Math.round(gScore.get(targetId) || 0);
  const durationMinutes = Math.round((durationSeconds / 60) * 10) / 10;

  const routeResult = {
    coordinates,
    path: coordinates,
    distanceKm: totalDistanceKm,
    totalDistanceKm,
    durationSeconds,
    durationMinutes
  };

  // Cache computed route in LRU Route Cache
  routeCache.set(cacheKey, routeResult);

  const coordsCopy = routeResult.coordinates.map(pt => [pt[0], pt[1]]);
  return {
    ...routeResult,
    coordinates: coordsCopy,
    path: coordsCopy
  };
}

function calculateETA(distanceKm, priority, routeDurationMinutes = null) {
  if (routeDurationMinutes && routeDurationMinutes > 0) {
    if (priority === 'Critical') {
      return Math.max(1, Math.round(routeDurationMinutes * 0.85 * 10) / 10);
    }
    return Math.max(1, Math.round(routeDurationMinutes * 10) / 10);
  }

  const speeds = {
    Critical: 46,
    High: 34,
    Moderate: 28
  };

  const speed = speeds[priority] || speeds.High;
  if (!distanceKm || distanceKm <= 0) {
    return 0;
  }

  const minutes = (distanceKm / speed) * 60;
  return Math.round(minutes * 10) / 10;
}

module.exports = {
  aStar,
  findShortestPath: aStar,
  calculateETA,
  haversineKm,
  travelTimeHeuristicSeconds,
  routeCache,
  getRouteCacheStats: () => routeCache.getStats(),
  clearRouteCache: () => routeCache.clear()
};
