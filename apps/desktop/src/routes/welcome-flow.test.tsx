import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { IndexingScreen } from "./IndexingScreen";
import { WelcomeScreen } from "./WelcomeScreen";

describe("welcome flow", () => {
  it("opens a repo and navigates into indexing", async () => {
    const user = userEvent.setup();

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<WelcomeScreen />} />
            <Route path="/indexing/:jobId" element={<IndexingScreen />} />
          </Routes>
        </MemoryRouter>
      </AppProviders>,
    );

    await user.click(screen.getByRole("button", { name: /open local repo/i }));

    expect(await screen.findByText(/Preparing the workspace/i)).toBeInTheDocument();
    expect(await screen.findByText(/Discovering Python modules/i)).toBeInTheDocument();
    expect(await screen.findByText(/Job ID/i)).toBeInTheDocument();
  });
});
