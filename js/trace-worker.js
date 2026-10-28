// Traces terrain-following routes off the main thread, so the map stays responsive
// while a scenario that was not pre-computed (e.g. one just generated) loads.

import { DemSource, TERRARIUM } from './dem.js';
import { leastCostRoute } from './analysis.js';

const dem = new DemSource(TERRARIUM);

self.onmessage = async ({ data: { id, waypoints, mode, maxCells } }) => {
  try {
    const res = await leastCostRoute(dem, waypoints, { mode, maxCells });
    self.postMessage({ id, ok: true, res });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e.message });
  }
};
