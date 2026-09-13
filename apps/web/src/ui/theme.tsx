import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "dark",
  setTheme: () => {},
});

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch (e) {}
  return null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    try {
      const saved = getStorage()?.getItem("mox.theme");
      if (saved === "light" || saved === "dark" || saved === "system") {
        return saved;
      }
    } catch (e) {}
    return "system";
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");

  useEffect(() => {
    const root = document.documentElement;
    const isSystemLight = window.matchMedia("(prefers-color-scheme: light)");

    const resolveCurrentTheme = () => {
      if (theme === "system") {
        return isSystemLight.matches ? "light" : "dark";
      }
      return theme;
    };

    const applyTheme = () => {
      const current = resolveCurrentTheme();
      setResolvedTheme(current);
      root.setAttribute("data-theme", current);
      root.style.colorScheme = current;
    };

    applyTheme();

    const listener = (e: MediaQueryListEvent) => {
      if (theme === "system") {
        applyTheme();
      }
    };

    isSystemLight.addEventListener("change", listener);
    return () => isSystemLight.removeEventListener("change", listener);
  }, [theme]);

  const setTheme = (newTheme: ThemePreference) => {
    try {
      getStorage()?.setItem("mox.theme", newTheme);
    } catch (e) {}
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

