import { describe, expect, it } from "vitest";
import { createConfigurationDraftRegistry } from "./configurationDrafts";

const clean = { available: true, dirty: false, busy: false };

describe("configuration maintenance metadata", () => {
  it("is passive, metadata-only, and advances through dirty/clean ABA and owner replacement", () => {
    const registry = createConfigurationDraftRegistry();
    expect(registry.read()).toEqual({ ...clean, revision: 0 });
    const owner = registry.register(clean);
    const initial = registry.read();
    expect(registry.read()).toEqual(initial);
    owner.update({ ...clean, dirty: true });
    const firstEdit = registry.read();
    owner.update({ ...clean, dirty: true });
    expect(registry.read().revision).toBeGreaterThan(firstEdit.revision);
    owner.update(clean);
    expect(registry.read()).toMatchObject(clean);
    expect(registry.read().revision).toBeGreaterThan(initial.revision);
    owner.unregister();
    const closed = registry.read().revision;
    registry.register(clean).unregister();
    expect(registry.read().revision).toBeGreaterThan(closed);
    expect(Object.keys(registry.read()).sort()).toEqual(["available", "busy", "dirty", "revision"]);
  });

  it("keeps dirty or pending unmount unavailable until its exact owner explicitly resolves", () => {
    const registry = createConfigurationDraftRegistry();
    const dirty = registry.register({ ...clean, dirty: true });
    const pending = registry.register({ ...clean, busy: true });
    dirty.unregister();
    pending.unregister();
    expect(registry.read()).toMatchObject({ available: false, dirty: true, busy: true });
    // A different editor cannot silently clear another owner's retained state.
    registry.register(clean).unregister();
    expect(registry.read()).toMatchObject({ available: false, dirty: true, busy: true });
    dirty.update(clean);
    expect(registry.read()).toMatchObject({ available: false, dirty: false, busy: true });
    pending.update(clean);
    expect(registry.read()).toMatchObject(clean);
  });

  it("supports overlapping lifetime fences without a release reopening another owner's fence", () => {
    const registry = createConfigurationDraftRegistry();
    const releaseFirst = registry.freeze();
    const releaseSecond = registry.freeze();
    expect(() => registry.assertAdmission()).toThrow("admission is frozen");
    const owner = registry.register(clean);
    owner.update({ ...clean, dirty: true });
    expect(registry.read().dirty).toBe(true);
    releaseFirst();
    releaseFirst();
    expect(() => registry.assertAdmission()).toThrow("admission is frozen");
    releaseSecond();
    expect(() => registry.assertAdmission()).not.toThrow();
    owner.unregister();
    expect(registry.read().available).toBe(false);
  });
});
