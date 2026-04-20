import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FlowInputDisplayMode, ThemeMode } from "../../lib/adapter";
import {
  DEFAULT_UI_SCALE,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  UI_SCALE_STEP,
  useUiStore,
} from "../../store/uiStore";

const themeOptions: Array<{ label: string; value: ThemeMode }> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const flowInputOptions: Array<{ label: string; value: FlowInputDisplayMode }> = [
  { label: "Entry inputs", value: "entry" },
  { label: "Parameters", value: "param_nodes" },
];

type PreferenceSectionId = "general" | "appearance" | "graph" | "flow";

const preferenceSections: Array<{ id: PreferenceSectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "graph", label: "Graph" },
  { id: "flow", label: "Flow" },
];

export function PreferencesDialog() {
  const preferencesOpen = useUiStore((state) => state.preferencesOpen);
  const setPreferencesOpen = useUiStore((state) => state.setPreferencesOpen);
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const uiScale = useUiStore((state) => state.uiScale);
  const setUiScale = useUiStore((state) => state.setUiScale);
  const increaseUiScale = useUiStore((state) => state.increaseUiScale);
  const decreaseUiScale = useUiStore((state) => state.decreaseUiScale);
  const resetUiScale = useUiStore((state) => state.resetUiScale);
  const graphSettings = useUiStore((state) => state.graphSettings);
  const toggleGraphSetting = useUiStore((state) => state.toggleGraphSetting);
  const flowInputDisplayMode = useUiStore((state) => state.flowInputDisplayMode);
  const setFlowInputDisplayMode = useUiStore((state) => state.setFlowInputDisplayMode);
  const [activeSection, setActiveSection] = useState<PreferenceSectionId>("general");
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!preferencesOpen) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveSection("general");
    backButtonRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus();
    };
  }, [preferencesOpen]);

  useEffect(() => {
    if (!preferencesOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setPreferencesOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [preferencesOpen, setPreferencesOpen]);

  if (!preferencesOpen) {
    return null;
  }

  const scalePercent = Math.round(uiScale * 100);
  const activeSectionLabel =
    preferenceSections.find((section) => section.id === activeSection)?.label ?? "General";

  return (
    <div
      className="preferences-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setPreferencesOpen(false);
        }
      }}
    >
      <section aria-label="Preferences" aria-modal="true" className="preferences-dialog" role="dialog">
        <aside className="preferences-sidebar" aria-label="Preferences sections">
          <button
            ref={backButtonRef}
            className="preferences-back-button"
            type="button"
            onClick={() => setPreferencesOpen(false)}
          >
            <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 18 18" width="18">
              <path
                d="M11 4.5 6.5 9l4.5 4.5M7 9h7"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
            </svg>
            <span>Back to app</span>
          </button>

          <nav className="preferences-sidebar__nav" aria-label="Preferences">
            {preferenceSections.map((section) => (
              <PreferenceSidebarItem
                key={section.id}
                active={activeSection === section.id}
                id={section.id}
                label={section.label}
                onClick={() => setActiveSection(section.id)}
              />
            ))}
          </nav>
        </aside>

        <main className="preferences-content">
          <h2 id="preferences-title">{activeSectionLabel}</h2>
          <div className="preferences-list">
            {activeSection === "general" ? (
              <PreferenceRow
                description="Tune the size of controls, graph UI, and editor chrome."
                label="Interface scale"
              >
                <div className="preferences-scale-control">
                  <button
                    aria-label="Decrease interface scale"
                    className="preferences-step-button"
                    type="button"
                    onClick={decreaseUiScale}
                  >
                    <span aria-hidden="true">-</span>
                  </button>
                  <strong className="preferences-scale-control__value">{scalePercent}%</strong>
                  <button
                    aria-label="Increase interface scale"
                    className="preferences-step-button"
                    type="button"
                    onClick={increaseUiScale}
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                  <input
                    aria-label="Interface scale"
                    max={MAX_UI_SCALE}
                    min={MIN_UI_SCALE}
                    step={UI_SCALE_STEP}
                    type="range"
                    value={uiScale}
                    onChange={(event) => setUiScale(Number(event.currentTarget.value))}
                  />
                  <button
                    className="preferences-action-button"
                    disabled={uiScale === DEFAULT_UI_SCALE}
                    type="button"
                    onClick={resetUiScale}
                  >
                    Reset
                  </button>
                </div>
              </PreferenceRow>
            ) : null}

            {activeSection === "appearance" ? (
              <PreferenceRow
                description="Choose whether H.E.L.M. follows the system or pins a theme."
                label="Theme"
              >
                <div className="preferences-segmented" role="group" aria-label="Theme">
                  {themeOptions.map((option) => (
                    <button
                      key={option.value}
                      aria-pressed={theme === option.value}
                      className={`preferences-segmented__button${theme === option.value ? " is-active" : ""}`}
                      type="button"
                      onClick={() => setTheme(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </PreferenceRow>
            ) : null}

            {activeSection === "graph" ? (
              <PreferenceRow
                description="Include third-party and external dependency nodes in graph views."
                label="Show external dependencies"
              >
                <PreferenceSwitch
                  checked={graphSettings.includeExternalDependencies}
                  label="Show external dependencies"
                  onChange={() => toggleGraphSetting("includeExternalDependencies")}
                />
              </PreferenceRow>
            ) : null}

            {activeSection === "flow" ? (
              <PreferenceRow
                description="Choose how editable flow inputs are represented on flow graphs."
                label="Input display"
              >
                <div className="preferences-segmented" role="group" aria-label="Flow input display">
                  {flowInputOptions.map((option) => (
                    <button
                      key={option.value}
                      aria-pressed={flowInputDisplayMode === option.value}
                      className={`preferences-segmented__button${flowInputDisplayMode === option.value ? " is-active" : ""}`}
                      type="button"
                      onClick={() => setFlowInputDisplayMode(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </PreferenceRow>
            ) : null}
          </div>
        </main>
      </section>
    </div>
  );
}

function PreferenceSidebarItem({
  active,
  id,
  label,
  onClick,
}: {
  active: boolean;
  id: PreferenceSectionId;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`preferences-sidebar__item${active ? " is-active" : ""}`}
      type="button"
      onClick={onClick}
    >
      <PreferenceIcon id={id} />
      <span>{label}</span>
    </button>
  );
}

function PreferenceRow({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description: string;
  label: string;
}) {
  return (
    <section className="preferences-row">
      <div className="preferences-row__copy">
        <h3>{label}</h3>
        <p>{description}</p>
      </div>
      <div className="preferences-row__control">{children}</div>
    </section>
  );
}

function PreferenceSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`preferences-switch${checked ? " is-on" : ""}`}
      role="switch"
      type="button"
      onClick={onChange}
    >
      <span aria-hidden="true" />
    </button>
  );
}

function PreferenceIcon({ id }: { id: PreferenceSectionId }) {
  const sharedProps = {
    "aria-hidden": true,
    fill: "none",
    height: 18,
    viewBox: "0 0 18 18",
    width: 18,
  };

  if (id === "appearance") {
    return (
      <svg {...sharedProps}>
        <path
          d="M9 2v2M9 14v2M2 9h2M14 9h2M4.05 4.05l1.42 1.42M12.53 12.53l1.42 1.42M13.95 4.05l-1.42 1.42M5.47 12.53l-1.42 1.42M9 6.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.55"
        />
      </svg>
    );
  }

  if (id === "graph") {
    return (
      <svg {...sharedProps}>
        <path
          d="M5 5.75a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM13 10.75a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 16.25a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6.75 5 11.25 7.5M11.25 10.25 6.75 13"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.55"
        />
      </svg>
    );
  }

  if (id === "flow") {
    return (
      <svg {...sharedProps}>
        <path
          d="M3 4.5h4.25M3 13.5h4.25M10.75 4.5H15M10.75 13.5H15M7.25 4.5c2.25 0 1.25 9 3.5 9M7.25 13.5c2.25 0 1.25-9 3.5-9"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.55"
        />
      </svg>
    );
  }

  return (
    <svg {...sharedProps}>
      <path
        d="M9 6.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
      <path
        d="M14.25 8.15 15.5 9l-1.25.85a5.25 5.25 0 0 1-.47 1.12l.28 1.48-1.1 1.1-1.48-.28c-.36.2-.74.36-1.13.47L9.5 15h-1l-.85-1.26a5.2 5.2 0 0 1-1.13-.47l-1.48.28-1.1-1.1.28-1.48a5.25 5.25 0 0 1-.47-1.12L2.5 9l1.25-.85c.11-.39.27-.77.47-1.12l-.28-1.48 1.1-1.1 1.48.28c.36-.2.74-.36 1.13-.47L8.5 3h1l.85 1.26c.39.11.77.27 1.13.47l1.48-.28 1.1 1.1-.28 1.48c.2.36.36.73.47 1.12Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
    </svg>
  );
}
