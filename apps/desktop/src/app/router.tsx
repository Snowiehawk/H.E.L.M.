import { createBrowserRouter, Outlet } from "react-router-dom";
import { IndexingScreen } from "../routes/IndexingScreen";
import { WelcomeScreen } from "../routes/WelcomeScreen";
import { WorkspaceScreen } from "../routes/WorkspaceScreen";
import { NewProjectMenuBridge } from "./NewProjectMenuBridge";

function RootRoute() {
  return (
    <>
      <NewProjectMenuBridge />
      <Outlet />
    </>
  );
}

export const router = createBrowserRouter([
  {
    element: <RootRoute />,
    children: [
      {
        path: "/",
        element: <WelcomeScreen />,
      },
      {
        path: "/indexing/:jobId",
        element: <IndexingScreen />,
      },
      {
        path: "/workspace",
        element: <WorkspaceScreen />,
      },
    ],
  },
]);
