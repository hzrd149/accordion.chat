import { useEffect, useState } from "react";
import {
  applyAppearance, getStoredAppearance, resolveThemeSlot, setAppearance,
  setTheme, setThemeSlot, toggleResolvedTheme, THEME_CHANGE_EVENT,
  type AppearanceConfig, type ThemeMode, type ThemeSlot, type ThemeChoice,
} from "../services/theme";

export function useTheme(): {
  config: AppearanceConfig;
  pref: ThemeMode;
  resolved: ThemeSlot;
  activeChoice: ThemeChoice;
  setAppearance: (config: AppearanceConfig) => void;
  setMode: (mode: ThemeMode) => void;
  setTheme: (mode: ThemeMode) => void;
  setSlotTheme: (slot: ThemeSlot, choice: ThemeChoice) => void;
  toggleResolvedTheme: () => void;
} {
  const [config, setConfig] = useState<AppearanceConfig>(getStoredAppearance);

  useEffect(() => {
    const onChange = () => {
      const next = getStoredAppearance();
      applyAppearance(next);
      setConfig(next);
    };
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onChange);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onChange);
      mq.removeEventListener("change", onChange);
    };
  }, []);

  const resolved = resolveThemeSlot(config.mode);
  return {
    config,
    pref: config.mode,
    resolved,
    activeChoice: config[resolved],
    setAppearance,
    setMode: setTheme,
    setTheme,
    setSlotTheme: setThemeSlot,
    toggleResolvedTheme,
  };
}
