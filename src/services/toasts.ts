import { BehaviorSubject } from "rxjs";

export type ToastType = "info" | "success" | "warning" | "error";

export type Toast = {
  id: number;
  type: ToastType;
  message: string;
};

const DEFAULT_DURATION_MS: Record<ToastType, number> = {
  info: 3000,
  success: 3000,
  warning: 5000,
  error: 6000,
};

/** The toasts currently on screen, oldest first. */
export const toasts$ = new BehaviorSubject<Toast[]>([]);

let nextId = 1;

export function dismissToast(id: number) {
  toasts$.next(toasts$.value.filter((t) => t.id !== id));
}

/** Show a transient notification in the app-wide toast stack. Returns its id. */
export function toast(message: string, type: ToastType = "info", durationMs = DEFAULT_DURATION_MS[type]) {
  const id = nextId++;
  // Replace an identical toast still on screen rather than stacking duplicates.
  const rest = toasts$.value.filter((t) => t.message !== message || t.type !== type);
  toasts$.next([...rest, { id, type, message }]);
  if (durationMs > 0) setTimeout(() => dismissToast(id), durationMs);
  return id;
}

export function toastSuccess(message: string) {
  return toast(message, "success");
}

/** Show an error toast from an unknown thrown value, with a fallback message. */
export function toastError(error: unknown, fallback = "Something went wrong") {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return toast(message || fallback, "error");
}
