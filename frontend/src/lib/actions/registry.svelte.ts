import {
  registerGlobal as _registerGlobal,
  registerContextual as _registerContextual,
  unregisterContextual as _unregisterContextual,
  getAction,
  getAllActions,
  getActionsByCategory,
} from './registry.js';
import type { Action } from './types.js';

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

export { getAction, getAllActions, getActionsByCategory };
