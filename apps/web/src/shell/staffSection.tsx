import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { useNavSection } from "../router.js";

/**
 * Shared Admin/Support section state. Studio's NavAdapter wins when present
 * so sidebar clicks stay on `/__ui`. Production uses local shell state.
 */
const StaffSectionContext = createContext<{
  section: string;
  setSection: (section: string) => void;
} | null>(null);

export function StaffSectionProvider({
  defaultSection,
  children,
}: {
  defaultSection: string;
  children: ReactNode;
}) {
  const preview = useNavSection();
  const [local, setLocal] = useState(defaultSection);
  const section = preview.section ?? local;
  const setSection = (next: string) => {
    if (preview.setSection) preview.setSection(next);
    else setLocal(next);
  };
  return <StaffSectionContext.Provider value={{ section, setSection }}>{children}</StaffSectionContext.Provider>;
}

export function useStaffSection(): { section: string | undefined; setSection: ((section: string) => void) | undefined } {
  const preview = useNavSection();
  const ctx = useContext(StaffSectionContext);
  return {
    section: preview.section ?? ctx?.section,
    setSection: preview.setSection ?? ctx?.setSection,
  };
}
