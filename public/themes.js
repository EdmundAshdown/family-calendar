/* Family Board — themes.js
 * Each theme is a full set of CSS variable values. Applying a theme just
 * overwrites these custom properties on the root element, so nothing else
 * in the app needs to know or care which theme is active.
 *
 * Want to tweak one? Edit its hex values here — every screen that uses
 * that color (buttons, today's highlight, event chips, nav) updates
 * automatically since they all read from the same variables.
 */

const THEMES = [
  {
    id: "ledger",
    label: "Ledger",
    description: "Warm paper and ink — like a bound family planner.",
    headingFont: "'Lora', serif",
    gradientStrength: "18%",
    numeralTop: "-0.15em",
    vars: {
      bg: "#ece2cd",
      panel: "#f5efe0",
      "panel-raised": "#f9f3e6",
      border: "#d9cbae",
      accent: "#7a3f4a",
      "accent-dim": "#c9a8ac",
      "on-accent": "#f7ece7",
      text: "#23283a",
      "text-muted": "#8c8368",
      danger: "#a13f3f",
    },
  },
  {
    id: "dusk",
    label: "Dusk",
    description: "Deep indigo evening, warm coral highlights.",
    headingFont: "'Space Grotesk', sans-serif",
    gradientStrength: "38%",
    numeralTop: "-0.15em",
    vars: {
      bg: "#171a2b",
      panel: "#1f2338",
      "panel-raised": "#242847",
      border: "#2f3454",
      accent: "#f0806b",
      "accent-dim": "#6b3d35",
      "on-accent": "#2a1310",
      text: "#e4e7f5",
      "text-muted": "#8a8fb0",
      danger: "#e0645a",
    },
  },
  {
    id: "chalkboard",
    label: "Chalkboard",
    description: "The kitchen chalkboard calendar, gone digital.",
    headingFont: "'Caveat', cursive",
    gradientStrength: "38%",
    numeralTop: "-0.24em",
    vars: {
      bg: "#24312a",
      panel: "#1c261f",
      "panel-raised": "#2d3a31",
      border: "#3a4a3f",
      accent: "#e8d67a",
      "accent-dim": "#7a7040",
      "on-accent": "#2a2508",
      text: "#eef2ea",
      "text-muted": "#a9b3a5",
      danger: "#d1655a",
    },
  },
  {
    id: "chambray",
    label: "Chambray",
    description: "Soft denim blue with a mustard accent — casual and light.",
    headingFont: "'Poppins', sans-serif",
    gradientStrength: "18%",
    numeralTop: "-0.15em",
    vars: {
      bg: "#dce6ee",
      panel: "#eaf1f6",
      "panel-raised": "#f3f8fb",
      border: "#b9cddb",
      accent: "#8a5c19",
      "accent-dim": "#d8c39a",
      "on-accent": "#fff8ea",
      text: "#223142",
      "text-muted": "#71859c",
      danger: "#b3453f",
    },
  },
  {
    id: "sage",
    label: "Sage kitchen",
    description: "Sage green and cream with a dusty rose accent.",
    headingFont: "'Cormorant Garamond', serif",
    gradientStrength: "18%",
    numeralTop: "-0.32em",
    vars: {
      bg: "#e7ead9",
      panel: "#f1f3e8",
      "panel-raised": "#f7f8f0",
      border: "#cdd3b8",
      accent: "#8a3f52",
      "accent-dim": "#cfa7b2",
      "on-accent": "#fbeef1",
      text: "#33402c",
      "text-muted": "#848c68",
      danger: "#a8453f",
    },
  },
  {
    id: "harbor",
    label: "Harbor",
    description: "Deep teal-slate with a warm brass accent.",
    headingFont: "'Oswald', sans-serif",
    gradientStrength: "38%",
    numeralTop: "-0.16em",
    vars: {
      bg: "#16262b",
      panel: "#1c2f35",
      "panel-raised": "#24393f",
      border: "#2f474d",
      accent: "#c9974f",
      "accent-dim": "#6b552f",
      "on-accent": "#1a1206",
      text: "#e2ece9",
      "text-muted": "#7fa19c",
      danger: "#d1655a",
    },
  },
  {
    id: "berry-frost",
    label: "Berry frost",
    description: "Cool plum-gray dusk with a berry-pink accent.",
    headingFont: "'Syne', sans-serif",
    gradientStrength: "38%",
    numeralTop: "-0.29em",
    vars: {
      bg: "#262233",
      panel: "#2f2a40",
      "panel-raised": "#38324c",
      border: "#453f5c",
      accent: "#c96b8f",
      "accent-dim": "#6b3d51",
      "on-accent": "#2a1420",
      text: "#eee9f5",
      "text-muted": "#9d94b8",
      danger: "#d15a70",
    },
  },
  {
    id: "newspaper",
    label: "Newspaper",
    description: "Near-white newsprint, black ink, a stamped red accent.",
    headingFont: "'Playfair Display', serif",
    gradientStrength: "18%",
    numeralTop: "-0.3em",
    vars: {
      bg: "#f7f7f4",
      panel: "#ffffff",
      "panel-raised": "#fbfbf9",
      border: "#d6d6d1",
      accent: "#a4231f",
      "accent-dim": "#d9b9b7",
      "on-accent": "#fbf3f2",
      text: "#1a1a18",
      "text-muted": "#6b6b66",
      danger: "#8a1f1f",
    },
  },
];

const THEME_KEY = "familyBoard.theme";

function getStoredThemeId() {
  return localStorage.getItem(THEME_KEY) || THEMES[0].id;
}

function applyTheme(themeId) {
  const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];
  Object.entries(theme.vars).forEach(([key, value]) => {
    document.documentElement.style.setProperty(`--${key}`, value);
  });
  document.documentElement.style.setProperty("--heading-font", theme.headingFont);
  document.documentElement.style.setProperty("--gradient-strength", theme.gradientStrength);
  document.documentElement.style.setProperty("--numeral-top", theme.numeralTop);
  localStorage.setItem(THEME_KEY, theme.id);
}

// Apply whatever was last picked (or Ledger, the first time) immediately,
// so the board doesn't flash the default theme before switching.
applyTheme(getStoredThemeId());
