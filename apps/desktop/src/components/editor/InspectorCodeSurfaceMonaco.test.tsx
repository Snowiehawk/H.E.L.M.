import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../store/uiStore";
import { InspectorCodeSurfaceMonaco } from "./InspectorCodeSurfaceMonaco";

vi.mock("./monacoSetup", () => ({ ensureMonacoSetup: vi.fn(), ensureHelmMonacoThemes: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({
  default: ({
    theme,
    value,
    onChange,
  }: {
    theme: string;
    value: string;
    onChange: (s: string) => void;
  }) => (
    <textarea
      aria-label="Mock Monaco"
      data-theme={theme}
      defaultValue={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
afterEach(() => vi.unstubAllGlobals());

it("updates the mounted Monaco theme prop without replacing the editor or draft", () => {
  const changes = vi.fn();
  useUiStore.setState({ theme: "light" });
  render(
    <InspectorCodeSurfaceMonaco
      ariaLabel="Source"
      value="draft = 1"
      language="python"
      readOnly={false}
      onChange={changes}
    />,
  );
  const editor = screen.getByRole("textbox");
  fireEvent.change(editor, { target: { value: "draft = 2" } });
  act(() => useUiStore.getState().setTheme("dark"));
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor).toHaveAttribute("data-theme", "helm-dark");
  expect(editor).toHaveValue("draft = 2");
  expect(changes).toHaveBeenCalledWith("draft = 2");
});
