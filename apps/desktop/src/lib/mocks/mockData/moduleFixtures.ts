import type { MockTopLevelSymbolSeed, MockWorkspaceState } from "./state";
import { symbolId } from "./ids";

export function topLevelOutlineEntry(
  moduleName: string,
  symbol: MockTopLevelSymbolSeed,
  index: number,
) {
  return {
    id: `outline:${symbolId(moduleName, symbol.name)}`,
    nodeId: symbolId(moduleName, symbol.name),
    label: symbol.name,
    kind: symbol.kind,
    startLine: 20 + index * 3,
    topLevel: true,
  };
}

export function moduleExtraSymbolsForModule(state: MockWorkspaceState, moduleName: string) {
  return state.moduleExtraSymbols.filter((symbol) => symbol.moduleName === moduleName);
}

export function mockModuleSymbolCount(state: MockWorkspaceState, moduleName: string) {
  const baseCount =
    moduleName === "helm.ui.api"
      ? 6
      : moduleName === "helm.cli" || moduleName === "helm.graph.models"
        ? 1
        : 0;
  const createdInUi = moduleName === "helm.ui.api" ? state.uiApiExtraSymbols.length : 0;
  return baseCount + createdInUi + moduleExtraSymbolsForModule(state, moduleName).length;
}

export function mockSymbolBlock(symbol: MockTopLevelSymbolSeed) {
  return symbol.kind === "class"
    ? `class ${symbol.name}:\n    pass\n`
    : `def ${symbol.name}() -> None:\n    pass\n`;
}

export function moduleExtraBlocks(state: MockWorkspaceState, moduleName: string) {
  const seeds: MockTopLevelSymbolSeed[] = [
    ...(moduleName === "helm.ui.api" ? state.uiApiExtraSymbols : []),
    ...moduleExtraSymbolsForModule(state, moduleName),
  ];
  return seeds.map((symbol) => mockSymbolBlock(symbol)).join("\n");
}

export function appendModuleBlocks(baseContent: string, extraBlocks: string) {
  const trimmedBase = baseContent.trimEnd();
  if (!extraBlocks) {
    return trimmedBase;
  }
  if (!trimmedBase) {
    return extraBlocks.trimEnd();
  }
  return `${trimmedBase}\n\n${extraBlocks}`.trimEnd();
}

export function mockModulePosition(index: number) {
  const column = Math.floor(index / 4);
  const row = index % 4;
  return {
    x: 640 + column * 280,
    y: 60 + row * 150,
  };
}
