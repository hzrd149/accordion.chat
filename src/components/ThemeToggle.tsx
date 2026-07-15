import { Moon, Sun } from "lucide-react";
import { useTheme } from "../lib/theme";

/**
 * Compact account-bar toggle: flips between the configured light and dark slots.
 * The full slot selection, including system mode, lives in Appearance settings.
 */
export function ThemeToggle() {
  const { resolved, toggleResolvedTheme } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      className="btn btn-ghost btn-sm btn-circle"
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      onClick={toggleResolvedTheme}
    >
      {resolved === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
