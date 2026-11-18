import type { ReactNode } from "react";

/** A bordered card holding a toggle switch, a label and a one-line hint. */
export function ToggleCard({ checked, onChange, label, hint, disabled }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-3 p-3.5 rounded-lg border border-base-300 bg-base-200 max-w-[440px] ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        className="toggle toggle-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex flex-col gap-px text-left">
        <span className="font-semibold">{label}</span>
        {hint && <span className="text-xs opacity-60">{hint}</span>}
      </span>
    </label>
  );
}
