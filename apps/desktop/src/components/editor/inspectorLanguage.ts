const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "shell",
  cjs: "javascript",
  htm: "html",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  py: "python",
  shell: "shell",
  sh: "shell",
  text: "plaintext",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

const PATH_LANGUAGE_MAP: Array<[RegExp, string]> = [
  [/\.py$/i, "python"],
  [/\.tsx?$/i, "typescript"],
  [/\.jsx?$/i, "javascript"],
  [/\.json$/i, "json"],
  [/\.css$/i, "css"],
  [/\.scss$/i, "scss"],
  [/\.less$/i, "less"],
  [/\.html?$/i, "html"],
  [/\.md$/i, "markdown"],
  [/\.ya?ml$/i, "yaml"],
  [/\.xml$/i, "xml"],
  [/\.sh$/i, "shell"],
  [/\.sql$/i, "sql"],
  [/\.rs$/i, "rust"],
  [/\.go$/i, "go"],
  [/\.java$/i, "java"],
  [/\.(c|h)$/i, "c"],
  [/\.(cc|cpp|cxx|hpp)$/i, "cpp"],
];

const LANGUAGE_METADATA_KEYS = [
  "language",
  "lang",
  "file_language",
  "fileLanguage",
  "syntax",
] as const;

export interface InspectorLanguageInput {
  editablePath?: string;
  selectedRelativePath?: string;
  symbolFilePath?: string;
  metadata?: Record<string, unknown>;
}

export function inferInspectorLanguage({
  editablePath,
  selectedRelativePath,
  symbolFilePath,
  metadata,
}: InspectorLanguageInput): string {
  const fromPath =
    languageFromPath(editablePath) ??
    languageFromPath(selectedRelativePath) ??
    languageFromPath(symbolFilePath);
  if (fromPath) {
    return fromPath;
  }

  const explicitLanguage = explicitLanguageFromMetadata(metadata);
  return normalizeMonacoLanguage(explicitLanguage) ?? "plaintext";
}

export function normalizeMonacoLanguage(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function languageFromPath(path?: string): string | undefined {
  if (!path) {
    return undefined;
  }

  const normalizedPath = path.trim().split(/[?#]/, 1)[0];
  if (!normalizedPath) {
    return undefined;
  }

  for (const [pattern, language] of PATH_LANGUAGE_MAP) {
    if (pattern.test(normalizedPath)) {
      return language;
    }
  }

  return undefined;
}

function explicitLanguageFromMetadata(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) {
    return undefined;
  }

  for (const key of LANGUAGE_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}
