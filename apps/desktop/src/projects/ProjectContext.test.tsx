import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionTabsProvider } from "../app/FunctionTabs";
import { useUiStore } from "../store/uiStore";
import { ProjectContextProvider, useProjectContext } from "./ProjectContext";
import { PROJECT_STORAGE_KEY, type DraftSnapshot, type ProjectInspection } from "./model";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  openRepo: vi.fn(),
  startIndex: vi.fn(),
  accept: vi.fn(),
  pending: false,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("../lib/adapter", () => ({
  useDesktopAdapter: () => ({
    isMock: false,
    openRepo: api.openRepo,
    startIndex: api.startIndex,
    acceptProjectContextEpoch: api.accept,
    hasPendingProjectMutation: () => api.pending,
  }),
}));
const info: ProjectInspection = {
  path: "/repo",
  head: "head1",
  branch: "dev",
  branches: ["dev", "feature"],
  remoteBranches: [],
  remotes: [{ name: "origin", repository: "example/repo", kind: "fetch" }],
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicts: 0,
  operations: [],
  blocked: [],
  fingerprint: "clean1",
};
let draft: DraftSnapshot;
function Harness() {
  const project = useProjectContext()!,
    location = useLocation();
  useEffect(() => project.registerDraftProvider(() => draft), [project.registerDraftProvider]);
  return (
    <>
      <button onClick={() => void project.activate("/repo", "feature")}>Switch</button>
      <button onClick={project.cancelTransition}>Cancel</button>
      <button onClick={() => project.setLinked(!project.record.linked)}>Toggle link</button>
      <button onClick={() => void project.saveDrafts()}>Save drafts</button>
      <p>{project.error}</p>
      <output>{location.pathname}</output>
      <output>{project.inspection?.branch}</output>
    </>
  );
}
const setup = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <FunctionTabsProvider>
          <ProjectContextProvider>
            <Harness />
          </ProjectContextProvider>
        </FunctionTabsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  api.pending = false;
  useUiStore.setState({
    repoSession: {
      id: "repo1",
      path: "/repo",
      name: "repo",
      branch: "dev",
      primaryLanguage: "Python",
      openedAt: "2026-10-18T00:00:00Z",
    },
  });
  localStorage.clear();
  localStorage.setItem(
    PROJECT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      linked: true,
      issueRepository: "example/repo",
      associations: [{ path: "/repo", repository: "example/repo", remote: "origin" }],
    }),
  );
  draft = {
    path: "/repo",
    revision: "1",
    declaration: false,
    workspaceFile: false,
    flow: false,
    busy: false,
    save: vi.fn(async () => {}),
  };
  api.invoke.mockImplementation(async (command: string) =>
    command === "inspect_project"
      ? info
      : {
          outcome: "switched",
          actual: { ...info, branch: "feature", head: "head2" },
          contextEpoch: 1,
        },
  );
  api.openRepo.mockResolvedValue({
    id: "repo1",
    path: "/repo",
    name: "repo",
    branch: "dev",
    primaryLanguage: "Python",
    openedAt: "2026-10-18T00:00:00Z",
  });
  api.startIndex.mockResolvedValue({ jobId: "new-index" });
});
describe("guarded shared context coordinator", () => {
  it("switches actual Git before fresh IDE indexing, retaining repository-wide issue identity", async () => {
    setup();
    await screen.findByText("dev");
    fireEvent.click(screen.getByText("Switch"));
    await waitFor(() => expect(api.startIndex).toHaveBeenCalledWith("/repo"));
    expect(api.invoke).toHaveBeenCalledWith("switch_project_branch", {
      repoPath: "/repo",
      branch: "feature",
      fingerprint: "clean1",
    });
    expect(api.accept).toHaveBeenCalledWith(1);
    expect(useUiStore.getState().repoSession?.id).not.toBe("repo1");
    expect(JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY)!).issueRepository).toBe(
      "example/repo",
    );
    expect(await screen.findByText("/indexing/new-index")).toBeInTheDocument();
  });
  it.each(["declaration", "workspaceFile", "flow", "busy"] as const)(
    "refuses %s before Git and preserves the session",
    async (key) => {
      draft[key] = true;
      setup();
      await screen.findByText("dev");
      fireEvent.click(screen.getByText("Switch"));
      await screen.findByText(/Transition blocked/);
      expect(api.invoke.mock.calls.some((c) => c[0] === "switch_project_branch")).toBe(false);
      expect(api.openRepo).not.toHaveBeenCalled();
      expect(useUiStore.getState().repoSession?.id).toBe("repo1");
    },
  );
  it("rechecks Git at apply and rejects changed status without stashing", async () => {
    let count = 0;
    api.invoke.mockImplementation(async () =>
      ++count >= 4 ? { ...info, untracked: 1, fingerprint: "dirty" } : info,
    );
    setup();
    await screen.findByText("dev");
    fireEvent.click(screen.getByText("Switch"));
    await screen.findByText(/Git work blocks/);
    expect(api.openRepo).not.toHaveBeenCalled();
    expect(api.invoke.mock.calls.some((c) => c[0] === "switch_project_branch")).toBe(false);
  });
  it("cancels during inspection before apply and preserves drafts/files/context", async () => {
    setup();
    await screen.findByText("dev");
    let resolve!: (value: ProjectInspection) => void;
    api.invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    fireEvent.click(screen.getByText("Switch"));
    fireEvent.click(screen.getByText("Cancel"));
    await act(async () => resolve(info));
    await screen.findByText(/canceled before apply/);
    expect(api.openRepo).not.toHaveBeenCalled();
    expect(api.invoke.mock.calls.some((c) => c[0] === "switch_project_branch")).toBe(false);
  });
  it("keeps the real new branch explicit if indexing fails, without old graph publication", async () => {
    api.startIndex.mockRejectedValue(
      new Error("New branch indexing failed; retry indexing this checkout."),
    );
    setup();
    await screen.findByText("dev");
    fireEvent.click(screen.getByText("Switch"));
    await screen.findByText(/New branch indexing failed/);
    expect(useUiStore.getState().graphTargetId).toBeUndefined();
    expect(useUiStore.getState().repoSession?.path).toBe("/repo");
  });
  it("restores metadata without opening a checkout or reviving an issue session", async () => {
    setup();
    await screen.findByText("dev");
    expect(api.openRepo).not.toHaveBeenCalled();
    expect(api.invoke.mock.calls.every((c) => c[0] === "inspect_project")).toBe(true);
  });
  it("retains corrupt saved data until an explicit repair instead of overwriting it", async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, "unknown-version-or-corrupt");
    setup();
    await screen.findByText(/SyntaxError/);
    fireEvent.click(screen.getByText("Toggle link"));
    await screen.findByText(/needs repair/);
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("unknown-version-or-corrupt");
    expect(api.openRepo).not.toHaveBeenCalled();
  });
  it("save failure cannot admit a replacement or Git switch", async () => {
    draft.declaration = true;
    draft.save = vi.fn(async () => {
      throw new Error("Draft save refused");
    });
    setup();
    await screen.findByText("dev");
    fireEvent.click(screen.getByText("Save drafts"));
    await screen.findByText(/Draft save refused/);
    fireEvent.click(screen.getByText("Switch"));
    await screen.findByText(/unsaved declaration/);
    expect(api.openRepo).not.toHaveBeenCalled();
  });
});
