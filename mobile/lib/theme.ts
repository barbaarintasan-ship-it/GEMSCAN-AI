// LuulScan design tokens — the single source of truth for spacing, radius,
// typography, shadows and color that every screen should draw from, so the
// app reads as one consistent product instead of per-screen ad-hoc styling.
// This formalizes the palette/scale already in use across the app (no brand
// redesign) rather than introducing new colors.
import { Platform } from "react-native";

export const colors = {
  bg: "#0B0B0C",
  surface: "#161618", // raised card on bg
  surfaceAlt: "#1A1A1D", // slightly lighter card (list rows, inputs)
  surfaceSunken: "#1C1A1D", // recessed chip/tile
  border: "#2A2A2C",
  borderSubtle: "#242123",

  text: "#F5F1E8",
  textMuted: "#C9C9CC",
  textFaint: "#8A8A8E",

  gold: "#C9A227",
  goldSoft: "rgba(201,162,39,0.12)",
  goldBorder: "rgba(201,162,39,0.35)",

  success: "#2E7D32",
  danger: "#E4685D",
  dangerStrong: "#E5484D",
  info: "#2f6bd6",

  confidenceHigh: "#2E7D32",
  confidenceMedium: "#C9A227",
  confidenceLow: "#8A8A8E",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 14,
  xl: 16,
  xxl: 20,
  pill: 999,
} as const;

export const type = {
  title: { fontSize: 26, fontWeight: "800" as const, color: colors.text },
  heading: { fontSize: 20, fontWeight: "700" as const, color: colors.text },
  subheading: { fontSize: 16, fontWeight: "700" as const, color: colors.text },
  body: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },
  bodySmall: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  caption: { fontSize: 12, color: colors.textFaint },
  label: {
    fontSize: 12,
    color: colors.textFaint,
    textTransform: "uppercase" as const,
    letterSpacing: 0.6,
    fontWeight: "700" as const,
  },
} as const;

// Subtle elevation — the app is currently flat (no shadows anywhere); these
// are deliberately soft so cards read as "lifted" without looking gaudy.
export const shadow = Platform.select({
  ios: {
    card: {
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
    },
    button: {
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
    },
  },
  default: {
    card: { elevation: 3 },
    button: { elevation: 2 },
  },
})!;

export const touchTarget = { minHeight: 44, minWidth: 44 };
