export function normalizeMockWorkspacePath(relativePath: string) {
  const normalized = relativePath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Repo-relative paths must stay inside the workspace.");
  }
  return parts.join("/");
}

export function normalizeMockDirectoryPath(relativePath: string) {
  const normalized = relativePath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) {
    return "";
  }
  return normalizeMockWorkspacePath(normalized);
}

export function joinMockWorkspacePath(directoryPath: string, name: string) {
  return directoryPath ? `${directoryPath}/${name}` : name;
}

export function parentPathsFor(relativePath: string) {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function mockFileVersion(content: string) {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) - hash + content.charCodeAt(index)) | 0;
  }
  return `mock:${content.length}:${hash >>> 0}`;
}

export function moduleNameFromMockRelativePath(relativePath: string) {
  return relativePath.replace(/\.py$/, "").replaceAll("/", ".");
}
