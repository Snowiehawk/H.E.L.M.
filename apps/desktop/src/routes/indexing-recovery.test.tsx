import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { FunctionTabsProvider } from "../app/FunctionTabs";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";
import { IndexingScreen } from "./IndexingScreen";
import { WelcomeScreen } from "./WelcomeScreen";
const session = (id: string) => ({
  id,
  path: "/workspace/synthetic",
  name: "Synthetic repository",
  branch: "dev",
  primaryLanguage: "Python",
  openedAt: "2026-10-18T00:00:00Z",
});
function setup({ stale = false, rejectStart = false } = {}) {
  const adapter = new MockDesktopAdapter();
  let opened = 0,
    jobs = 0;
  const open = vi
    .spyOn(adapter, "openRepo")
    .mockImplementation(async () => session(`new-${++opened}`));
  const create = vi
    .spyOn(adapter, "createProject")
    .mockImplementation(async () => session(`created-${++opened}`));
  vi.spyOn(adapter, "listRecentRepos").mockResolvedValue([
    { ...session("recent"), lastOpenedAt: "2026-10-18T00:00:00Z" },
  ]);
  const start = vi.spyOn(adapter, "startIndex").mockImplementation(async () => {
    if (rejectStart && jobs++ === 0) throw new Error("Index start failed");
    return { jobId: `job-${++jobs}` };
  });
  vi.spyOn(adapter, "subscribeIndexProgress").mockImplementation((jobId, callback) => {
    const failed = jobId === "job-1" || jobId === "stale";
    callback({
      jobId,
      repoPath: session("").path,
      status: failed ? "error" : "queued",
      stage: "discover",
      processedModules: 0,
      totalModules: 0,
      symbolCount: 0,
      message: failed ? "Synthetic scan failure" : "Synthetic retry queued",
      error: failed ? "Synthetic scan failure" : undefined,
    });
    return () => {};
  });
  render(
    <FunctionTabsProvider>
      <AppProviders adapter={adapter}>
        <MemoryRouter initialEntries={[stale ? "/indexing/stale" : "/"]}>
          <Routes>
            <Route path="/" element={<WelcomeScreen />} />
            <Route path="/indexing/:jobId" element={<IndexingScreen />} />
            <Route path="/workspace" element={<h1>Current workspace preserved</h1>} />
          </Routes>
        </MemoryRouter>
      </AppProviders>
    </FunctionTabsProvider>,
  );
  return { open, create, start };
}
beforeEach(() => {
  localStorage.clear();
  useUiStore.getState().resetWorkspace();
  useUiStore.setState({ repoSession: undefined });
  useUndoStore.getState().resetSession(undefined);
});
describe("owned failed index -> Welcome recovery with the existing launcher", () => {
  it.each(["recent", "open", "new"])(
    "abandons only the failed index and allows %s retry",
    async (action) => {
      const api = setup();
      fireEvent.click(await screen.findByRole("button", { name: "Open Local Repo" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Back to Welcome" }, { timeout: 10_000 }),
      );
      expect(useUiStore.getState().repoSession).toBeUndefined();
      expect(useUiStore.getState().indexingSession).toBeUndefined();
      if (action === "recent")
        fireEvent.click(await screen.findByRole("button", { name: /Synthetic repository/ }));
      else
        fireEvent.click(
          await screen.findByRole("button", {
            name: action === "open" ? "Open Local Repo" : "New Project",
          }),
        );
      await screen.findByText("Synthetic retry queued", undefined, { timeout: 10_000 });
      expect(api.start).toHaveBeenCalledTimes(2);
      expect(useUiStore.getState().indexingSession?.jobId).toBe("job-2");
      expect(screen.queryByText(/Draft status is unavailable/)).not.toBeInTheDocument();
    },
  );
  it("a stale failed-job screen cannot abandon a different ready workspace", async () => {
    useUiStore.setState({ repoSession: session("ready"), graphTargetId: "keep-selection" });
    setup({ stale: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "Back to Welcome" }, { timeout: 10_000 }),
    );
    await screen.findByRole("heading", { name: "Current workspace preserved" });
    expect(useUiStore.getState().repoSession?.id).toBe("ready");
    expect(useUiStore.getState().graphTargetId).toBe("keep-selection");
  });
  it("clears a never-ready session when starting its index rejects immediately", async () => {
    const api = setup({ rejectStart: true });
    fireEvent.click(await screen.findByRole("button", { name: "Open Local Repo" }));
    await screen.findByText("Index start failed");
    expect(useUiStore.getState().repoSession).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Open Local Repo" }));
    await waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
    await screen.findByText("Synthetic retry queued", undefined, { timeout: 10_000 });
  });
  it("can return to an owned unready job after navigating directly to Welcome", async () => {
    useUiStore.setState({
      repoSession: session("unready"),
      indexingSession: { sessionId: "unready", jobId: "job-1" },
    });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Return to indexing" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Back to Welcome" }, { timeout: 10_000 }),
    );
    await screen.findByRole("button", { name: "Open Local Repo" });
    expect(useUiStore.getState().repoSession).toBeUndefined();
  });
});
