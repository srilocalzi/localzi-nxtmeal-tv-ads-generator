const SLIDE_WIDTH = 1366;
const SLIDE_HEIGHT = 768;

const DEFAULT_INTRO_SLIDES = ["Slide 1"];
const DEFAULT_OUTRO_SLIDES = ["Slide 9", "Slide 10"];
const DEFAULT_THEME_COLORS = [
  "#F6D233",
  "#286C39",
  "#F46C16",
  "#D52516",
  "#943E96",
  "#3A4B9E",
  "#0C3F38",
];
const DEFAULT_COUNTER_NAME_OPTIONS = [
  "Dakshin Delight",
  "FlavourHub",
  "Grab & Go",
  "North Plate",
  "Beans & Bowls",
];

function parseCsvEnv(value, fallback) {
  if (!value || typeof value !== "string") {
    return fallback;
  }

  const entries = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : fallback;
}

const getIntroSlides = () => parseCsvEnv(process.env.INTRO_SLIDES, DEFAULT_INTRO_SLIDES);

const getOutroSlides = () => parseCsvEnv(process.env.OUTRO_SLIDES, DEFAULT_OUTRO_SLIDES);

const getThemeColors = () => parseCsvEnv(process.env.THEME_COLORS, DEFAULT_THEME_COLORS);

const getCounterNameOptions = () =>
  parseCsvEnv(process.env.COUNTER_NAME_OPTIONS, DEFAULT_COUNTER_NAME_OPTIONS);

// Slide durations (seconds)
const DURATIONS = {
  OPENING: 5,       // Slide 1
  CLIENT_MENU: 6,   // Slide 3 per chunk
  COUNTER_MENU: 6,  // Counter generated slides
  PARTY_ORDERS: 5,  // Slide 9
  DOWNLOAD_APP: 5,  // Slide 10
};

// Max items per slide
const ITEMS_PER_CLIENT_SLIDE = 4;   // Slide 3: 4 items on right side
const ITEMS_PER_COUNTER_SLIDE = 6;  // Counter: 6 items in 2-column layout

module.exports = {
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
  getIntroSlides,
  getOutroSlides,
  getThemeColors,
  getCounterNameOptions,
  DURATIONS,
  ITEMS_PER_CLIENT_SLIDE,
  ITEMS_PER_COUNTER_SLIDE,
};
