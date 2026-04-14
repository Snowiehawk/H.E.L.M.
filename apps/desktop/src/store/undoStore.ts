import { create } from "zustand";

export type UndoDomainId = "editor" | "layout" | "backend";

export interface UndoEntry {
  domain: UndoDomainId;
  summary: string;
  createdAt: number;
}

export interface UndoResult {
  domain: UndoDomainId;
  handled: boolean;
  summary?: string;
}

export interface UndoDomainRegistration {
  canUndo: () => boolean;
  undo: () => Promise<UndoResult | void> | UndoResult | void;
  ownsFocus?: () => boolean;
  peekEntry?: () => UndoEntry | undefined;
}

interface UndoState {
  sessionKey?: string;
  registrations: Partial<Record<UndoDomainId, UndoDomainRegistration>>;
  resetSession: (sessionKey?: string) => void;
  registerDomain: (
    domain: UndoDomainId,
    registration: UndoDomainRegistration,
  ) => () => void;
  getPreferredUndoDomain: () => UndoDomainId | undefined;
  performUndo: () => Promise<UndoResult | undefined>;
}

function latestUndoDomain(
  registrations: Partial<Record<UndoDomainId, UndoDomainRegistration>>,
): UndoDomainId | undefined {
  const domains = (["layout", "backend"] as const)
    .flatMap((domain) => {
      const registration = registrations[domain];
      if (!registration || !registration.canUndo()) {
        return [];
      }

      const entry = registration.peekEntry?.();
      if (!entry) {
        return [];
      }

      return [{ domain, createdAt: entry.createdAt }];
    })
    .sort((left, right) => right.createdAt - left.createdAt);

  return domains[0]?.domain;
}

export const useUndoStore = create<UndoState>((set, get) => ({
  sessionKey: undefined,
  registrations: {},
  resetSession: (sessionKey) =>
    set((state) => {
      if (state.sessionKey === sessionKey && sessionKey !== undefined) {
        return state;
      }

      return {
        sessionKey,
        registrations: {},
      };
    }),
  registerDomain: (domain, registration) => {
    set((state) => ({
      registrations: {
        ...state.registrations,
        [domain]: registration,
      },
    }));

    return () =>
      set((state) => {
        if (state.registrations[domain] !== registration) {
          return state;
        }

        const nextRegistrations = { ...state.registrations };
        delete nextRegistrations[domain];
        return { registrations: nextRegistrations };
      });
  },
  getPreferredUndoDomain: () => {
    const registrations = get().registrations;
    const editor = registrations.editor;
    if (editor && editor.canUndo() && (editor.ownsFocus?.() ?? true)) {
      return "editor";
    }

    return latestUndoDomain(registrations);
  },
  performUndo: async () => {
    const domain = get().getPreferredUndoDomain();
    if (!domain) {
      return undefined;
    }

    const registration = get().registrations[domain];
    if (!registration || !registration.canUndo()) {
      return undefined;
    }

    const result = await registration.undo();
    if (result) {
      return result;
    }

    return {
      domain,
      handled: true,
    };
  },
}));
