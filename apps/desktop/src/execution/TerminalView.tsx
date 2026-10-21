import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ExecutionSnapshot } from "./adapter";

function terminalTheme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const color = (name: string, fallback: string) =>
    style.getPropertyValue(`--terminal-${name}`).trim() || style.getPropertyValue(fallback).trim();
  const theme: ITheme = {
    background: color("background", "--surface-solid"),
    foreground: color("foreground", "--text"),
    cursor: color("cursor", "--accent-strong"),
    selectionBackground: color("selection", "--accent"),
  };
  const names = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "bright-black",
    "bright-red",
    "bright-green",
    "bright-yellow",
    "bright-blue",
    "bright-magenta",
    "bright-cyan",
    "bright-white",
  ];
  for (const name of names) {
    const value = style.getPropertyValue(`--terminal-ansi-${name}`).trim();
    if (value)
      (theme as Record<string, string>)[
        name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
      ] = value;
  }
  return theme;
}
export function TerminalView({
  snapshot,
  visible,
  onInput,
  onResize,
  onLink,
  onError,
}: {
  snapshot?: ExecutionSnapshot;
  visible: boolean;
  onInput(data: string): Promise<void>;
  onResize(rows: number, cols: number): Promise<void>;
  onLink(url: string): void;
  onError(error: unknown): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const last = useRef(0);
  const handlers = useRef({ onInput, onResize, onLink, onError });
  handlers.current = { onInput, onResize, onLink, onError };
  const fit = useRef<FitAddon>();
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const writing = useRef(false);
  const pump = useRef<() => void>(() => {});
  useEffect(() => {
    if (!host.current) return;
    const instance = new Terminal({
      scrollback: 2000,
      screenReaderMode: true,
      fontSize: 13,
      convertEol: false,
      allowProposedApi: false,
      theme: terminalTheme(host.current),
      linkHandler: {
        activate: (_event, text) => handlers.current.onLink(text),
        allowNonHttpProtocols: false,
      },
    });
    const addon = new FitAddon();
    instance.loadAddon(addon);
    instance.open(host.current);
    terminal.current = instance;
    fit.current = addon;
    const links = new WebLinksAddon((_event, target) => handlers.current.onLink(target));
    instance.loadAddon(links);
    const data = instance.onData((value) => {
      void handlers.current.onInput(value).catch(handlers.current.onError);
    });
    // Clipboard OSC52 and window/title actions have no handlers or native permissions.
    const resize = () => {
      if (!host.current || host.current.clientWidth < 20 || host.current.clientHeight < 20) return;
      addon.fit();
      void handlers.current.onResize(instance.rows, instance.cols).catch(handlers.current.onError);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const themeObserver = new MutationObserver(() => {
      if (host.current) instance.options.theme = terminalTheme(host.current);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => {
      links.dispose();
      data.dispose();
      observer.disconnect();
      themeObserver.disconnect();
      instance.dispose();
      terminal.current = undefined;
    };
  }, []);
  const previousId = useRef<string>();
  pump.current = () => {
    const instance = terminal.current;
    const value = latest.current;
    if (!instance || !value || writing.current) return;
    if (previousId.current !== value.id) {
      instance.reset();
      last.current = 0;
      previousId.current = value.id;
    }
    const chunks = value.chunks.filter((chunk) => chunk.sequence > last.current);
    if (!chunks.length) return;
    let bytes = 0;
    const batch = chunks.filter((chunk) => {
      if (bytes >= 65536) return false;
      bytes += chunk.data.length;
      return true;
    });
    const first = batch[0];
    const marker = first.sequence > last.current + 1 ? "\r\n[Terminal output truncated]\r\n" : "";
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of batch) {
      data.set(chunk.data, offset);
      offset += chunk.data.length;
    }
    writing.current = true;
    if (marker) instance.write(marker);
    instance.write(data, () => {
      last.current = batch[batch.length - 1].sequence;
      writing.current = false;
      if (terminal.current === instance) pump.current();
    });
  };
  useEffect(() => {
    pump.current();
  }, [snapshot]);
  useEffect(() => {
    if (visible) {
      const instance = terminal.current;
      if (host.current && host.current.clientWidth > 20 && instance) {
        fit.current?.fit();
        instance.focus();
        if (snapshot)
          void handlers.current
            .onResize(instance.rows, instance.cols)
            .catch(handlers.current.onError);
      }
    }
  }, [visible, snapshot?.id]);
  return (
    <div
      className="execution-terminal"
      ref={host}
      role="region"
      aria-label="Interactive project terminal"
    />
  );
}
