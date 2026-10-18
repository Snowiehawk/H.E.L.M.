import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionTabsProvider } from "../app/FunctionTabs";
import { useUiStore } from "../store/uiStore";
import { ProjectContextProvider } from "./ProjectContext";
import { ProjectSelector } from "./ProjectSelector";
import { PROJECT_STORAGE_KEY, type ProjectInspection } from "./model";
const api = vi.hoisted(() => ({ invoke: vi.fn(), openRepo: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("../lib/adapter", () => ({
  useDesktopAdapter: () => ({ isMock: false, openRepo: api.openRepo }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const info: ProjectInspection = {
  path: "/first",
  head: "h",
  branch: "dev",
  branches: ["dev"],
  remoteBranches: [],
  remotes: [
    { name: "origin", repository: "example/repo", kind: "fetch" },
    { name: "upstream", repository: "upstream/repo", kind: "fetch" },
  ],
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicts: 0,
  operations: [],
  blocked: [],
  fingerprint: "1",
};
function setup(associations: unknown[] = []) {
  localStorage.setItem(
    PROJECT_STORAGE_KEY,
    JSON.stringify({ version: 1, linked: true, issueRepository: "example/repo", associations }),
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <FunctionTabsProvider>
          <ProjectContextProvider>
            <ProjectSelector />
          </ProjectContextProvider>
        </FunctionTabsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useUiStore.setState({ repoSession: undefined });
  api.invoke.mockImplementation(async (_command: string, args: { repoPath: string }) => ({
    ...info,
    path: args.repoPath,
  }));
});
describe("explicit local-copy and clone choices", () => {
  it("requires a remote choice, registers only metadata and never opens the copy implicitly", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Local checkout path"), { target: { value: "/first" } });
    fireEvent.click(screen.getByText("Inspect local copy"));
    await screen.findByText(/Verified root/);
    expect(screen.getByText("Register selected association")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Repository remote"), { target: { value: "upstream" } });
    fireEvent.click(screen.getByText("Register selected association"));
    const record = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY)!);
    expect(record.associations).toEqual([
      { path: "/first", repository: "upstream/repo", remote: "upstream" },
    ]);
    expect(record.issueRepository).toBe("upstream/repo");
    expect(api.openRepo).not.toHaveBeenCalled();
  });
  it("returns all verified matching copies and ignores a changed fork remote", async () => {
    api.invoke.mockImplementation(async (_command: string, args: { repoPath: string }) => ({
      ...info,
      path: args.repoPath,
      remotes:
        args.repoPath === "/fork"
          ? [{ name: "origin", repository: "fork/repo", kind: "fetch" }]
          : info.remotes,
    }));
    setup(
      ["/first", "/second", "/fork"].map((path) => ({
        path,
        repository: "example/repo",
        remote: "origin",
      })),
    );
    fireEvent.click(screen.getByText("Find matching known copies"));
    await screen.findByText(/Verified 2 matching local copies/);
    expect(api.openRepo).not.toHaveBeenCalled();
  });
  it("refuses duplicate cloning after verifying known copies", async () => {
    setup([{ path: "/first", repository: "example/repo", remote: "origin" }]);
    fireEvent.change(screen.getByLabelText("New clone destination"), { target: { value: "/new" } });
    fireEvent.click(screen.getByText("Clone to this new destination"));
    await screen.findByText(/matching copy already exists/);
    expect(api.invoke.mock.calls.some((c) => c[0] === "clone_project")).toBe(false);
  });
  it("reports failed clone residue without registration, activation or issue-token reuse", async () => {
    api.invoke.mockResolvedValue({
      outcome: "failed",
      path: "/new",
      message: "Clone failed; inspect retained output.",
    });
    setup();
    fireEvent.change(screen.getByLabelText("New clone destination"), { target: { value: "/new" } });
    fireEvent.click(screen.getByText("Clone to this new destination"));
    await screen.findByText("Clone failed; inspect retained output.");
    expect(api.invoke).toHaveBeenCalledWith(
      "clone_project",
      expect.objectContaining({
        repository: "example/repo",
        destination: "/new",
        transport: "https",
      }),
    );
    expect(api.openRepo).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY)!).associations).toEqual([]);
  });
  it("cancel targets the exact owned clone attempt", async () => {
    api.invoke.mockImplementation((command) =>
      command === "clone_project" ? new Promise(() => {}) : Promise.resolve(),
    );
    const ui = setup();
    fireEvent.change(screen.getByLabelText("New clone destination"), { target: { value: "/new" } });
    fireEvent.click(screen.getByText("Clone to this new destination"));
    await waitFor(() =>
      expect(api.invoke.mock.calls.some((c) => c[0] === "clone_project")).toBe(true),
    );
    const id = api.invoke.mock.calls.find((c) => c[0] === "clone_project")![1].attemptId;
    fireEvent.click(screen.getByText("Cancel clone"));
    expect(api.invoke).toHaveBeenCalledWith("cancel_project_clone", { attemptId: id });
    ui.unmount();
    expect(api.openRepo).not.toHaveBeenCalled();
  });
});
