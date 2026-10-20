import { createHash } from "node:crypto";
import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const source = "assets/helm.svg";
const icons = join(desktop, "src-tauri/icons");
const cli = join(desktop, "node_modules/@tauri-apps/cli");
const result = spawnSync(
  process.execPath,
  [join(cli, "tauri.js"), "icon", source, "--output", "src-tauri/icons"],
  { cwd: desktop, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Tauri emits ICNS chunks from a hash map. Keep their payloads unchanged but
// order them by type so identical source/CLI versions produce identical bytes.
const icnsPath = join(icons, "icon.icns");
const icns = readFileSync(icnsPath);
if (icns.toString("ascii", 0, 4) !== "icns" || icns.readUInt32BE(4) !== icns.length) {
  throw new Error("Invalid generated ICNS header");
}
const chunks = [];
for (let offset = 8; offset < icns.length; ) {
  const length = icns.readUInt32BE(offset + 4);
  if (length < 8 || offset + length > icns.length) {
    throw new Error("Invalid generated ICNS chunk");
  }
  chunks.push(icns.subarray(offset, offset + length));
  offset += length;
}
chunks.sort((a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)));
writeFileSync(icnsPath, Buffer.concat([icns.subarray(0, 8), ...chunks]));

// This obsolete, cropped raster was never the source of the bundled icons.
// Remove it so future updates always start from the complete vector master.
rmSync(join(icons, "app-icon-source.png"), { force: true });
copyFileSync(join(desktop, source), join(desktop, "public/helm.svg"));
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function collect(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collect(path) : [path];
    });
}
const files = [...collect(icons), join(desktop, "public/helm.svg")];
const manifest = {
  schemaVersion: 1,
  generator: "tauri-cli",
  generatorVersion: JSON.parse(readFileSync(join(cli, "package.json"), "utf8")).version,
  source: { path: source, sha256: digest(join(desktop, source)) },
  files: Object.fromEntries(
    files.map((path) => [relative(desktop, path).split("\\").join("/"), digest(path)]),
  ),
};
writeFileSync(
  join(dirname(join(desktop, source)), "icon-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`Generated ${files.length} icon assets from ${source}.`);
