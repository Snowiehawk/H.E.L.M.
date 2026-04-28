import { useUiStore } from "../../store/uiStore";
import { ThemeCycleButton } from "./ThemeCycleButton";

export function AppWindowActions() {
  return (
    <>
      <ThemeCycleButton />
      <PreferencesButton />
    </>
  );
}

function PreferencesButton() {
  const setPreferencesOpen = useUiStore((state) => state.setPreferencesOpen);

  return (
    <button
      aria-label="Open preferences"
      className="icon-button"
      title="Preferences"
      type="button"
      onClick={() => setPreferencesOpen(true)}
    >
      <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 18 18" width="18">
        <path
          d="M9 6.35a2.65 2.65 0 1 0 0 5.3 2.65 2.65 0 0 0 0-5.3Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.55"
        />
        <path
          d="M14.28 8.2 15.5 9l-1.22.8a5.35 5.35 0 0 1-.48 1.17l.28 1.44-1.17 1.17-1.44-.28c-.37.21-.76.37-1.17.48L9.5 15h-1l-.8-1.22a5.35 5.35 0 0 1-1.17-.48l-1.44.28-1.17-1.17.28-1.44a5.35 5.35 0 0 1-.48-1.17L2.5 9l1.22-.8c.11-.41.27-.8.48-1.17l-.28-1.44 1.17-1.17 1.44.28c.37-.21.76-.37 1.17-.48L8.5 3h1l.8 1.22c.41.11.8.27 1.17.48l1.44-.28 1.17 1.17-.28 1.44c.21.37.37.76.48 1.17Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.55"
        />
      </svg>
    </button>
  );
}
