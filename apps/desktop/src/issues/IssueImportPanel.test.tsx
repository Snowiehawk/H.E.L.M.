import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IssueImportPanel } from "./IssueImportPanel";
import { IssueRepositoryAdapter } from "./IssueRepositoryAdapter";
import {
  deferred,
  issue,
  page,
  repositoryName,
  response,
  TEST_TOKEN,
} from "./test-fixtures/github";

describe("issue import panel", () => {
  it("loads, warns about limits, refreshes, and clears credentials on disconnect", async () => {
    const user = userEvent.setup();
    const node = issue(1, [2]);
    node.blockedBy.totalCount = 101;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page([node])))
      .mockResolvedValueOnce(response(page([issue(1), issue(2)])));
    const adapter = new IssueRepositoryAdapter(fetcher);
    render(<IssueImportPanel adapter={adapter} />);
    expect(screen.getByText(/Hierarchy is not loaded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh issues" })).toBeDisabled();
    await user.type(screen.getByLabelText("Repository URL or owner/name"), repositoryName);
    await user.type(screen.getByLabelText("Personal access token"), TEST_TOKEN);
    await user.click(screen.getByRole("button", { name: "Load issues" }));
    expect(await screen.findByText(/1 issues, 1 native blocker links/)).toBeInTheDocument();
    expect(screen.getByText(/Dependency data is partial/)).toBeInTheDocument();
    expect(screen.getByLabelText("Personal access token")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Refresh issues" }));
    expect(await screen.findByText(/2 issues, 0 native blocker links/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByLabelText("Repository URL or owner/name")).toHaveValue("");
    expect(adapter.getState()).toEqual({ status: "idle", canRefresh: false });
  });

  it("reports refresh errors while keeping the last successful result visible", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page()))
      .mockRejectedValueOnce(new Error(TEST_TOKEN));
    const adapter = new IssueRepositoryAdapter(fetcher);
    await adapter.load(repositoryName, TEST_TOKEN);
    render(<IssueImportPanel adapter={adapter} />);
    await user.click(screen.getByRole("button", { name: "Refresh issues" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Showing the previous successful load.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(TEST_TOKEN);
    expect(screen.getByText(/1 issues, 0 native blocker links/)).toBeInTheDocument();
  });

  it("cancels an import and clears the session when leaving the screen", async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const adapter = new IssueRepositoryAdapter(fetcher);
    const { unmount } = render(<IssueImportPanel adapter={adapter} />);
    await user.type(screen.getByLabelText("Repository URL or owner/name"), repositoryName);
    await user.type(screen.getByLabelText("Personal access token"), TEST_TOKEN);
    await user.click(screen.getByRole("button", { name: "Load issues" }));
    await user.click(screen.getByRole("button", { name: "Cancel import" }));
    pending.resolve(response(page()));
    await waitFor(() => expect(adapter.getState().status).toBe("idle"));
    unmount();
    expect(adapter.getState()).toEqual({ status: "idle", canRefresh: false });
  });
});
