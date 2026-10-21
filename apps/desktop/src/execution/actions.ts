import { create } from "zustand";
export interface ExecutionActions {
  configName?: string;
  canRun: boolean;
  canStop: boolean;
  canRestart: boolean;
  run: () => void;
  stop: () => void;
  restart: () => void;
  show: () => void;
}
const idle: ExecutionActions = {
  canRun: false,
  canStop: false,
  canRestart: false,
  run: () => {},
  stop: () => {},
  restart: () => {},
  show: () => {},
};
export const useExecutionActions = create<ExecutionActions>(() => idle);
export function resetExecutionActions() {
  useExecutionActions.setState(idle);
}
