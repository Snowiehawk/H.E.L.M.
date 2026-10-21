import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { FunctionTabsProvider } from "../app/FunctionTabs";
import { FunctionTabsShell } from "../app/FunctionTabsShell";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";

beforeEach(() => {
  useUiStore.getState().resetWorkspace();
  useUiStore.setState({
    repoSession: {
      id: "layout-contract",
      path: "/synthetic-layout-only",
      name: "Layout contract",
      branch: "dev",
      primaryLanguage: "Python",
      openedAt: "2026-10-21T00:00:00Z",
    },
    preferencesOpen: false,
    paletteOpen: false,
  });
});

function renderRootChain() {
  return render(
    <FunctionTabsProvider>
      <AppProviders adapter={new MockDesktopAdapter()}>
        <FunctionTabsShell>
          <DesktopWindow eyebrow="Workspace" title="Layout contract" subtitle="Synthetic child">
            <textarea aria-label="Retained source draft" defaultValue="unsaved café" />
          </DesktopWindow>
        </FunctionTabsShell>
      </AppProviders>
    </FunctionTabsProvider>,
  );
}

it("keeps the actual child and its draft mounted when the sidebar opens and hides", () => {
  renderRootChain();
  const draft = screen.getByRole("textbox", { name: "Retained source draft" });
  fireEvent.change(draft, { target: { value: "still unsaved Ω" } });
  fireEvent.click(screen.getByRole("button", { name: "Terminal / output" }));
  expect(screen.getByRole("textbox", { name: "Retained source draft" })).toBe(draft);
  expect(draft).toHaveValue("still unsaved Ω");
  fireEvent.click(screen.getByRole("button", { name: "Hide terminal / output" }));
  expect(screen.getByRole("textbox", { name: "Retained source draft" })).toBe(draft);
  expect(draft).toHaveValue("still unsaved Ω");
});
