let toasts = $state<Array<{ id: number; message: string; variant: 'error' | 'info' }>>([]);

let nextId = 0;

export function showToast(message: string, variant: 'error' | 'info' = 'error', durationMs = 5000): void {
  const id = nextId++;
  toasts = [...toasts, { id, message, variant }];
  setTimeout(() => dismissToast(id), durationMs);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter(t => t.id !== id);
}

export function getToasts(): Array<{ id: number; message: string; variant: 'error' | 'info' }> {
  return toasts;
}
