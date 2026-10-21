import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { newRunConfig, type RunConfigDocument } from "./contracts";
import { RunConfigEditor, type RunConfigEditorProps } from "./RunConfigEditor";

function fixture(): RunConfigDocument {
  return {
    schemaVersion: 1,
    revision: 7,
    defaultId: "app",
    configs: [{ ...newRunConfig("app"), executable: "python3", args: ["main.py"], cwd: "src Ω" }],
  };
}
function setup(overrides: Partial<RunConfigEditorProps> = {}) {
  const props: RunConfigEditorProps = {
    document: fixture(),
    suggestions: [],
    trusted: true,
    onSave: vi.fn().mockResolvedValue(undefined),
    onSecrets: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(<RunConfigEditor {...props} />);
  return { ...view, props };
}
describe("passive run configuration editor", () => {
  it("deleting the selected default explicitly saves No default and keeps other IDs", async () => {
    const record = fixture();
    record.configs.push({
      ...newRunConfig("second"),
      name: record.configs[0].name,
      executable: "python3",
    });
    const { props } = setup({ document: record });
    fireEvent.click(screen.getByRole("button", { name: "Delete configuration" }));
    expect(screen.getByLabelText("Default configuration")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultId: null,
        configs: [expect.objectContaining({ id: "second", name: "App" })],
      }),
    );
    expect(record.defaultId).toBe("app");
    expect(record.configs).toHaveLength(2);
  });
  it("Cancel discards nonsecret, private and import-path drafts without callbacks or persistence", () => {
    const record = fixture();
    record.configs[0].secretNames = ["TOKEN"];
    const importEnv = vi.fn();
    const { props, unmount } = setup({ document: record, onImportEnv: importEnv });
    const original = JSON.stringify(record);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Discarded name" } });
    fireEvent.change(screen.getByLabelText("TOKEN"), {
      target: { value: "synthetic-cancel-secret" },
    });
    fireEvent.change(screen.getByLabelText("Private .env path (relative to checkout)"), {
      target: { value: "cancel-this.env" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onSecrets).not.toHaveBeenCalled();
    expect(importEnv).not.toHaveBeenCalled();
    expect(JSON.stringify(record)).toBe(original);
    unmount();
    setup({ document: record, onImportEnv: importEnv });
    expect(screen.getByLabelText("TOKEN")).toHaveValue("");
    expect(screen.getByLabelText("Private .env path (relative to checkout)")).toHaveValue(".env");
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-cancel-secret");
  });
  it("private import errors expose no values and clear uses explicit nulls without config save", async () => {
    const record = fixture();
    record.configs[0].secretNames = ["TOKEN"];
    const { props } = setup({
      document: record,
      onImportEnv: vi.fn().mockRejectedValue(new Error("synthetic-import-private-sentinel")),
    });
    fireEvent.click(screen.getByRole("button", { name: "Import private values" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "synthetic-import-private-sentinel",
    );
    expect(screen.getByLabelText("Private environment names")).toHaveValue("TOKEN");
    fireEvent.change(screen.getByLabelText("TOKEN"), {
      target: { value: "synthetic-cleared-buffer" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Clear private/ }));
    await screen.findByText("Private values cleared for this configuration.");
    expect(props.onSecrets).toHaveBeenCalledWith("app", { TOKEN: null });
    expect(screen.getByLabelText("TOKEN")).toHaveValue("");
    expect(props.onSave).not.toHaveBeenCalled();
    expect(JSON.stringify(record)).not.toContain("synthetic-cleared-buffer");
    expect(document.body.textContent).not.toContain("synthetic-import-private-sentinel");
  });
  it("restores a named default and saves arguments without shell splitting", async () => {
    const { props } = setup();
    expect(screen.getByLabelText("Default configuration")).toHaveValue("app");
    fireEvent.change(screen.getByLabelText("Arguments (JSON array)"), {
      target: { value: '["main.py", "two words", "Ω"]' },
    });
    fireEvent.change(screen.getByLabelText("Nonsecret environment (JSON object)"), {
      target: { value: '{"MODE":"test", "REMOVE":null}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 7,
        defaultId: "app",
        configs: [
          expect.objectContaining({
            args: ["main.py", "two words", "Ω"],
            cwd: "src Ω",
            env: { MODE: "test", REMOVE: null },
          }),
        ],
      }),
    );
    expect(props.onSecrets).not.toHaveBeenCalled();
  });
  it("retains invalid argv and a failed save draft without changing saved settings", async () => {
    const { props } = setup({
      onSave: vi.fn().mockRejectedValue(new Error("Storage is read-only")),
    });
    fireEvent.change(screen.getByLabelText("Arguments (JSON array)"), {
      target: { value: "python main.py" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("arguments must be a JSON array");
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Arguments (JSON array)"), {
      target: { value: '["changed.py"]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage is read-only");
    expect(screen.getByLabelText("Arguments (JSON array)")).toHaveValue('["changed.py"]');
    expect(props.document.configs[0].args).toEqual(["main.py"]);
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it("supports add, duplicate, delete and explicit defaults with stable distinct IDs", async () => {
    const { props } = setup();
    fireEvent.change(screen.getByLabelText("Arguments (JSON array)"), {
      target: { value: '["unsaved argument"]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tests" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "tests" } });
    const duplicateId = (screen.getByLabelText("Configuration") as HTMLSelectElement).value;
    expect(duplicateId).not.toBe("app");
    fireEvent.change(screen.getByLabelText("Default configuration"), {
      target: { value: duplicateId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultId: duplicateId,
        configs: [
          expect.objectContaining({ id: "app" }),
          expect.objectContaining({
            id: duplicateId,
            name: "Tests",
            kind: "tests",
            args: ["unsaved argument"],
          }),
        ],
      }),
    );
  });
  it("copies passive suggestions into editable drafts without saving on selection", async () => {
    const suggestion = {
      source: "web/package.json scripts.dev",
      config: {
        ...newRunConfig("suggestion"),
        name: "Web dev",
        executable: "npm",
        args: ["run", "dev"],
        cwd: "web",
      },
    };
    const { props } = setup({ suggestions: [suggestion] });
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onSecrets).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion Web dev" }));
    expect(screen.getByLabelText("Executable or interpreter")).toHaveValue("npm");
    expect(screen.getByLabelText("Working directory")).toHaveValue("web");
    fireEvent.change(screen.getByLabelText("Executable or interpreter"), {
      target: { value: "/selected/npm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        configs: [
          expect.objectContaining({ id: "app", executable: "python3" }),
          expect.objectContaining({ executable: "/selected/npm", args: ["run", "dev"] }),
        ],
      }),
    );
    expect(suggestion.config.executable).toBe("npm");
  });
  it("validates private names and keeps values out of configuration save", async () => {
    const record = fixture();
    record.configs[0].secretNames = ["API_KEY"];
    const { props } = setup({ document: record });
    const privateInput = screen.getByLabelText("API_KEY");
    expect(privateInput).toHaveAttribute("type", "password");
    fireEvent.change(privateInput, { target: { value: "synthetic-private-sentinel" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply private values" }));
    await screen.findByText("Private values updated for this session.");
    expect(props.onSecrets).toHaveBeenCalledWith("app", { API_KEY: "synthetic-private-sentinel" });
    expect(privateInput).toHaveValue("");
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Nonsecret environment (JSON object)"), {
      target: { value: '{"API_KEY":"not-allowed"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "private variable cannot also have a nonsecret override",
    );
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it("requires trust and hides errors from private value callbacks", async () => {
    const record = fixture();
    record.configs[0].secretNames = ["TOKEN"];
    const { props, rerender } = setup({
      document: record,
      trusted: false,
      onSecrets: vi.fn().mockRejectedValue(new Error("sensitive synthetic string")),
    });
    expect(screen.getByLabelText("TOKEN")).toBeDisabled();
    rerender(<RunConfigEditor {...props} trusted />);
    fireEvent.change(screen.getByLabelText("TOKEN"), { target: { value: "synthetic-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply private values" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Private values could not be updated",
    );
    expect(screen.queryByText(/sensitive synthetic string/)).not.toBeInTheDocument();
  });
  it("refuses stale revisions and Cancel preserves saved settings", () => {
    const { props, rerender } = setup();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed draft" } });
    rerender(<RunConfigEditor {...props} document={{ ...props.document, revision: 8 }} />);
    expect(screen.getByRole("button", { name: "Save configurations" })).toBeDisabled();
    expect(screen.getByLabelText("Name")).toHaveValue("Changed draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.document.configs[0].name).toBe("App");
  });
  it("rejects invalid cwd/environment and switches to explicit shell mode deliberately", async () => {
    const { props } = setup();
    fireEvent.change(screen.getByLabelText("Working directory"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("working directory is required");
    fireEvent.change(screen.getByLabelText("Working directory"), { target: { value: "." } });
    fireEvent.change(screen.getByLabelText("Nonsecret environment (JSON object)"), {
      target: { value: '{"BAD-NAME":"value"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("environment names must be valid");
    fireEvent.change(screen.getByLabelText("Nonsecret environment (JSON object)"), {
      target: { value: "{}" },
    });
    fireEvent.change(screen.getByLabelText("Command mode"), { target: { value: "shell" } });
    fireEvent.change(screen.getByLabelText("System shell command"), {
      target: { value: "npm run test && npm run build" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        configs: [
          expect.objectContaining({ mode: "shell", command: "npm run test && npm run build" }),
        ],
      }),
    );
  });
  it("clears unsubmitted private buffers on trust revocation and cancels with Escape", () => {
    const record = fixture();
    record.configs[0].secretNames = ["TOKEN"];
    const { props, rerender } = setup({ document: record });
    fireEvent.change(screen.getByLabelText("TOKEN"), { target: { value: "synthetic-buffer" } });
    rerender(<RunConfigEditor {...props} trusted={false} />);
    expect(screen.getByLabelText("TOKEN")).toHaveValue("");
    fireEvent.keyDown(screen.getByRole("region", { name: "Run configuration editor" }), {
      key: "Escape",
    });
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onSecrets).not.toHaveBeenCalled();
  });
  it("imports private env only on an explicit trusted action and saves names alone", async () => {
    const record = fixture();
    record.configs[0].secretNames = ["Imported_Key"];
    const { props } = setup({
      document: record,
      onImportEnv: vi.fn().mockResolvedValue(["IMPORTED_KEY"]),
    });
    expect(props.onImportEnv).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Private .env path (relative to checkout)"), {
      target: { value: "config/local.env" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import private values" }));
    await screen.findByText(/Imported 1 private variable/);
    expect(props.onImportEnv).toHaveBeenCalledWith("app", "config/local.env");
    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Private environment names")).toHaveValue("IMPORTED_KEY");
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        configs: [expect.objectContaining({ secretNames: ["IMPORTED_KEY"], env: {} })],
      }),
    );
  });
  it("rejects portable environment-name collisions regardless of letter case", async () => {
    const { props } = setup();
    fireEvent.change(screen.getByLabelText("Private environment names"), {
      target: { value: "TOKEN\nToken" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "private variable names must be unique",
    );
    fireEvent.change(screen.getByLabelText("Private environment names"), {
      target: { value: "Token" },
    });
    fireEvent.change(screen.getByLabelText("Nonsecret environment (JSON object)"), {
      target: { value: '{"TOKEN":"value"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "private variable cannot also have a nonsecret override",
    );
    fireEvent.change(screen.getByLabelText("Private environment names"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Nonsecret environment (JSON object)"), {
      target: { value: '{"MODE":"one","mode":"two"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configurations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "environment names must be unique, including letter case",
    );
    expect(props.onSave).not.toHaveBeenCalled();
  });
});
