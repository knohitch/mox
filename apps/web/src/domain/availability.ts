export type FeatureAvailability =
  | { state: "available" }
  | { state: "not_configured"; reason?: string }
  | { state: "not_entitled"; reason?: string }
  | { state: "role_denied"; reason?: string }
  | { state: "provider_unavailable"; reason?: string };

export type AvailableFeature = Extract<FeatureAvailability, { state: "available" }>;

export const AVAILABLE: FeatureAvailability = { state: "available" };

export function isAvailable(a: FeatureAvailability): a is AvailableFeature {
  return a.state === "available";
}

export function notConfigured(reason?: string): { state: "not_configured"; reason?: string } {
  return { state: "not_configured", reason };
}

export function notEntitled(reason?: string): { state: "not_entitled"; reason?: string } {
  return { state: "not_entitled", reason };
}

export function roleDenied(reason?: string): { state: "role_denied"; reason?: string } {
  return { state: "role_denied", reason };
}

export function providerUnavailable(reason?: string): { state: "provider_unavailable"; reason?: string } {
  return { state: "provider_unavailable", reason };
}

export function availabilityLabel(a: FeatureAvailability): string {
  switch (a.state) {
    case "available":
      return "Available";
    case "not_configured":
      return "Not configured";
    case "not_entitled":
      return "Not entitled";
    case "role_denied":
      return "Role denied";
    case "provider_unavailable":
      return "Provider unavailable";
  }
}
