import type { DesktopAdapter } from "../lib/adapter/contracts";

let started = 0;
let active = 0;
let installationFreeze: symbol | undefined;
let authoritativeSavePermit: symbol | undefined;
const adapters = new WeakMap<DesktopAdapter, DesktopAdapter>();
const mutations = new Set<PropertyKey>([
  "applyStructuralEdit",
  "saveNodeSource",
  "applyBackendUndo",
  "saveWorkspaceFile",
  "createWorkspaceEntry",
  "moveWorkspaceEntry",
  "deleteWorkspaceEntry",
  "openRepo",
  "startIndex",
  "createProject",
]);

export const workspaceMutationState = () => ({ started, active });

export const isWorkspaceInstallationFrozen = () => installationFreeze !== undefined;

export function assertWorkspaceMutationAdmission(method?: PropertyKey) {
  const authoritativeSave =
    authoritativeSavePermit === installationFreeze &&
    (method === "saveNodeSource" || method === "saveWorkspaceFile");
  if (installationFreeze && !authoritativeSave)
    throw new Error(
      "Workspace admission is frozen. This operation was refused; retry after it finishes.",
    );
}

export interface WorkspaceInstallationFreeze {
  /** Permit only the authoritative save's synchronous adapter admission. */
  save<T>(operation: () => Promise<T>): Promise<T>;
  release(): void;
}

export function freezeWorkspaceMutationAdmission(): WorkspaceInstallationFreeze {
  if (installationFreeze) throw new Error("Workspace admission is already frozen.");
  const owner = Symbol("workspace-admission");
  installationFreeze = owner;
  // A workspace lifetime fence invalidates pending renderer callbacks even when
  // it later refuses and the workspace becomes editable again (admission ABA).
  started += 1;
  return {
    save: async <T>(operation: () => Promise<T>) => {
      if (installationFreeze !== owner) throw new Error("Workspace save admission expired.");
      let result: Promise<T>;
      authoritativeSavePermit = owner;
      try {
        result = operation();
      } finally {
        // A delayed/background callback cannot inherit another operation's save grant.
        authoritativeSavePermit = undefined;
      }
      return await result;
    },
    release: () => {
      if (installationFreeze === owner) {
        installationFreeze = undefined;
        authoritativeSavePermit = undefined;
        started += 1;
      }
    },
  };
}

/** One shared fence covers editor, graph, file, and Undo owners. */
export function trackDesktopMutations(adapter: DesktopAdapter): DesktopAdapter {
  const existing = adapters.get(adapter);
  if (existing) return existing;
  const methods = new Map<PropertyKey, unknown>();
  const tracked = new Proxy(adapter, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      if (!methods.has(property)) {
        methods.set(
          property,
          mutations.has(property)
            ? async (...args: unknown[]) => {
                assertWorkspaceMutationAdmission(property);
                started += 1;
                active += 1;
                try {
                  return await Reflect.apply(member, target, args);
                } finally {
                  active -= 1;
                }
              }
            : member.bind(target),
        );
      }
      return methods.get(property);
    },
  });
  adapters.set(adapter, tracked);
  return tracked;
}
