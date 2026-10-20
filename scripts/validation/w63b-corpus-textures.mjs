/**
 * W63b deterministic textures. Pure functions of (seed, size, bias): smooth multi-octave value noise on a 192/96/48 px lattice
 * (structure the 12:1 analysis grid of the temporal producer can see), with a small chroma term. Nothing here is random at run
 * time, so a texture is reproduced byte for byte from its parameters.
 */
const OCTAVES = Object.freeze([{ scale: 192, weight: 0.5 }, { scale: 96, weight: 0.3 }, { scale: 48, weight: 0.2 }])

function lattice(seed, octave, channel, columns, rows) {
  const values = new Float32Array(columns * rows)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let h = (seed ^ Math.imul(column + 1, 0x27d4eb2d) ^ Math.imul(row + 1, 0x165667b1) ^ Math.imul(octave + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b)) >>> 0
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
      h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0
      h = (h ^ (h >>> 15)) >>> 0
      values[row * columns + column] = h / 4294967296
    }
  }
  return values
}

function field(seed, octave, channel, scale, width, height) {
  const columns = Math.ceil(width / scale) + 2
  const rows = Math.ceil(height / scale) + 2
  const grid = lattice(seed, octave, channel, columns, rows)
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const gy = y / scale
    const iy = Math.floor(gy)
    const ty = gy - iy
    const sy = ty * ty * (3 - 2 * ty)
    for (let x = 0; x < width; x += 1) {
      const gx = x / scale
      const ix = Math.floor(gx)
      const tx = gx - ix
      const sx = tx * tx * (3 - 2 * tx)
      const a = grid[iy * columns + ix]
      const b = grid[iy * columns + ix + 1]
      const c = grid[(iy + 1) * columns + ix]
      const d = grid[(iy + 1) * columns + ix + 1]
      out[y * width + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
    }
  }
  return out
}

/** Returns an RGB buffer (width*height*3). `bias` shifts the mean luma (-0.5..0.5); `chroma` scales the colour term. */
export function textureRgb({ seed, width, height, bias = 0, chroma = 0.35 }) {
  const luma = new Float32Array(width * height)
  OCTAVES.forEach((octave, index) => {
    const noise = field(seed, index, 0, octave.scale, width, height)
    for (let i = 0; i < luma.length; i += 1) luma[i] += octave.weight * (noise[i] - 0.5)
  })
  const tint = [1, 2, 3].map((channel) => field(seed, 7, channel, 96, width, height))
  const out = Buffer.alloc(width * height * 3)
  for (let i = 0; i < luma.length; i += 1) {
    const base = 0.5 + bias + luma[i] * 1.6
    for (let channel = 0; channel < 3; channel += 1) {
      const value = base + chroma * (tint[channel][i] - 0.5)
      out[i * 3 + channel] = Math.round(255 * Math.min(0.88, Math.max(0.12, value)))
    }
  }
  return out
}

/** An "inserted image": the same texture family with strong colour and a 6 px white frame. */
export function insertRgb({ seed, width, height }) {
  const rgb = textureRgb({ seed, width, height, bias: 0, chroma: 1.1 })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < 6 || y < 6 || x >= width - 6 || y >= height - 6) {
        const offset = (y * width + x) * 3
        rgb[offset] = 255
        rgb[offset + 1] = 255
        rgb[offset + 2] = 255
      }
    }
  }
  return rgb
}
