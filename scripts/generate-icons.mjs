import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");
const iconDir = path.join(projectDir, "icons");
mkdirSync(iconDir, { recursive: true });

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function png(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    rgba.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function blendPixel(buffer, width, x, y, color, coverage = 1) {
  if (x < 0 || y < 0 || x >= width || y >= width || coverage <= 0) return;
  const offset = (y * width + x) * 4;
  const alpha = Math.max(0, Math.min(1, coverage * (color[3] / 255)));
  for (let channel = 0; channel < 3; channel += 1) {
    buffer[offset + channel] = Math.round(color[channel] * alpha + buffer[offset + channel] * (1 - alpha));
  }
  buffer[offset + 3] = 255;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawIcon(size) {
  const scale = size / 128;
  const sample = 3;
  const buffer = Buffer.alloc(size * size * 4, 0);
  const blue = [18, 51, 85, 255];
  const white = [255, 255, 255, 255];
  const seam = [190, 209, 229, 255];
  const orange = [244, 132, 30, 255];
  const parcel = [[27, 45], [64, 25], [101, 45], [101, 85], [64, 106], [27, 85]];
  const topLeft = [[27, 45], [64, 65], [64, 106], [27, 85]];
  const topRight = [[101, 45], [64, 65], [64, 106], [101, 85]];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let backgroundCoverage = 0;
      let parcelCoverage = 0;
      let leftCoverage = 0;
      let rightCoverage = 0;
      let seamCoverage = 0;
      let orangeCoverage = 0;
      let ringCoverage = 0;
      let checkCoverage = 0;
      for (let sy = 0; sy < sample; sy += 1) {
        for (let sx = 0; sx < sample; sx += 1) {
          const px = (x + (sx + 0.5) / sample) / scale;
          const py = (y + (sy + 0.5) / sample) / scale;
          const edgeX = Math.max(7 - px, 0, px - 121);
          const edgeY = Math.max(7 - py, 0, py - 121);
          if ((edgeX === 0 && edgeY === 0) || Math.hypot(edgeX, edgeY) <= 27) backgroundCoverage += 1;
          if (insidePolygon(px, py, parcel)) parcelCoverage += 1;
          if (insidePolygon(px, py, topLeft)) leftCoverage += 1;
          if (insidePolygon(px, py, topRight)) rightCoverage += 1;
          if (distanceToSegment(px, py, 27, 45, 64, 65) <= 3 || distanceToSegment(px, py, 64, 65, 101, 45) <= 3 || distanceToSegment(px, py, 64, 65, 64, 106) <= 3) seamCoverage += 1;
          const markerDistance = Math.hypot(px - 94, py - 94);
          if (markerDistance <= 25) ringCoverage += 1;
          if (markerDistance <= 20) orangeCoverage += 1;
          if (distanceToSegment(px, py, 84, 94, 91, 101) <= 3.2 || distanceToSegment(px, py, 91, 101, 106, 84) <= 3.2) checkCoverage += 1;
        }
      }
      const total = sample * sample;
      blendPixel(buffer, size, x, y, blue, backgroundCoverage / total);
      blendPixel(buffer, size, x, y, white, parcelCoverage / total);
      blendPixel(buffer, size, x, y, [244, 248, 252, 255], leftCoverage / total);
      blendPixel(buffer, size, x, y, white, rightCoverage / total);
      blendPixel(buffer, size, x, y, seam, seamCoverage / total);
      blendPixel(buffer, size, x, y, white, ringCoverage / total);
      blendPixel(buffer, size, x, y, orange, orangeCoverage / total);
      blendPixel(buffer, size, x, y, white, checkCoverage / total);
    }
  }
  return png(size, size, buffer);
}

for (const size of [16, 48, 128]) {
  const destination = path.join(iconDir, `icon${size}.png`);
  writeFileSync(destination, drawIcon(size));
  console.log(destination);
}

