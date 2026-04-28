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
  typeof window.localStorage?.getItem !== "function" ||
  typeof window.localStorage?.setItem !== "function" ||
  typeof window.localStorage?.clear !== "function"
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
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }

  unobserve() {}
  disconnect() {}
}

if (typeof window.PointerEvent !== "function") {
  class PointerEventMock extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
    }
  }

  window.PointerEvent = PointerEventMock as typeof PointerEvent;
}

if (typeof window.DOMMatrixReadOnly !== "function") {
  class DOMMatrixReadOnlyMock {
    m22: number;

    constructor(transform = "none") {
      const scaleMatch = /scale\(([-+]?\d*\.?\d+)\)/.exec(transform);
      this.m22 = scaleMatch ? Number.parseFloat(scaleMatch[1] ?? "1") : 1;
    }
  }

  window.DOMMatrixReadOnly = DOMMatrixReadOnlyMock as typeof DOMMatrixReadOnly;
}

window.ResizeObserver = ResizeObserverMock;
HTMLElement.prototype.scrollIntoView = () => {};
