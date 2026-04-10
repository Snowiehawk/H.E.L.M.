import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

if (
  typeof window.localStorage?.getItem !== "function"
  || typeof window.localStorage?.setItem !== "function"
  || typeof window.localStorage?.clear !== "function"
) {
  const storageState = new Map<string, string>();
  const localStorageMock: Storage = {
    getItem: (key) => storageState.get(String(key)) ?? null,
    setItem: (key, value) => {
      storageState.set(String(key), String(value));
    },
    removeItem: (key) => {
      storageState.delete(String(key));
    },
    clear: () => {
      storageState.clear();
    },
    key: (index) => Array.from(storageState.keys())[index] ?? null,
    get length() {
      return storageState.size;
    },
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserverMock;
HTMLElement.prototype.scrollIntoView = () => {};
