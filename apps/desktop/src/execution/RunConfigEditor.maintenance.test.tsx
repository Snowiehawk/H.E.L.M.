import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfigEditor, type RunConfigEditorProps } from "./RunConfigEditor";
import { newRunConfig } from "./contracts";
import {
  createConfigurationDraftRegistry,
  freezeConfigurationDraftAdmission,
  readConfigurationDraftSnapshot,
} from "./configurationDrafts";

const state = vi.hoisted(() => ({
  registry: undefined as
    | ReturnType<typeof import("./configurationDrafts").createConfigurationDraftRegistry>
    | undefined,
}));
vi.mock("./configurationDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./configurationDrafts")>();
  return {
    ...actual,
    registerConfigurationDraftOwner: (
      initial: Parameters<typeof actual.registerConfigurationDraftOwner>[0],
    ) => state.registry!.register(initial),
    readConfigurationDraftSnapshot: () => state.registry!.read(),
    freezeConfigurationDraftAdmission: () => state.registry!.freeze(),
    assertConfigurationDraftAdmission: () => state.registry!.assertAdmission(),
  };
});

function setup(overrides: Partial<RunConfigEditorProps> = {}) {
  const props: RunConfigEditorProps = {
    document: {
      schemaVersion: 1,
      revision: 7,
      defaultId: "app",
      configs: [{ ...newRunConfig("app"), executable: "python3", secretNames: ["TOKEN"] }],
    },
    suggestions: [],
    trusted: true,
    onSave: vi.fn().mockResolvedValue(undefined),
    onSecrets: vi.fn().mockResolvedValue(undefined),
    onImportEnv: vi.fn().mockResolvedValue(["IMPORTED_TOKEN"]),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<RunConfigEditor {...props} />), props };
}

describe("run settings passive lifetime owner", () => {
  beforeEach(() => {
    // Each test uses an isolated registry; no production/live gate is reset.
    state.registry = createConfigurationDraftRegistry();
  });

  it("publishes ref edit epochs without exposing values and resolves on explicit Cancel", () => {
    const { unmount } = setup();
    expect(readConfigurationDraftSnapshot()).toMatchObject({
      available: true,
      dirty: false,
      busy: false,
    });
    const initial = readConfigurationDraftSnapshot().revision;
    fireEvent.change(screen.getByLabelText("TOKEN"), {
      target: { value: "private-synthetic-sentinel" },
    });
    const edited = readConfigurationDraftSnapshot();
    expect(edited.dirty).toBe(true);
    expect(edited.revision).toBeGreaterThan(initial);
    expect(JSON.stringify(edited)).not.toContain("private-synthetic-sentinel");
    expect(JSON.stringify(edited)).not.toContain("TOKEN");
    fireEvent.change(screen.getByLabelText("TOKEN"), { target: { value: "second-sentinel" } });
    expect(readConfigurationDraftSnapshot().revision).toBeGreaterThan(edited.revision);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    unmount();
    expect(readConfigurationDraftSnapshot()).toMatchObject({
      available: true,
      dirty: false,
      busy: false,
    });
  });

  it("retains edits during install freeze but admits no save, import or private callback", async () => {
    const { props } = setup();
    const release = freezeConfigurationDraftAdmission();
    try {
      const initial = readConfigurationDraftSnapshot().revision;
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retained draft" } });
      fireEvent.change(screen.getByLabelText("TOKEN"), { target: { value: "retained-private" } });
      fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply private values" }));
      fireEvent.click(screen.getByRole("button", { name: "Import private values" }));
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
      expect(props.onSave).not.toHaveBeenCalled();
      expect(props.onSecrets).not.toHaveBeenCalled();
      expect(props.onImportEnv).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Name")).toHaveValue("Retained draft");
      expect(screen.getByLabelText("TOKEN")).toHaveValue("retained-private");
      expect(readConfigurationDraftSnapshot()).toMatchObject({ dirty: true, busy: false });
      expect(readConfigurationDraftSnapshot().revision).toBeGreaterThan(initial);
    } finally {
      release();
    }
  });

  it("tracks import and configuration save until the exact async operation finishes", async () => {
    let finishImport!: (names: string[]) => void;
    let finishSave!: () => void;
    const { props, unmount } = setup({
      onImportEnv: vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            finishImport = resolve;
          }),
      ),
      onSave: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }),
      ),
    });
    fireEvent.change(screen.getByLabelText("Private .env path (relative to checkout)"), {
      target: { value: "config/private.env" },
    });
    expect(readConfigurationDraftSnapshot().dirty).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Import private values" }));
    expect(readConfigurationDraftSnapshot()).toMatchObject({ dirty: true, busy: true });
    await act(async () => {
      finishImport(["IMPORTED_TOKEN"]);
    });
    expect(readConfigurationDraftSnapshot()).toMatchObject({ dirty: true, busy: false });
    expect(screen.getByLabelText("Private environment names")).toHaveValue("TOKEN\nIMPORTED_TOKEN");
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(readConfigurationDraftSnapshot().busy).toBe(true);
    await act(async () => {
      finishSave();
    });
    expect(props.onClose).toHaveBeenCalledOnce();
    unmount();
    expect(readConfigurationDraftSnapshot()).toMatchObject({
      available: true,
      dirty: false,
      busy: false,
    });
  });

  it("revalidates the fence after awaits and preserves a private buffer on refusal", async () => {
    let finish!: () => void;
    setup({
      onSecrets: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    fireEvent.change(screen.getByLabelText("TOKEN"), { target: { value: "retained-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply private values" }));
    expect(readConfigurationDraftSnapshot().busy).toBe(true);
    const release = freezeConfigurationDraftAdmission();
    try {
      await act(async () => {
        finish();
      });
      expect(screen.getByRole("alert")).toHaveTextContent("Private values could not be updated");
      expect(screen.getByLabelText("TOKEN")).toHaveValue("retained-value");
      expect(readConfigurationDraftSnapshot()).toMatchObject({ dirty: true, busy: false });
    } finally {
      release();
    }
  });

  it("refuses stale/unmounted owners and never treats a lost dirty form as clean", () => {
    const { props, rerender, unmount } = setup();
    rerender(<RunConfigEditor {...props} document={{ ...props.document, revision: 8 }} />);
    expect(readConfigurationDraftSnapshot().available).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved" } });
    unmount();
    expect(readConfigurationDraftSnapshot()).toMatchObject({
      available: false,
      dirty: true,
      busy: false,
    });
  });

  it("does not apply a delayed import result after trust is revoked", async () => {
    let finish!: (names: string[]) => void;
    const { props, rerender } = setup({
      onImportEnv: vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "Import private values" }));
    rerender(<RunConfigEditor {...props} trusted={false} />);
    await act(async () => {
      finish(["STALE_TOKEN"]);
    });
    expect(screen.getByLabelText("Private environment names")).toHaveValue("TOKEN");
    expect(readConfigurationDraftSnapshot().busy).toBe(false);
    expect(screen.queryByText(/Imported 1 private variable/)).not.toBeInTheDocument();
  });

  it("retains a failed save until explicit cancellation", async () => {
    let fail!: (reason: Error) => void;
    const { props, unmount } = setup({
      onSave: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      ),
    });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retained name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(readConfigurationDraftSnapshot()).toMatchObject({ dirty: true, busy: true });
    expect(props.onSave).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(props.onSave).toHaveBeenCalledOnce();
    await act(async () => {
      fail(new Error("Synthetic storage refusal"));
    });
    expect(readConfigurationDraftSnapshot()).toMatchObject({ dirty: true, busy: false });
    expect(screen.getByLabelText("Name")).toHaveValue("Retained name");
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    unmount();
    expect(readConfigurationDraftSnapshot()).toMatchObject({
      available: true,
      dirty: false,
      busy: false,
    });
  });

  it("keeps a pending owner's unexpected unmount unavailable after its promise settles", async () => {
    let finish!: () => void;
    const { props, unmount } = setup({
      onSecrets: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    fireEvent.change(screen.getByLabelText("TOKEN"), { target: { value: "pending-private" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply private values" }));
    unmount();
    await act(async () => {
      finish();
    });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(readConfigurationDraftSnapshot()).toMatchObject({
      available: false,
      dirty: true,
      busy: true,
    });
  });
});
