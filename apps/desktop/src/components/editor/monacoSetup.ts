import { loader } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (_moduleId: string, label: string) => Worker;
    };
  }
}

let monacoConfigured = false;
let themesConfigured = false;

export function ensureMonacoSetup() {
  if (monacoConfigured) {
    return monaco;
  }

  self.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === "json") {
        return new jsonWorker();
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new cssWorker();
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new htmlWorker();
      }
      if (label === "typescript" || label === "javascript") {
        return new tsWorker();
      }
      return new editorWorker();
    },
  };

  loader.config({ monaco });
  monacoConfigured = true;
  return monaco;
}

export function ensureHelmMonacoThemes(monacoInstance: typeof monaco) {
  if (themesConfigured) {
    return;
  }

  monacoInstance.editor.defineTheme("helm-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#18202d",
      "editorLineNumber.foreground": "#92a1b4",
      "editorLineNumber.activeForeground": "#5f6d82",
      "editor.lineHighlightBackground": "#eef3fb",
      "editor.selectionBackground": "#dbeafe",
      "editor.inactiveSelectionBackground": "#e9eef7",
      "editorCursor.foreground": "#2f6fe4",
      "editorIndentGuide.background1": "#d7dee9",
      "editorIndentGuide.activeBackground1": "#b9c6d8",
      "editorGutter.background": "#ffffff",
    },
  });

  monacoInstance.editor.defineTheme("helm-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1a2331",
      "editor.foreground": "#ecf2fb",
      "editorLineNumber.foreground": "#62748d",
      "editorLineNumber.activeForeground": "#a1afc2",
      "editor.lineHighlightBackground": "#202b3a",
      "editor.selectionBackground": "#254774",
      "editor.inactiveSelectionBackground": "#223247",
      "editorCursor.foreground": "#76b5ff",
      "editorIndentGuide.background1": "#324257",
      "editorIndentGuide.activeBackground1": "#4b5d75",
      "editorGutter.background": "#1a2331",
    },
  });

  themesConfigured = true;
}

export type MonacoEditorOptions = editor.IStandaloneEditorConstructionOptions;
