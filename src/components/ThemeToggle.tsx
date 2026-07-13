import { Moon, Sun } from "lucide-react";
import { useTheme } from "../lib/theme";

/**
 * Compact account-bar toggle: flips between light and dark. Since the default
 * is "system", the first click commits to the opposite of whatever the system
 * is currently showing; further clicks flip between explicit light/dark. The
 * three-way choice (incl. "follow system") lives in the Appearance settings.
 */
export function ThemeToggle() {
  const { resolved, setTheme } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      className="btn btn-ghost btn-sm btn-circle"
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {resolved === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
