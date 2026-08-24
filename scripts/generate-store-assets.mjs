import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");
const assetDir = path.join(projectDir, "store-assets");
mkdirSync(assetDir, { recursive: true });

const COLORS = {
  navy: [11, 34, 61, 255],
  topbar: [16, 27, 45, 255],
  blue: [23, 59, 103, 255],
  paleBlue: [234, 242, 251, 255],
  orange: [237, 126, 32, 255],
  ink: [23, 35, 52, 255],
  muted: [92, 113, 137, 255],
  pale: [238, 242, 246, 255],
  border: [218, 226, 235, 255],
  white: [255, 255, 255, 255],
  warning: [255, 244, 223, 255],
  warningBorder: [255, 213, 140, 255],
  warningInk: [122, 69, 16, 255]
};

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00110", "00100"],
  ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "'": ["00100", "00100", "00010", "00000", "00000", "00000", "00000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"]
};

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

function encodePng(width, height, rgba) {
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

class Canvas {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    this.rect(0, 0, width, height, background);
  }

  pixel(x, y, color) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    this.data[offset] = color[0];
    this.data[offset + 1] = color[1];
    this.data[offset + 2] = color[2];
    this.data[offset + 3] = color[3] ?? 255;
  }

  rect(x, y, width, height, color) {
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(this.width, Math.ceil(x + width));
    const bottom = Math.min(this.height, Math.ceil(y + height));
    for (let py = top; py < bottom; py += 1) {
      for (let px = left; px < right; px += 1) this.pixel(px, py, color);
    }
  }

  roundRect(x, y, width, height, radius, color) {
    for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
      for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) {
        const nx = Math.max(x + radius - px, 0, px - (x + width - radius - 1));
        const ny = Math.max(y + radius - py, 0, py - (y + height - radius - 1));
        if ((nx === 0 && ny === 0) || Math.hypot(nx, ny) <= radius) this.pixel(px, py, color);
      }
    }
  }

  circle(cx, cy, radius, color) {
    const rr = radius * radius;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rr) this.pixel(x, y, color);
      }
    }
  }

  polygon(points, color) {
    const minX = Math.floor(Math.min(...points.map(([x]) => x)));
    const maxX = Math.ceil(Math.max(...points.map(([x]) => x)));
    const minY = Math.floor(Math.min(...points.map(([, y]) => y)));
    const maxY = Math.ceil(Math.max(...points.map(([, y]) => y)));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) this.pixel(x, y, color);
      }
    }
  }

  line(ax, ay, bx, by, width, color) {
    const minX = Math.floor(Math.min(ax, bx) - width);
    const maxX = Math.ceil(Math.max(ax, bx) + width);
    const minY = Math.floor(Math.min(ay, by) - width);
    const maxY = Math.ceil(Math.max(ay, by) + width);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const t = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
        if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= width / 2) this.pixel(x, y, color);
      }
    }
  }

  glyph(character, x, y, scale, color) {
    const rows = FONT[character] || FONT["?"];
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (rows[row][column] === "1") this.rect(x + column * scale, y + row * scale, scale, scale, color);
      }
    }
  }

  text(value, x, y, scale, color, maxWidth = Infinity) {
    const sourceLines = String(value).toUpperCase().split("\n");
    const lines = [];
    const maxCharacters = Number.isFinite(maxWidth) ? Math.max(1, Math.floor((maxWidth + scale) / (6 * scale))) : Infinity;
    for (const sourceLine of sourceLines) {
      if (!Number.isFinite(maxCharacters) || sourceLine.length <= maxCharacters) {
        lines.push(sourceLine);
        continue;
      }
      let current = "";
      for (const word of sourceLine.split(/\s+/)) {
        if (!current || current.length + 1 + word.length <= maxCharacters) current += `${current ? " " : ""}${word}`;
        else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
    }
    lines.forEach((line, lineIndex) => {
      [...line].forEach((character, index) => this.glyph(character, x + index * 6 * scale, y + lineIndex * 9 * scale, scale, color));
    });
    return lines.length * 9 * scale;
  }

  centeredText(value, centerX, y, scale, color) {
    const width = String(value).length * 6 * scale - scale;
    this.text(value, Math.round(centerX - width / 2), y, scale, color);
  }

  save(destination) {
    writeFileSync(destination, encodePng(this.width, this.height, this.data));
    console.log(destination);
  }
}

function drawParcelMark(canvas, x, y, size) {
  const s = size / 128;
  canvas.roundRect(x, y, size, size, 26 * s, COLORS.navy);
  const parcel = [[x + 27 * s, y + 45 * s], [x + 64 * s, y + 25 * s], [x + 101 * s, y + 45 * s], [x + 101 * s, y + 85 * s], [x + 64 * s, y + 106 * s], [x + 27 * s, y + 85 * s]];
  canvas.polygon(parcel, COLORS.white);
  canvas.line(x + 27 * s, y + 45 * s, x + 64 * s, y + 65 * s, 4 * s, [190, 209, 229, 255]);
  canvas.line(x + 64 * s, y + 65 * s, x + 101 * s, y + 45 * s, 4 * s, [190, 209, 229, 255]);
  canvas.line(x + 64 * s, y + 65 * s, x + 64 * s, y + 106 * s, 4 * s, [190, 209, 229, 255]);
  canvas.circle(x + 94 * s, y + 94 * s, 25 * s, COLORS.white);
  canvas.circle(x + 94 * s, y + 94 * s, 20 * s, COLORS.orange);
  canvas.line(x + 84 * s, y + 94 * s, x + 91 * s, y + 101 * s, 4 * s, COLORS.white);
  canvas.line(x + 91 * s, y + 101 * s, x + 106 * s, y + 84 * s, 4 * s, COLORS.white);
}

function promoTile() {
  const canvas = new Canvas(440, 280, COLORS.navy);
  canvas.circle(410, 68, 118, COLORS.blue);
  canvas.circle(430, 274, 94, COLORS.orange);
  canvas.circle(430, 274, 67, COLORS.blue);
  drawParcelMark(canvas, 32, 25, 88);
  canvas.text("DELIVERY STATUS + CLAIMS", 137, 38, 2, [255, 181, 101, 255]);
  canvas.text("CARRIER CLAIM\nASSISTANT", 137, 70, 3, COLORS.white);
  canvas.text("CHECK OFFICIAL TRACKING, REVIEW THE DETECTED ISSUE,", 38, 150, 2, [220, 231, 242, 255], 344);
  canvas.text("AND PREPARE THE RIGHT CARRIER CLAIM.", 38, 191, 2, [220, 231, 242, 255], 344);
  canvas.text("COLISSIMO / LA POSTE / CHRONOPOST", 38, 250, 1, COLORS.white);
  canvas.save(path.join(assetDir, "small-promo-tile-440x280.png"));
}

function card(canvas, x, y, width, height) {
  canvas.roundRect(x, y, width, height, 10, COLORS.border);
  canvas.roundRect(x + 1, y + 1, width - 2, height - 2, 9, COLORS.white);
}

function field(canvas, label, value, y, height = 42) {
  canvas.text(label, 849, y, 1, COLORS.muted);
  canvas.roundRect(849, y + 16, 374, height, 6, [187, 200, 214, 255]);
  canvas.roundRect(850, y + 17, 372, height - 2, 5, COLORS.white);
  canvas.text(value, 861, y + 30, 1, COLORS.ink, 350);
}

function orderScreenshot() {
  const canvas = new Canvas(1280, 800, COLORS.pale);
  canvas.rect(0, 0, 1280, 58, COLORS.topbar);
  canvas.text("SELLER CENTRAL", 30, 20, 2, COLORS.white);
  canvas.roundRect(208, 12, 430, 35, 7, COLORS.white);
  canvas.text("SEARCH ORDERS, PRODUCTS, CUSTOMERS...", 224, 23, 1, COLORS.muted);
  canvas.text("EXAMPLE STORE / FRANCE", 1100, 25, 1, [220, 231, 242, 255]);
  canvas.rect(0, 58, 190, 742, COLORS.white);
  canvas.roundRect(18, 82, 154, 40, 8, COLORS.paleBlue);
  canvas.text("ORDERS", 30, 95, 2, COLORS.blue);
  ["MANAGE ORDERS", "ORDER REPORTS", "SHIPPING", "INVENTORY", "SETTINGS"].forEach((label, index) => canvas.text(label, 30, 141 + index * 40, 1, COLORS.muted));

  canvas.text("ORDERS / ORDER DETAILS", 220, 86, 1, COLORS.muted);
  canvas.text("ORDER 111-2222222-3333333", 220, 112, 3, COLORS.ink);
  canvas.roundRect(1040, 83, 202, 28, 14, [240, 179, 79, 255]);
  canvas.roundRect(1041, 84, 200, 26, 13, [255, 247, 232, 255]);
  canvas.text("SYNTHETIC PREVIEW DATA", 1053, 94, 1, [134, 82, 20, 255]);

  card(canvas, 220, 159, 586, 225);
  canvas.text("SHIPMENT DETAILS", 242, 180, 2, COLORS.ink);
  const rows = [
    ["STATUS", "SHIPPED"],
    ["SHIPPING CARRIER", "COLISSIMO"],
    ["TRACKING ID", "CC000000002FR"],
    ["SHIP DATE", "17 AUGUST 2026"],
    ["DELIVER BY", "20 AUGUST 2026"]
  ];
  rows.forEach(([label, value], index) => {
    const y = 225 + index * 29;
    canvas.text(label, 242, y, 1, COLORS.muted);
    canvas.text(value, 408, y, 1, index === 2 ? [23, 105, 170, 255] : COLORS.ink);
  });
  card(canvas, 220, 400, 586, 125);
  canvas.text("ORDER CONTENTS", 242, 421, 2, COLORS.ink);
  canvas.roundRect(242, 457, 62, 52, 8, COLORS.pale);
  canvas.text("?", 268, 472, 2, COLORS.muted);
  canvas.text("EXAMPLE BLUETOOTH HEADSET", 322, 463, 2, COLORS.ink);
  canvas.text("QTY 1 / EUR 129.00", 322, 492, 1, COLORS.muted);
  card(canvas, 220, 541, 586, 145);
  canvas.text("SHIP TO", 242, 562, 2, COLORS.ink);
  canvas.text("MARY EXAMPLE\nMAIN STREET 1\nD02XY12 DUBLIN\nIRELAND", 242, 597, 1, COLORS.ink);

  canvas.roundRect(830, 159, 412, 527, 10, COLORS.blue);
  canvas.roundRect(832, 161, 408, 523, 8, COLORS.white);
  canvas.rect(832, 161, 408, 67, COLORS.blue);
  drawParcelMark(canvas, 849, 175, 40);
  canvas.text("CARRIER CLAIM ASSISTANT", 902, 175, 2, COLORS.white);
  canvas.text("OFFICIAL CARRIER CHECK COMPLETE", 902, 204, 1, [220, 231, 242, 255]);
  canvas.roundRect(849, 245, 374, 62, 8, COLORS.warningBorder);
  canvas.roundRect(850, 246, 372, 60, 7, COLORS.warning);
  canvas.text("CLAIM RECOMMENDED / NOT DELIVERED", 863, 258, 2, COLORS.warningInk);
  canvas.text("LAST CHECKED: 24/08/2026 16:30 / OFFICIAL TRACKING", 863, 286, 1, COLORS.warningInk, 346);
  field(canvas, "COMPLAINT REASON", "UNLOCATED / NOT DELIVERED", 326);
  field(canvas, "RECIPIENT TITLE + DESTINATION", "MADAME / MARY EXAMPLE / D02XY12 DUBLIN / IRELAND", 402);
  field(canvas, "EDITABLE CLAIM MESSAGE", "THE PARCEL CC000000002FR WAS NOT DELIVERED. PLEASE OPEN AN INVESTIGATION AND PROVIDE A DELIVERY OR COMPENSATION SOLUTION.", 478, 92);
  canvas.roundRect(1003, 618, 220, 42, 7, COLORS.orange);
  canvas.centeredText("START AUTOMATED CLAIM", 1113, 633, 1, COLORS.white);
  canvas.roundRect(510, 729, 274, 45, 23, COLORS.orange);
  canvas.centeredText("CLAIM RECOMMENDED / REVIEW", 647, 744, 1, COLORS.white);
  canvas.save(path.join(assetDir, "screenshot-order-preview-1280x800.png"));
}

promoTile();
orderScreenshot();
