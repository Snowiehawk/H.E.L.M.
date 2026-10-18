#!/usr/bin/env node
// Validate the generated artwork and native containers without image-library dependencies.
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icons = resolve(desktop, "src-tauri/icons");
const failures = [];
const checked = [];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePng(data) {
  assert(data.subarray(0, 8).equals(pngSignature), "invalid PNG signature");
  let offset = 8;
  let header;
  let ended = false;
  const compressed = [];
  while (offset < data.length) {
    assert(offset + 12 <= data.length, "truncated PNG chunk");
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert(end <= data.length, "PNG chunk exceeds file length");
    const tag = data.toString("ascii", offset + 4, offset + 8);
    const payload = data.subarray(offset + 8, offset + 8 + length);
    assert(
      crc32(data.subarray(offset + 4, offset + 8 + length)) === data.readUInt32BE(end - 4),
      `invalid ${tag} CRC`,
    );
    if (!header) assert(tag === "IHDR", "PNG must begin with IHDR");
    if (tag === "IHDR") {
      assert(!header && length === 13, "invalid PNG header");
      header = {
        width: payload.readUInt32BE(0),
        height: payload.readUInt32BE(4),
        depth: payload[8],
        type: payload[9],
      };
      assert(
        header.width > 0 && header.width <= 4096 && header.height > 0 && header.height <= 4096,
        "unsupported PNG dimensions",
      );
      assert(
        [8, 16].includes(header.depth) && header.type === 6,
        "expected RGBA PNG with 8- or 16-bit channels",
      );
      assert(
        payload[10] === 0 && payload[11] === 0 && payload[12] === 0,
        "expected standard non-interlaced PNG",
      );
    } else if (tag === "IDAT") compressed.push(payload);
    else if (tag === "IEND") {
      assert(length === 0 && end === data.length, "invalid PNG end");
      ended = true;
      break;
    }
    offset = end;
  }
  assert(ended && compressed.length > 0, "incomplete PNG");
  const { width, height, depth } = header;
  const bytesPerPixel = (4 * depth) / 8;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: height * (stride + 1) });
  assert(raw.length === height * (stride + 1), "unexpected PNG pixel-data length");
  const alpha = new Uint8Array(width * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4, `invalid PNG filter ${filter}`);
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const b = previous[x];
      const c = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = (row[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const alphaOffset = x * bytesPerPixel + (3 * depth) / 8;
      alpha[y * width + x] =
        depth === 8 ? row[alphaOffset] : Math.round(row.readUInt16BE(alphaOffset) / 257);
    }
    previous = row;
  }
  return { width, height, alpha, format: `RGBA${depth}` };
}

function inspectFrame(name, frame, expectedSize) {
  const { width, height, alpha, format } = frame;
  assert(
    width === expectedSize && height === expectedSize,
    `expected ${expectedSize}×${expectedSize}, got ${width}×${height}`,
  );
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  let transparent = false,
    opaque = false;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = alpha[y * width + x];
      transparent ||= a === 0;
      opaque ||= a === 255;
      // Ignore subvisible resampling fringes when measuring transparent margins.
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1)
        assert(a < 128, "visible artwork touches the canvas edge");
      if (a >= 128) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  assert(
    transparent && opaque && right >= left,
    "expected transparent background and opaque artwork",
  );
  const margins = [left, top, width - 1 - right, height - 1 - bottom];
  assert(
    Math.abs((left + right + 1) / 2 - width / 2) <= 1 &&
      Math.abs((top + bottom + 1) / 2 - height / 2) <= 1,
    "artwork is not centered within one pixel",
  );
  assert(
    // Thin antialiased grip tips can fall below 128 alpha at 16px. Round the
    // upper pixel budget up before adding the one-pixel sampling allowance.
    margins.every((margin) => margin >= width * 0.04 - 1 && margin <= Math.ceil(width * 0.1) + 1),
    `expected 4–10% transparent padding (one-pixel rounding allowance), got ${margins.join("/")}px`,
  );
  checked.push({ name, size: width, format, margins });
}

async function check(name, action) {
  try {
    await action();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

for (const [name, size] of [
  ["32x32.png", 32],
  ["64x64.png", 64],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
]) {
  await check(name, async () =>
    inspectFrame(name, decodePng(await readFile(resolve(icons, name))), size),
  );
}

await check("icon.ico", async () => {
  const data = await readFile(resolve(icons, "icon.ico"));
  assert(
    data.length >= 6 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1,
    "invalid ICO header",
  );
  const count = data.readUInt16LE(4);
  assert(data.length >= 6 + count * 16, "truncated ICO directory");
  const found = new Set();
  const ranges = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = data[offset] || 256,
      height = data[offset + 1] || 256;
    const length = data.readUInt32LE(offset + 8),
      start = data.readUInt32LE(offset + 12);
    assert(width === height && !found.has(width), "duplicate or non-square ICO frame");
    assert(
      start >= 6 + count * 16 && start + length <= data.length,
      "ICO frame exceeds file bounds",
    );
    assert(
      ranges.every(([a, b]) => start + length <= a || start >= b),
      "overlapping ICO frames",
    );
    ranges.push([start, start + length]);
    inspectFrame(`icon.ico:${width}`, decodePng(data.subarray(start, start + length)), width);
    found.add(width);
  }
  for (const size of [16, 24, 32, 48, 64, 256])
    assert(found.has(size), `missing ${size}px ICO frame`);
});

// Tauri also emits classic RGB data plus separate alpha masks for 16/32px ICNS.
function validateLegacyRgb(data, size) {
  const pixels = size * size;
  if (data.length === pixels * 3) return;
  let offset = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    let decoded = 0;
    while (decoded < pixels) {
      assert(offset < data.length, "truncated legacy ICNS RGB data");
      const token = data[offset++];
      const count = token >= 128 ? token - 125 : token + 1;
      offset += token >= 128 ? 1 : count;
      decoded += count;
      assert(offset <= data.length && decoded <= pixels, "invalid legacy ICNS RGB run");
    }
  }
  assert(offset === data.length, "trailing legacy ICNS RGB data");
}

await check("icon.icns", async () => {
  const data = await readFile(resolve(icons, "icon.icns"));
  assert(
    data.length >= 8 &&
      data.toString("ascii", 0, 4) === "icns" &&
      data.readUInt32BE(4) === data.length,
    "invalid ICNS header",
  );
  const pngSizes = {
    icp4: 16,
    icp5: 32,
    icp6: 64,
    ic07: 128,
    ic08: 256,
    ic09: 512,
    ic10: 1024,
    ic11: 32,
    ic12: 64,
    ic13: 256,
    ic14: 512,
  };
  const chunks = new Map();
  const sizes = new Set();
  let offset = 8;
  while (offset < data.length) {
    assert(offset + 8 <= data.length, "truncated ICNS chunk");
    const tag = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    assert(
      length >= 8 && offset + length <= data.length && !chunks.has(tag),
      "invalid or duplicate ICNS chunk",
    );
    const payload = data.subarray(offset + 8, offset + length);
    chunks.set(tag, payload);
    if (pngSizes[tag]) {
      inspectFrame(`icon.icns:${tag}`, decodePng(payload), pngSizes[tag]);
      sizes.add(pngSizes[tag]);
    }
    offset += length;
  }
  for (const [rgbTag, alphaTag, size] of [
    ["is32", "s8mk", 16],
    ["il32", "l8mk", 32],
  ]) {
    if (!chunks.has(rgbTag) && !chunks.has(alphaTag)) continue;
    assert(chunks.has(rgbTag) && chunks.has(alphaTag), `incomplete ${size}px legacy ICNS frame`);
    validateLegacyRgb(chunks.get(rgbTag), size);
    const alpha = chunks.get(alphaTag);
    assert(alpha.length === size * size, `invalid ${size}px ICNS alpha mask`);
    inspectFrame(
      `icon.icns:${rgbTag}+${alphaTag}`,
      { width: size, height: size, alpha, format: "RGB+alpha8" },
      size,
    );
    sizes.add(size);
  }
  for (const size of [16, 32, 64, 128, 256, 512, 1024])
    assert(sizes.has(size), `missing ${size}px ICNS frame`);
});

await check("bundle references", async () => {
  const config = JSON.parse(await readFile(resolve(desktop, "src-tauri/tauri.conf.json"), "utf8"));
  const required = [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
  ];
  assert(Array.isArray(config.bundle?.icon), "missing bundle.icon list");
  for (const path of required)
    assert(config.bundle.icon.includes(path), `missing ${path} bundle reference`);
  for (const path of config.bundle.icon) await access(resolve(desktop, "src-tauri", path));
});

await check("SVG source and browser copy", async () => {
  const source = await readFile(resolve(desktop, "assets/helm.svg"));
  const browser = await readFile(resolve(desktop, "public/helm.svg"));
  assert(source.equals(browser), "public/helm.svg differs from assets/helm.svg; regenerate icons");
  assert(/<svg\b/.test(source.toString("utf8")), "source is not an SVG");
});

await check("Windows installer branding", async () => {
  const config = JSON.parse(await readFile(resolve(desktop, "src-tauri/tauri.conf.json"), "utf8"));
  assert(
    config.bundle?.windows?.nsis?.installerIcon === "icons/icon.ico",
    "NSIS must use the application ICO for its installer",
  );
  assert(
    config.bundle?.windows?.nsis?.installerHooks === "nsis/branding.nsh",
    "NSIS must include the uninstaller branding hook",
  );
  await access(resolve(desktop, "src-tauri/nsis/branding.nsh"));
});

// The manifest records generated bytes so editing the SVG or an output requires regeneration.
await check("generated asset manifest", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(desktop, "assets/icon-manifest.json"), "utf8"),
  );
  const sha256 = (data) => createHash("sha256").update(data).digest("hex");
  assert(
    manifest.schemaVersion === 1 && manifest.generator === "tauri-cli",
    "unsupported manifest schema or generator",
  );
  assert(
    typeof manifest.generatorVersion === "string" && manifest.generatorVersion.length > 0,
    "missing generator version",
  );
  assert(manifest.source?.path === "assets/helm.svg", "unexpected manifest source path");
  assert(
    manifest.source.sha256 === sha256(await readFile(resolve(desktop, manifest.source.path))),
    "SVG source changed; run npm run icons:generate",
  );
  assert(
    manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files),
    "missing generated file hashes",
  );
  for (const required of [
    "public/helm.svg",
    "src-tauri/icons/32x32.png",
    "src-tauri/icons/64x64.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/128x128@2x.png",
    "src-tauri/icons/icon.png",
    "src-tauri/icons/icon.ico",
    "src-tauri/icons/icon.icns",
  ]) {
    assert(required in manifest.files, `manifest omits ${required}`);
  }
  for (const [path, expectedHash] of Object.entries(manifest.files)) {
    assert(
      (path === "public/helm.svg" || path.startsWith("src-tauri/icons/")) &&
        !path.split("/").includes(".."),
      `unexpected generated asset path ${path}`,
    );
    assert(
      typeof expectedHash === "string" && /^[a-f0-9]{64}$/.test(expectedHash),
      `invalid SHA256 for ${path}`,
    );
    assert(
      sha256(await readFile(resolve(desktop, path))) === expectedHash,
      `${path} changed; run npm run icons:generate`,
    );
  }
});

console.log(
  JSON.stringify(
    { ok: failures.length === 0, framesChecked: checked.length, frames: checked, failures },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
