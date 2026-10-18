import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const script = fileURLToPath(
  new URL("../../../scripts/package_desktop_backend.py", import.meta.url),
);
const python =
  process.env.HELM_BUILD_PYTHON ||
  process.env.HELM_PYTHON_BIN ||
  (process.platform === "win32" ? "python" : "python3");
const args = [script];
if (process.platform === "win32") {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (process.arch !== "x64" || (triple && !triple.startsWith("x86_64-"))) {
    throw new Error("The pinned embedded Windows runtime requires an x86_64 Windows target.");
  }
  args.push("--windows-x64");
}
if (process.platform === "darwin" && process.arch === "arm64") {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (triple && !triple.startsWith("aarch64-")) {
    throw new Error("The pinned Mac runtime requires an aarch64 macOS target.");
  }
  args.push("--macos-arm64");
}
const result = spawnSync(python, args, { stdio: "inherit", shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
