import { CUSTOMER_DESTINATIONS } from "../concepts/nav.js";
import {
  ADMIN_TAB_LABEL,
  ADMIN_TABS,
  SUPPORT_SECTION_LABEL,
  SUPPORT_SECTIONS,
} from "../concepts/staffNav.js";

const CUSTOMER_LABELS: Record<string, string> = {
  "/dashboard": "Workspace",
  "/agents": "Agents",
  "/rooms": "Agent Rooms",
  "/deployments": "Deployments",
  "/servers": "Servers",
  "/models": "Models",
  "/integrations": "Apps & Integrations",
  "/channels": "Channels",
  "/usage": "Usage",
  "/billing": "Billing",
  "/backups": "Backups",
  "/settings": "Settings",
};

export const EXPECTED_CUSTOMER_LANDMARKS = CUSTOMER_DESTINATIONS.map((route) => ({
  surface: "customer" as const,
  route,
  landmark: CUSTOMER_LABELS[route] ?? "",
}));

export const EXPECTED_ADMIN_LANDMARKS = ADMIN_TABS.map((tab) => ({
  surface: "admin" as const,
  route: `/admin#${tab}`,
  landmark: ADMIN_TAB_LABEL[tab],
}));

export const EXPECTED_SUPPORT_LANDMARKS = SUPPORT_SECTIONS.map((section) => ({
  surface: "support" as const,
  route: `/support#${section}`,
  landmark: SUPPORT_SECTION_LABEL[section],
}));

export const EXPECTED_PAGE_LANDMARKS = [
  ...EXPECTED_CUSTOMER_LANDMARKS,
  ...EXPECTED_ADMIN_LANDMARKS,
  ...EXPECTED_SUPPORT_LANDMARKS,
];
