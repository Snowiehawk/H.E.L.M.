import { RouterProvider } from "react-router-dom";
import { AppProviders } from "./AppProviders";
import { router } from "./router";
import { FunctionTabsProvider } from "./FunctionTabs";

export function App() {
  return (
    <FunctionTabsProvider>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </FunctionTabsProvider>
  );
}
