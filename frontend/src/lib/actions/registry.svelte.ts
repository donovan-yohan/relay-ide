import {
  registerGlobal as _registerGlobal,
  registerContextual as _registerContextual,
  unregisterContextual as _unregisterContextual,
  getAction as _getAction,
  getAllActions as _getAllActions,
  getActionsByCategory as _getActionsByCategory,
} from './registry.js';
import type { Action, ActionCategory } from './types.js';

let version = $state(0);

export function registerGlobal(actions: Action[]): void {
  _registerGlobal(actions);
  version++;
}

export function registerContextual(actions: Action[]): void {
  _registerContextual(actions);
  version++;
}

export function unregisterContextual(ids: string[]): void {
  _unregisterContextual(ids);
  version++;
}

/** Read inside $derived to track registry mutations. */
export function getRegistryVersion(): number {
  return version;
}

export function getAction(id: string): Action | undefined {
  void version;
  return _getAction(id);
}

export function getAllActions(): Action[] {
  void version;
  return _getAllActions();
}

export function getActionsByCategory(category: ActionCategory): Action[] {
  void version;
  return _getActionsByCategory(category);
}
