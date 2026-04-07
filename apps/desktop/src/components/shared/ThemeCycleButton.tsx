import type { ThemeMode } from "../../lib/adapter";
import { useUiStore } from "../../store/uiStore";

const order: ThemeMode[] = ["system", "light", "dark"];

export function ThemeCycleButton() {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const nextTheme = order[(order.indexOf(theme) + 1) % order.length];

  return (
    <button
      className="ghost-button"
      type="button"
      onClick={() => setTheme(nextTheme)}
    >
      Theme: {theme}
    </button>
  );
}
