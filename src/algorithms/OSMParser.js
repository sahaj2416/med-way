const fs = require('fs');
const path = require('path');
const sax = require('sax');
const { Graph, haversineDistance } = require('./Graph');

const DRIVABLE_HIGHWAYS = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'residential', 'living_street',
  'unclassified', 'service'
]);

function findNearestRoadNode(graph, lat, lon) {
  return graph.findNearestRoadNode(lat, lon);
}

function parseOSM(customPath) {
  const filePath = customPath || path.resolve(__dirname, '../../data/noida.osm');

  return new Promise((resolve, reject) => {
    const graph = new Graph();
    const rawHospitals = [];
    let currentNode = null;
    let currentWay = null;

    const stream = sax.createStream(true);

    stream.on('opentag', (node) => {
      if (node.name === 'node') {
        currentNode = {
          id: node.attributes.id,
          lat: parseFloat(node.attributes.lat),
          lon: parseFloat(node.attributes.lon),
          isHospital: false,
          name: null
        };
        graph.addNode(currentNode.id, currentNode.lat, currentNode.lon);
      } else if (node.name === 'way') {
        currentWay = {
          id: node.attributes.id,
          nds: [],
          highway: null,
          isHighway: false,
          isHospital: false,
          name: null,
          oneway: null,
          junction: null,
          isArea: false
        };
      } else if (node.name === 'nd' && currentWay) {
        currentWay.nds.push(node.attributes.ref);
      } else if (node.name === 'tag') {
        const k = node.attributes.k;
        const v = node.attributes.v;
        if (currentNode) {
          if (k === 'amenity' && (v === 'hospital' || v === 'clinic')) {
            currentNode.isHospital = true;
          }
          if (k === 'name') {
            currentNode.name = v;
          }
        }
        if (currentWay) {
          if (k === 'highway') {
            currentWay.highway = v;
            if (DRIVABLE_HIGHWAYS.has(v)) {
              currentWay.isHighway = true;
            }
          }
          if (k === 'oneway') {
            currentWay.oneway = v;
          }
          if (k === 'junction') {
            currentWay.junction = v;
          }
          if (k === 'area' && v === 'yes') {
            currentWay.isArea = true;
          }
          if (k === 'amenity' && (v === 'hospital' || v === 'clinic')) {
            currentWay.isHospital = true;
          }
          if (k === 'name') {
            currentWay.name = v;
          }
        }
      }
    });

    stream.on('closetag', (tagName) => {
      if (tagName === 'node') {
        if (currentNode && currentNode.isHospital) {
          rawHospitals.push({
            id: currentNode.id,
            name: currentNode.name || 'Unknown Hospital',
            lat: currentNode.lat,
            lon: currentNode.lon
          });
        }
        currentNode = null;
      } else if (tagName === 'way') {
        if (currentWay) {
          if (currentWay.isHighway && !currentWay.isArea && currentWay.nds.length >= 2) {
            const highwayType = currentWay.highway || 'residential';
            const onewayTag = currentWay.oneway;
            const isRoundabout = currentWay.junction === 'roundabout';
            const isMotorway = highwayType === 'motorway' || highwayType === 'motorway_link';

            let isOneWayForward = false;
            let isOneWayReverse = false;

            if (onewayTag === 'yes' || onewayTag === '1' || onewayTag === 'true' || isRoundabout) {
              isOneWayForward = true;
            } else if (onewayTag === '-1' || onewayTag === 'reverse') {
              isOneWayReverse = true;
            } else if (isMotorway && onewayTag !== 'no' && onewayTag !== '0' && onewayTag !== 'false') {
              isOneWayForward = true;
            }

            for (let i = 0; i < currentWay.nds.length - 1; i++) {
              const u = currentWay.nds[i];
              const v = currentWay.nds[i + 1];

              if (isOneWayForward) {
                graph.addDirectedEdge(u, v, highwayType);
              } else if (isOneWayReverse) {
                graph.addDirectedEdge(v, u, highwayType);
              } else {
                graph.addBidirectionalEdge(u, v, highwayType);
              }
            }
          }

          if (currentWay.isHospital && currentWay.nds.length > 0) {
            const firstNode = graph.getNode(currentWay.nds[0]);
            if (firstNode) {
              rawHospitals.push({
                id: currentWay.id,
                name: currentWay.name || 'Unknown Hospital',
                lat: firstNode.lat,
                lon: firstNode.lon
              });
            }
          }
        }
        currentWay = null;
      }
    });

    stream.on('error', (err) => {
      reject(err);
    });

    stream.on('end', () => {
      // 1. Precompute connected components across the road network
      graph.computeConnectedComponents();

      // 2. Snap hospitals to the main road network
      for (const h of rawHospitals) {
        const snappedId = graph.findNearestRoadNode(h.lat, h.lon, true);
        graph.addHospital(h.id, h.name, h.lat, h.lon, snappedId);
      }

      resolve({
        graph,
        hospitals: graph.getAllHospitals()
      });
    });

    fs.createReadStream(filePath).pipe(stream);
  });
}

function findDataFile(filename) {
  const candidates = [
    path.resolve(__dirname, '../../data', filename),
    path.resolve(process.cwd(), 'data', filename),
    path.resolve(__dirname, '../data', filename),
    path.resolve(process.cwd(), filename)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

async function loadGraph(customPath, forceRebuild = false) {
  const osmPath = customPath || findDataFile('noida.osm');
  const cachePath = findDataFile('noida_graph.cache.json');

  if (!forceRebuild && fs.existsSync(cachePath)) {
    try {
      const osmExists = fs.existsSync(osmPath);
      const isCacheFresh = !osmExists || (fs.statSync(cachePath).mtimeMs >= fs.statSync(osmPath).mtimeMs);
      if (isCacheFresh) {
        const rawJson = fs.readFileSync(cachePath, 'utf8');
        const cacheData = JSON.parse(rawJson);
        const graph = Graph.deserialize(cacheData);
        return {
          graph,
          hospitals: graph.getAllHospitals(),
          fromCache: true
        };
      }
    } catch (cacheErr) {
      console.warn('Failed to read graph cache, rebuilding from OSM:', cacheErr.message);
    }
  }

  if (!fs.existsSync(osmPath)) {
    throw new Error(`Cannot load road network: neither valid graph cache (${cachePath}) nor OSM file (${osmPath}) exists.`);
  }

  const result = await parseOSM(osmPath);

  try {
    const serialized = result.graph.serialize();
    fs.writeFileSync(cachePath, JSON.stringify(serialized));
  } catch (saveErr) {
    console.warn('Failed to save graph cache:', saveErr.message);
  }

  return {
    ...result,
    fromCache: false
  };
}

if (require.main === module) {
  loadGraph()
    .then(({ graph, hospitals }) => {
      console.log('Graph parsing completed successfully.');
      console.log('Total nodes:', graph.nodes.size);
      console.log('Road network nodes:', graph.roadNodes.size);
      console.log('Main component ID:', graph.mainComponentId, 'size:', graph.componentSizes.get(graph.mainComponentId));
      console.log('Total connected components:', graph.componentSizes.size);
      console.log('Total hospitals snapped to road nodes:', hospitals.length);
      const sample = hospitals.slice(0, 3);
      console.log('Sample snapped hospitals:', sample);
    })
    .catch((err) => {
      console.error('OSM parsing failed:', err);
      process.exit(1);
    });
}

module.exports = {
  parseOSM,
  loadGraph,
  findNearestRoadNode,
  haversineDistance,
  Graph,
  DRIVABLE_HIGHWAYS
};
