import type {
  WorkspaceFileContents,
  WorkspaceFileEntry,
  WorkspaceFileMutationResult,
  WorkspaceFileTree,
} from "../contracts";
import type { MockWorkspaceState } from "../../mocks/mockData/state";
import { buildFiles } from "../../mocks/mockData/workspaceFixtures";
import {
  mockFileVersion,
  moduleNameFromMockRelativePath,
  normalizeMockWorkspacePath,
  parentPathsFor,
} from "./paths";

export function mockWorkspacePathExists(state: MockWorkspaceState, relativePath: string) {
  if (state.workspaceFiles[relativePath]) {
    return true;
  }
  if (buildFiles(state)[relativePath]) {
    return true;
  }
  return (
    Object.keys(buildFiles(state)).some((filePath) => filePath.startsWith(`${relativePath}/`)) ||
    Object.keys(state.workspaceFiles).some((filePath) => filePath.startsWith(`${relativePath}/`))
  );
}

export function mockWorkspaceDirectoryExists(state: MockWorkspaceState, relativePath: string) {
  if (!relativePath) {
    return true;
  }
  if (state.workspaceFiles[relativePath]?.kind === "directory") {
    return true;
  }
  return (
    Object.keys(buildFiles(state)).some((filePath) => filePath.startsWith(`${relativePath}/`)) ||
    Object.keys(state.workspaceFiles).some((filePath) => filePath.startsWith(`${relativePath}/`))
  );
}

export function moveMockWorkspacePath(
  state: MockWorkspaceState,
  sourceRelativePath: string,
  targetRelativePath: string,
) {
  let moved = false;
  const workspaceMoves = Object.entries(state.workspaceFiles).filter(
    ([relativePath]) =>
      relativePath === sourceRelativePath || relativePath.startsWith(`${sourceRelativePath}/`),
  );

  workspaceMoves.forEach(([relativePath]) => {
    delete state.workspaceFiles[relativePath];
  });
  workspaceMoves.forEach(([relativePath, entry]) => {
    const suffix =
      relativePath === sourceRelativePath ? "" : relativePath.slice(sourceRelativePath.length);
    state.workspaceFiles[`${targetRelativePath}${suffix}`] = { ...entry };
    moved = true;
  });

  state.extraModules.forEach((module) => {
    if (
      module.relativePath !== sourceRelativePath &&
      !module.relativePath.startsWith(`${sourceRelativePath}/`)
    ) {
      return;
    }

    const suffix =
      module.relativePath === sourceRelativePath
        ? ""
        : module.relativePath.slice(sourceRelativePath.length);
    module.relativePath = `${targetRelativePath}${suffix}`;
    module.moduleName = moduleNameFromMockRelativePath(module.relativePath);
    moved = true;
  });

  if (!moved) {
    throw new Error("Mock workspace can only move created workspace entries.");
  }
}

export function mockWorkspaceMoveResult(
  state: MockWorkspaceState,
  sourceRelativePath: string,
  targetRelativePath: string,
): WorkspaceFileMutationResult {
  const kind = mockWorkspaceDirectoryExists(state, targetRelativePath) ? "directory" : "file";
  return {
    relativePath: targetRelativePath,
    kind,
    changedRelativePaths:
      sourceRelativePath === targetRelativePath ? [] : [sourceRelativePath, targetRelativePath],
    file: kind === "file" ? readMockWorkspaceFile(state, targetRelativePath) : null,
  };
}

export function deleteMockWorkspacePath(state: MockWorkspaceState, relativePath: string) {
  const changedRelativePaths = new Set<string>([relativePath]);
  let deleted = false;

  Object.keys(state.workspaceFiles).forEach((candidate) => {
    if (candidate !== relativePath && !candidate.startsWith(`${relativePath}/`)) {
      return;
    }
    changedRelativePaths.add(candidate);
    delete state.workspaceFiles[candidate];
    deleted = true;
  });

  const nextExtraModules = state.extraModules.filter((module) => {
    if (
      module.relativePath !== relativePath &&
      !module.relativePath.startsWith(`${relativePath}/`)
    ) {
      return true;
    }
    changedRelativePaths.add(module.relativePath);
    deleted = true;
    return false;
  });
  state.extraModules = nextExtraModules;

  if (!deleted) {
    throw new Error("Mock workspace can only delete created workspace entries.");
  }

  return [...changedRelativePaths];
}

export function readMockWorkspaceFile(
  state: MockWorkspaceState,
  relativePath: string,
): WorkspaceFileContents {
  const normalized = normalizeMockWorkspacePath(relativePath);
  const workspaceEntry = state.workspaceFiles[normalized];
  if (workspaceEntry?.kind === "directory") {
    throw new Error(`Workspace path is not a file: ${normalized}`);
  }
  const content =
    workspaceEntry?.kind === "file"
      ? (workspaceEntry.content ?? "")
      : buildFiles(state)[normalized]?.content;
  if (content === undefined) {
    throw new Error(`Unknown workspace file requested: ${normalized}`);
  }

  return {
    relativePath: normalized,
    name: normalized.split("/").pop() ?? normalized,
    kind: "file",
    sizeBytes: new TextEncoder().encode(content).length,
    editable: true,
    reason: null,
    content,
    version: mockFileVersion(content),
    modifiedAt: 0,
  };
}

export function readMockWorkspaceFileIfAvailable(
  state: MockWorkspaceState,
  relativePath: string,
): WorkspaceFileContents | undefined {
  try {
    return readMockWorkspaceFile(state, relativePath);
  } catch {
    return undefined;
  }
}

export function mockWorkspaceAffectedPaths(
  state: MockWorkspaceState,
  relativePath: string,
): string[] {
  const paths = new Set<string>([relativePath]);
  Object.keys(state.workspaceFiles).forEach((candidate) => {
    if (candidate === relativePath || candidate.startsWith(`${relativePath}/`)) {
      paths.add(candidate);
    }
  });
  Object.keys(buildFiles(state)).forEach((candidate) => {
    if (candidate === relativePath || candidate.startsWith(`${relativePath}/`)) {
      paths.add(candidate);
    }
  });
  return [...paths].sort();
}

export function buildMockWorkspaceFileTree(
  repoPath: string,
  state: MockWorkspaceState,
): WorkspaceFileTree {
  const entriesByPath = new Map<string, WorkspaceFileEntry>();

  const addDirectory = (relativePath: string) => {
    if (entriesByPath.has(relativePath)) {
      return;
    }
    entriesByPath.set(relativePath, {
      relativePath,
      name: relativePath.split("/").pop() ?? relativePath,
      kind: "directory",
      sizeBytes: null,
      editable: false,
      reason: "Directories are shown in the explorer.",
      modifiedAt: 0,
    });
  };

  const addFile = (relativePath: string, content: string) => {
    parentPathsFor(relativePath).forEach(addDirectory);
    entriesByPath.set(relativePath, {
      relativePath,
      name: relativePath.split("/").pop() ?? relativePath,
      kind: "file",
      sizeBytes: new TextEncoder().encode(content).length,
      editable: true,
      reason: null,
      modifiedAt: 0,
    });
  };

  Object.entries(buildFiles(state)).forEach(([relativePath, file]) => {
    addFile(relativePath, file.content);
  });

  Object.entries(state.workspaceFiles).forEach(([relativePath, entry]) => {
    parentPathsFor(relativePath).forEach(addDirectory);
    if (entry.kind === "directory") {
      addDirectory(relativePath);
    } else {
      addFile(relativePath, entry.content ?? "");
    }
  });

  const entries = [...entriesByPath.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });

  return {
    rootPath: repoPath,
    entries,
    truncated: false,
  };
}
