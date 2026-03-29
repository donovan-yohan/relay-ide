import type { Action, ActionCategory } from './types.js';

const globalActions = new Map<string, Action>();
const contextualActions = new Map<string, Action>();

export function registerGlobal(actions: Action[]): void {
  for (const action of actions) {
    if (contextualActions.has(action.id)) {
      throw new Error(`Action "${action.id}" is already registered as contextual`);
    }
    globalActions.set(action.id, action);
  }
}

export function registerContextual(actions: Action[]): void {
  for (const action of actions) {
    if (globalActions.has(action.id) || contextualActions.has(action.id)) {
      throw new Error(`Action "${action.id}" is already registered`);
    }
    contextualActions.set(action.id, action);
  }
}

export function unregisterContextual(ids: string[]): void {
  for (const id of ids) {
    contextualActions.delete(id);
  }
}

export function getAction(id: string): Action | undefined {
  return globalActions.get(id) ?? contextualActions.get(id);
}

export function getAllActions(): Action[] {
  return [...globalActions.values(), ...contextualActions.values()];
}

export function getActionsByCategory(category: ActionCategory): Action[] {
  return getAllActions().filter(a => a.category === category);
}

/** Reset all state — for testing only. */
export function _resetForTesting(): void {
  globalActions.clear();
  contextualActions.clear();
}
