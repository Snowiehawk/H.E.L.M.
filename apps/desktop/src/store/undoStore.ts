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
  canRedo?: () => boolean;
  redo?: () => Promise<UndoResult | void> | UndoResult | void;
  ownsFocus?: () => boolean;
  peekEntry?: () => UndoEntry | undefined;
  peekRedoEntry?: () => UndoEntry | undefined;
}

interface UndoState {
  sessionKey?: string;
  registrations: Partial<Record<UndoDomainId, UndoDomainRegistration>>;
  resetSession: (sessionKey?: string) => void;
  registerDomain: (domain: UndoDomainId, registration: UndoDomainRegistration) => () => void;
  getPreferredUndoDomain: () => UndoDomainId | undefined;
  getPreferredRedoDomain: () => UndoDomainId | undefined;
  performUndo: () => Promise<UndoResult | undefined>;
  performRedo: () => Promise<UndoResult | undefined>;
}

function latestHistoryDomain(
  registrations: Partial<Record<UndoDomainId, UndoDomainRegistration>>,
  options: {
    canPerform: (registration: UndoDomainRegistration) => boolean;
    peekEntry: (registration: UndoDomainRegistration) => UndoEntry | undefined;
  },
): UndoDomainId | undefined {
  const domains = (["layout", "backend"] as const)
    .flatMap((domain) => {
      const registration = registrations[domain];
      if (!registration || !options.canPerform(registration)) {
        return [];
      }

      const entry = options.peekEntry(registration);
      if (!entry) {
        return [];
      }

      return [{ domain, createdAt: entry.createdAt }];
    })
    .sort((left, right) => right.createdAt - left.createdAt);

  return domains[0]?.domain;
}

function latestUndoDomain(
  registrations: Partial<Record<UndoDomainId, UndoDomainRegistration>>,
): UndoDomainId | undefined {
  return latestHistoryDomain(registrations, {
    canPerform: (registration) => registration.canUndo(),
    peekEntry: (registration) => registration.peekEntry?.(),
  });
}

function latestRedoDomain(
  registrations: Partial<Record<UndoDomainId, UndoDomainRegistration>>,
): UndoDomainId | undefined {
  return latestHistoryDomain(registrations, {
    canPerform: (registration) => Boolean(registration.canRedo?.()),
    peekEntry: (registration) => registration.peekRedoEntry?.(),
  });
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
  getPreferredRedoDomain: () => {
    const registrations = get().registrations;
    const editor = registrations.editor;
    if (editor && editor.canRedo?.() && (editor.ownsFocus?.() ?? true)) {
      return "editor";
    }

    return latestRedoDomain(registrations);
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
  performRedo: async () => {
    const domain = get().getPreferredRedoDomain();
    if (!domain) {
      return undefined;
    }

    const registration = get().registrations[domain];
    if (!registration || !registration.canRedo?.() || !registration.redo) {
      return undefined;
    }

    const result = await registration.redo();
    if (result) {
      return result;
    }

    return {
      domain,
      handled: true,
    };
  },
}));
