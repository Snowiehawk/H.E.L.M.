/** Metadata only: never put commands, environment names or private values here. */
export interface ConfigurationDraftState {
  available: boolean;
  dirty: boolean;
  busy: boolean;
}

export interface ConfigurationDraftSnapshot extends ConfigurationDraftState {
  revision: number;
}

/** Separate instances let regression tests exercise admission without resetting a live gate. */
export function createConfigurationDraftRegistry() {
  let revision = 0;
  let freezes = 0;
  const owners = new Map<symbol, { mounted: boolean; state: ConfigurationDraftState }>();
  return {
    read(): ConfigurationDraftSnapshot {
      const entries = [...owners.values()];
      return {
        available: entries.every((entry) => entry.mounted && entry.state.available),
        dirty: entries.some((entry) => entry.state.dirty),
        busy: entries.some((entry) => entry.state.busy),
        revision,
      };
    },
    register(initial: ConfigurationDraftState) {
      const key = Symbol("run configuration editor");
      const entry = {
        mounted: true,
        state: { available: initial.available, dirty: initial.dirty, busy: initial.busy },
      };
      owners.set(key, entry);
      revision += 1;
      return {
        update(next: ConfigurationDraftState) {
          // Advance even when dirty was already true: edits and dirty/clean ABA
          // must invalidate a lifetime snapshot taken before an await.
          entry.state = { available: next.available, dirty: next.dirty, busy: next.busy };
          revision += 1;
          if (!entry.mounted && !next.dirty && !next.busy) owners.delete(key);
        },
        unregister() {
          if (!entry.mounted) return;
          entry.mounted = false;
          revision += 1;
          // Unexpected unmount is not explicit Save/Cancel. Keep an unavailable
          // tombstone rather than claiming that lost or unfinished drafts are clean.
          if (!entry.state.dirty && !entry.state.busy) owners.delete(key);
        },
      };
    },
    freeze() {
      freezes += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        freezes -= 1;
      };
    },
    assertAdmission() {
      if (freezes)
        throw new Error(
          "Configuration admission is frozen. Finish the current operation before saving run settings or private values.",
        );
    },
  };
}

const registry = createConfigurationDraftRegistry();
export const readConfigurationDraftSnapshot = () => registry.read();
export const registerConfigurationDraftOwner = (initial: ConfigurationDraftState) =>
  registry.register(initial);
export const freezeConfigurationDraftAdmission = () => registry.freeze();
export const assertConfigurationDraftAdmission = () => registry.assertAdmission();
