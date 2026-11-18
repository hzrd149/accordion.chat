import { X } from "lucide-react";
import { use$ } from "applesauce-react/hooks";
import { dismissToast, toasts$, type ToastType } from "../services/toasts";

const ALERT_CLASS: Record<ToastType, string> = {
  info: "alert-info",
  success: "alert-success",
  warning: "alert-warning",
  error: "alert-error",
};

/** App-wide daisyUI toast stack fed by `services/toasts`. Mount once at the root. */
export function Toaster() {
  const toasts = use$(toasts$) ?? [];
  if (toasts.length === 0) return null;
  return (
    <div className="toast toast-end toast-bottom z-[100] max-w-[min(420px,calc(100vw-2rem))]">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.type === "error" || t.type === "warning" ? "alert" : "status"}
          className={`alert ${ALERT_CLASS[t.type]} text-sm shadow-lg whitespace-normal break-words`}
        >
          <span className="min-w-0 flex-1">{t.message}</span>
          <button className="btn btn-ghost btn-xs btn-circle" title="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
