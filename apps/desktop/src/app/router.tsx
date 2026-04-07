import { createBrowserRouter } from "react-router-dom";
import { IndexingScreen } from "../routes/IndexingScreen";
import { WelcomeScreen } from "../routes/WelcomeScreen";
import { WorkspaceScreen } from "../routes/WorkspaceScreen";

export const router = createBrowserRouter([
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
]);
