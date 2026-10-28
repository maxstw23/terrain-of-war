// Elevation access on top of open terrain tiles (AWS Terrain Tiles, Terrarium PNG
// encoding). Decodes tiles into Float32 arrays and exposes synchronous sampling once
// the tiles covering an area have been prefetched. All analysis in analysis.js reads
// heights from here, independently of what the map is currently rendering.

export const TILE = 256;
const EARTH_CIRC = 40075016.686;

export const TERRARIUM = {
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  maxzoom: 15,
  attribution:
    'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> ' +
    '(SRTM, GMTED, ETOPO1 and others)',
};

export function lonLatToWorldPx(lon, lat, z) {
  const size = TILE * 2 ** z;
  const sin = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [
    ((lon + 180) / 360) * size,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  ];
}

export function worldPxToLonLat(x, y, z) {
  const size = TILE * 2 ** z;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return [(x / size) * 360 - 180, (180 / Math.PI) * Math.atan(Math.sinh(n))];
}

export function metersPerPixel(lat, z) {
  return (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);
}

function decodeRGB(rgba, encoding) {
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    out[i] = encoding === 'mapbox'
      ? -10000 + (r * 65536 + g * 256 + b) * 0.1
      : r * 256 + g + b / 256 - 32768;
  }
  return out;
}

async function blobToRGBA(blob) {
  // Exact pixel values matter (they encode heights): no premultiply, no colour management.
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(TILE, TILE)
    : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return ctx.getImageData(0, 0, TILE, TILE).data;
}

export class DemSource {
  constructor({ url, encoding, maxzoom } = TERRARIUM) {
    this.url = url;
    this.encoding = encoding;
    this.maxzoom = maxzoom;
    this.pending = new Map(); // key -> Promise<Float32Array>
    this.ready = new Map(); // key -> Float32Array
  }

  tile(z, x, y) {
    const n = 2 ** z;
    x = ((x % n) + n) % n;
    const key = `${z}/${x}/${y}`;
    if (!this.pending.has(key)) {
      const url = this.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`DEM tile ${key}: HTTP ${r.status}`);
          return r.blob();
        })
        .then(blobToRGBA)
        .then((rgba) => decodeRGB(rgba, this.encoding))
        .catch((err) => {
          console.warn(err);
          this.pending.delete(key); // allow a later retry
          return new Float32Array(TILE * TILE);
        })
        .then((data) => {
          this.ready.set(key, data);
          return data;
        });
      this.pending.set(key, p);
    }
    return this.pending.get(key);
  }

  /** Fetch every tile intersecting a lon/lat bbox [w, s, e, n] at zoom z. */
  async prefetchBBox([w, s, e, n], z) {
    const [x0, y0] = lonLatToWorldPx(w, n, z);
    const [x1, y1] = lonLatToWorldPx(e, s, z);
    const jobs = [];
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++)
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++)
        jobs.push(this.tile(z, tx, ty));
    if (jobs.length > 400) throw new Error(`Area too large for zoom ${z} (${jobs.length} tiles)`);
    await Promise.all(jobs);
  }

  /** Fetch the tiles touched by a list of [lon, lat] points. */
  async prefetchPoints(points, z) {
    const keys = new Map();
    for (const [lon, lat] of points) {
      const [px, py] = lonLatToWorldPx(lon, lat, z);
      // Bilinear sampling reads the pixel on either side, which may sit in a neighbouring tile.
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const tx = Math.floor((px + dx) / TILE), ty = Math.floor((py + dy) / TILE);
        keys.set(`${tx}/${ty}`, [tx, ty]);
      }
    }
    await Promise.all([...keys.values()].map(([tx, ty]) => this.tile(z, tx, ty)));
  }

  /** Height (m) of an integer world pixel; tiles must already be prefetched. */
  pixel(ix, iy, z) {
    const n = 2 ** z;
    const tx = Math.floor(ix / TILE), ty = Math.min(n - 1, Math.max(0, Math.floor(iy / TILE)));
    const data = this.ready.get(`${z}/${((tx % n) + n) % n}/${ty}`);
    if (!data) return 0;
    const lx = ix - tx * TILE, ly = Math.min(TILE - 1, Math.max(0, iy - ty * TILE));
    return data[ly * TILE + lx];
  }

  /** Bilinear height at fractional world pixel coordinates (pixel centres at +0.5). */
  elevAtWorldPx(px, py, z) {
    const x = px - 0.5, y = py - 0.5;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const a = this.pixel(ix, iy, z), b = this.pixel(ix + 1, iy, z);
    const c = this.pixel(ix, iy + 1, z), d = this.pixel(ix + 1, iy + 1, z);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /** Height from the most detailed already-loaded tile at or below zmax, or null. */
  elevAtLoaded(lon, lat, zmax) {
    for (let z = Math.min(zmax, this.maxzoom); z >= 0; z--) {
      const [px, py] = lonLatToWorldPx(lon, lat, z);
      if (this.ready.has(`${z}/${Math.floor(px / TILE)}/${Math.floor(py / TILE)}`)) return this.elevAtWorldPx(px, py, z);
    }
    return null;
  }

  elevAt(lon, lat, z) {
    const [px, py] = lonLatToWorldPx(lon, lat, z);
    return this.elevAtWorldPx(px, py, z);
  }

  /**
   * Copy a rectangular window of world pixels into a dense grid. The grid is in Web
   * Mercator pixel space at zoom z, which keeps it aligned with the source tiles.
   */
  async grid(bbox, z) {
    await this.prefetchBBox(bbox, z);
    const [w, s, e, n] = bbox;
    const [fx0, fy0] = lonLatToWorldPx(w, n, z);
    const [fx1, fy1] = lonLatToWorldPx(e, s, z);
    const x0 = Math.floor(fx0), y0 = Math.floor(fy0);
    const width = Math.ceil(fx1) - x0, height = Math.ceil(fy1) - y0;
    const data = new Float32Array(width * height);
    for (let j = 0; j < height; j++)
      for (let i = 0; i < width; i++) data[j * width + i] = this.pixel(x0 + i, y0 + j, z);
    return new DemGrid(z, x0, y0, width, height, data);
  }

  /** Highest zoom (≤ cap) at which the bbox fits in maxCells grid cells. */
  zoomFor(bbox, maxCells, cap = 12) {
    for (let z = Math.min(cap, this.maxzoom); z > 3; z--) {
      const [x0, y0] = lonLatToWorldPx(bbox[0], bbox[3], z);
      const [x1, y1] = lonLatToWorldPx(bbox[2], bbox[1], z);
      if ((x1 - x0) * (y1 - y0) <= maxCells) return z;
    }
    return 4;
  }
}

export class DemGrid {
  constructor(z, x0, y0, width, height, data) {
    Object.assign(this, { z, x0, y0, width, height, data });
  }
  idx(i, j) {
    return j * this.width + i;
  }
  /** Grid cell (i, j) for a lon/lat, fractional. */
  toCell(lon, lat) {
    const [px, py] = lonLatToWorldPx(lon, lat, this.z);
    return [px - this.x0 - 0.5, py - this.y0 - 0.5];
  }
  cellToLonLat(i, j) {
    return worldPxToLonLat(this.x0 + i + 0.5, this.y0 + j + 0.5, this.z);
  }
  /** Bilinear sample at fractional cell coordinates (clamped to the grid). */
  sample(i, j) {
    const W = this.width, H = this.height, d = this.data;
    i = Math.max(0, Math.min(W - 1.001, i));
    j = Math.max(0, Math.min(H - 1.001, j));
    const i0 = Math.floor(i), j0 = Math.floor(j), fx = i - i0, fy = j - j0;
    const k = j0 * W + i0;
    return (d[k] * (1 - fx) + d[k + 1] * fx) * (1 - fy) + (d[k + W] * (1 - fx) + d[k + W + 1] * fx) * fy;
  }
  /** lon/lat corners [tl, tr, br, bl] of the grid, for MapLibre image sources. */
  corners() {
    const { z, x0, y0, width: w, height: h } = this;
    return [
      worldPxToLonLat(x0, y0, z),
      worldPxToLonLat(x0 + w, y0, z),
      worldPxToLonLat(x0 + w, y0 + h, z),
      worldPxToLonLat(x0, y0 + h, z),
    ];
  }
}
