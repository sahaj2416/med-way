const ROAD_SPEEDS = {
  motorway: 80,
  motorway_link: 60,
  trunk: 80,
  trunk_link: 60,
  primary: 60,
  primary_link: 50,
  secondary: 50,
  secondary_link: 40,
  tertiary: 40,
  tertiary_link: 30,
  residential: 30,
  living_street: 20,
  unclassified: 30,
  service: 20
};
const DEFAULT_SPEED_KMH = 30;
const MAX_SPEED_KMH = 80;
const MAX_SPEED_MS = MAX_SPEED_KMH / 3.6; // ~22.222 m/s

class Edge {
  constructor(from, to, weight, roadType = 'residential', distanceMeters = null) {
    this.from = from;
    this.to = to;
    this.weight = weight; // Travel time in seconds
    this.roadType = roadType;
    this.distanceMeters = distanceMeters;
  }
}

class Node {
  constructor(id, lat, lon) {
    this.id = id;
    this.lat = lat;
    this.lon = lon;
    this.edges = [];
    this.componentId = null;
  }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const rLat1 = lat1 * (Math.PI / 180);
  const rLat2 = lat2 * (Math.PI / 180);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(rLat1) * Math.cos(rLat2) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computeEdgeTravelTime(fromNode, toNode, roadType = 'residential', explicitWeight = null) {
  const distanceMeters = haversineDistance(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon);
  if (explicitWeight !== undefined && explicitWeight !== null) {
    return { weight: explicitWeight, distanceMeters };
  }
  const speedKmh = ROAD_SPEEDS[roadType] || DEFAULT_SPEED_KMH;
  const speedMs = speedKmh / 3.6;
  const weight = distanceMeters / speedMs; // Travel time in seconds
  return { weight, distanceMeters };
}

class Graph {
  constructor() {
    this.nodes = new Map();
    this.roadNodes = new Set();
    this.hospitals = new Map();
    this.grid = new Map();
    this.gridCellSize = 0.01;
    this.undirectedAdjacency = new Map();
    this.componentSizes = new Map();
    this.mainComponentId = null;
  }

  addNode(id, lat, lon) {
    const node = new Node(id, lat, lon);
    this.nodes.set(id, node);
    return node;
  }

  getNode(id) {
    return this.nodes.get(id);
  }

  hasNode(id) {
    return this.nodes.has(id);
  }

  getGridKey(lat, lon) {
    const x = Math.floor(lat / this.gridCellSize);
    const y = Math.floor(lon / this.gridCellSize);
    return `${x}:${y}`;
  }

  registerRoadNode(node) {
    if (!this.roadNodes.has(node.id)) {
      this.roadNodes.add(node.id);
      const key = this.getGridKey(node.lat, node.lon);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(node);
    }
  }

  registerUndirectedAdjacency(fromId, toId) {
    let listFrom = this.undirectedAdjacency.get(fromId);
    if (!listFrom) {
      listFrom = [];
      this.undirectedAdjacency.set(fromId, listFrom);
    }
    listFrom.push(toId);

    let listTo = this.undirectedAdjacency.get(toId);
    if (!listTo) {
      listTo = [];
      this.undirectedAdjacency.set(toId, listTo);
    }
    listTo.push(fromId);
  }

  addDirectedEdge(fromId, toId, roadType = 'residential', explicitWeight = null) {
    const fromNode = this.nodes.get(fromId);
    const toNode = this.nodes.get(toId);
    if (!fromNode || !toNode) {
      return false;
    }

    const { weight, distanceMeters } = computeEdgeTravelTime(fromNode, toNode, roadType, explicitWeight);
    fromNode.edges.push(new Edge(fromId, toId, weight, roadType, distanceMeters));
    this.registerRoadNode(fromNode);
    this.registerRoadNode(toNode);
    this.registerUndirectedAdjacency(fromId, toId);
    return true;
  }

  addBidirectionalEdge(fromId, toId, roadType = 'residential', explicitWeight = null) {
    const fromNode = this.nodes.get(fromId);
    const toNode = this.nodes.get(toId);
    if (!fromNode || !toNode) {
      return false;
    }

    const { weight, distanceMeters } = computeEdgeTravelTime(fromNode, toNode, roadType, explicitWeight);
    fromNode.edges.push(new Edge(fromId, toId, weight, roadType, distanceMeters));
    toNode.edges.push(new Edge(toId, fromId, weight, roadType, distanceMeters));
    this.registerRoadNode(fromNode);
    this.registerRoadNode(toNode);
    this.registerUndirectedAdjacency(fromId, toId);
    return true;
  }

  addEdge(fromId, toId, weight, bidirectional = true, roadType = 'residential') {
    if (bidirectional) {
      return this.addBidirectionalEdge(fromId, toId, roadType, weight);
    }
    return this.addDirectedEdge(fromId, toId, roadType, weight);
  }

  getNeighbors(nodeId) {
    const node = this.nodes.get(nodeId);
    return node ? node.edges : [];
  }

  computeConnectedComponents() {
    this.componentSizes.clear();
    let currentComponentId = 1;

    for (const nodeId of this.roadNodes) {
      const node = this.nodes.get(nodeId);
      if (!node || node.componentId !== null) {
        continue;
      }

      let size = 0;
      const queue = [nodeId];
      node.componentId = currentComponentId;

      let head = 0;
      while (head < queue.length) {
        const currId = queue[head++];
        size++;

        const neighbors = this.undirectedAdjacency.get(currId);
        if (neighbors) {
          for (let i = 0; i < neighbors.length; i++) {
            const neighborId = neighbors[i];
            const neighborNode = this.nodes.get(neighborId);
            if (neighborNode && neighborNode.componentId === null) {
              neighborNode.componentId = currentComponentId;
              queue.push(neighborId);
            }
          }
        }
      }

      this.componentSizes.set(currentComponentId, size);
      currentComponentId++;
    }

    let maxId = null;
    let maxSize = 0;
    for (const [id, sz] of this.componentSizes.entries()) {
      if (sz > maxSize) {
        maxSize = sz;
        maxId = id;
      }
    }
    this.mainComponentId = maxId;
    // Release undirected adjacency map from RAM once component IDs are indexed
    this.undirectedAdjacency.clear();
    return this.componentSizes;
  }

  findNearestRoadNode(lat, lon, preferMainComponent = false) {
    if (this.roadNodes.size === 0) {
      return null;
    }

    const baseKeyX = Math.floor(lat / this.gridCellSize);
    const baseKeyY = Math.floor(lon / this.gridCellSize);

    const searchPass = (targetComponentId) => {
      let closestNodeId = null;
      let minDistance = Infinity;

      for (let r = 0; r <= 12; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) {
              continue;
            }
            const bucket = this.grid.get(`${baseKeyX + dx}:${baseKeyY + dy}`);
            if (bucket) {
              for (let i = 0; i < bucket.length; i++) {
                const node = bucket[i];
                if (targetComponentId && node.componentId !== targetComponentId) {
                  continue;
                }
                const dist = haversineDistance(lat, lon, node.lat, node.lon);
                if (dist < minDistance) {
                  minDistance = dist;
                  closestNodeId = node.id;
                }
              }
            }
          }
        }
        if (closestNodeId !== null && minDistance <= r * this.gridCellSize * 111000) {
          return closestNodeId;
        }
      }

      if (closestNodeId !== null) {
        return closestNodeId;
      }

      // Fast Boundary Cell Fallback:
      // If coordinates are outside r=12 (~13km), evaluate the nearest populated grid cell (392 cells)
      // instead of performing an unindexed full linear scan across 197,540 nodes.
      let closestBucket = null;
      let minCellDist = Infinity;
      for (const [cellKey, bucket] of this.grid.entries()) {
        const [cx, cy] = cellKey.split(':').map(Number);
        const cellLat = cx * this.gridCellSize;
        const cellLon = cy * this.gridCellSize;
        const cDist = haversineDistance(lat, lon, cellLat, cellLon);
        if (cDist < minCellDist) {
          minCellDist = cDist;
          closestBucket = bucket;
        }
      }

      if (closestBucket) {
        for (let i = 0; i < closestBucket.length; i++) {
          const node = closestBucket[i];
          if (targetComponentId && node.componentId !== targetComponentId) {
            continue;
          }
          const dist = haversineDistance(lat, lon, node.lat, node.lon);
          if (dist < minDistance) {
            minDistance = dist;
            closestNodeId = node.id;
          }
        }
      }

      return closestNodeId;
    };

    if (preferMainComponent && this.mainComponentId !== null) {
      const mainResult = searchPass(this.mainComponentId);
      if (mainResult !== null) {
        return mainResult;
      }
    }

    return searchPass(null);
  }

  addHospital(id, name, lat, lon, snappedNodeId) {
    this.hospitals.set(id, {
      id,
      name,
      lat,
      lon,
      snappedNodeId
    });
  }

  getHospital(id) {
    return this.hospitals.get(id);
  }

  getAllHospitals() {
    return Array.from(this.hospitals.values());
  }

  serialize() {
    const serializedNodes = [];
    for (const id of this.roadNodes) {
      const n = this.nodes.get(id);
      if (n) {
        serializedNodes.push({
          id: n.id,
          lat: n.lat,
          lon: n.lon,
          cid: n.componentId,
          edges: n.edges.map(e => [e.to, Math.round(e.weight * 10) / 10, e.roadType, Math.round(e.distanceMeters || 0)])
        });
      }
    }

    return {
      version: 1,
      mainComponentId: this.mainComponentId,
      componentSizes: Array.from(this.componentSizes.entries()),
      hospitals: this.getAllHospitals(),
      nodes: serializedNodes
    };
  }

  static deserialize(data) {
    const graph = new Graph();
    graph.mainComponentId = data.mainComponentId;
    if (data.componentSizes) {
      graph.componentSizes = new Map(data.componentSizes);
    }

    if (data.nodes) {
      for (let i = 0; i < data.nodes.length; i++) {
        const raw = data.nodes[i];
        const node = new Node(raw.id, raw.lat, raw.lon);
        node.componentId = raw.cid;
        graph.nodes.set(raw.id, node);
        graph.registerRoadNode(node);

        if (raw.edges && raw.edges.length > 0) {
          for (let j = 0; j < raw.edges.length; j++) {
            const e = raw.edges[j];
            node.edges.push(new Edge(raw.id, e[0], e[1], e[2], e[3]));
          }
        }
      }
    }

    if (data.hospitals) {
      for (let i = 0; i < data.hospitals.length; i++) {
        const h = data.hospitals[i];
        graph.addHospital(h.id, h.name, h.lat, h.lon, h.snappedNodeId);
      }
    }

    return graph;
  }
}

module.exports = {
  Graph,
  Node,
  Edge,
  haversineDistance,
  computeEdgeTravelTime,
  ROAD_SPEEDS,
  DEFAULT_SPEED_KMH,
  MAX_SPEED_KMH,
  MAX_SPEED_MS
};
