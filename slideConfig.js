/**
 * Slide configuration for TV Ads video generation.
 * Each slide type defines:
 *  - templateKey: S3 key for the background image
 *  - duration: seconds this slide shows in the video
 *  - textZones: array of text placement areas (x, y, width, height, style)
 *  - type: "static" (fixed content) | "brand" (per-client branding) | "menu" (menu items)
 */

const SLIDE_WIDTH = 1366;
const SLIDE_HEIGHT = 768;

const slideTemplates = {
  // ── Opening brand slide (e.g., Chopstix Co.) ──
  brandIntro: {
    templateKey: "templates/brand-intro.png",
    duration: 4,
    type: "brand",
    textZones: [
      {
        id: "brandName",
        x: 400,
        y: 300,
        width: 900,
        height: 100,
        style: {
          fontSize: 56,
          fontWeight: "bold",
          color: "#FFFFFF",
          align: "center",
        },
      },
      {
        id: "tagline",
        x: 400,
        y: 420,
        width: 900,
        height: 60,
        style: {
          fontSize: 28,
          fontWeight: "normal",
          color: "#FFD700",
          align: "center",
        },
      },
    ],
  },

  // ── Top Selling section header ──
  topSellingHeader: {
    templateKey: "templates/top-selling-header.png",
    duration: 3,
    type: "static",
    textZones: [
      {
        id: "counterName",
        x: 350,
        y: 380,
        width: 700,
        height: 80,
        style: {
          fontSize: 36,
          fontWeight: "bold",
          color: "#333333",
          align: "center",
        },
      },
    ],
  },

  // ── Menu items slide (shows 3-4 items per slide) ──
  menuItems: {
    templateKey: "templates/menu-items.png",
    duration: 6,
    type: "menu",
    itemsPerSlide: 4,
    textZones: [
      {
        id: "item1_name",
        x: 580,
        y: 80,
        width: 700,
        height: 50,
        style: { fontSize: 32, fontWeight: "bold", color: "#222222", align: "left" },
      },
      {
        id: "item1_price",
        x: 580,
        y: 135,
        width: 700,
        height: 40,
        style: { fontSize: 26, fontWeight: "normal", color: "#E65100", align: "left" },
      },
      {
        id: "item1_desc",
        x: 580,
        y: 170,
        width: 700,
        height: 35,
        style: { fontSize: 20, fontWeight: "normal", color: "#666666", align: "left" },
      },
      {
        id: "item2_name",
        x: 580,
        y: 250,
        width: 700,
        height: 50,
        style: { fontSize: 32, fontWeight: "bold", color: "#222222", align: "left" },
      },
      {
        id: "item2_price",
        x: 580,
        y: 305,
        width: 700,
        height: 40,
        style: { fontSize: 26, fontWeight: "normal", color: "#E65100", align: "left" },
      },
      {
        id: "item2_desc",
        x: 580,
        y: 340,
        width: 700,
        height: 35,
        style: { fontSize: 20, fontWeight: "normal", color: "#666666", align: "left" },
      },
      {
        id: "item3_name",
        x: 580,
        y: 420,
        width: 700,
        height: 50,
        style: { fontSize: 32, fontWeight: "bold", color: "#222222", align: "left" },
      },
      {
        id: "item3_price",
        x: 580,
        y: 475,
        width: 700,
        height: 40,
        style: { fontSize: 26, fontWeight: "normal", color: "#E65100", align: "left" },
      },
      {
        id: "item3_desc",
        x: 580,
        y: 510,
        width: 700,
        height: 35,
        style: { fontSize: 20, fontWeight: "normal", color: "#666666", align: "left" },
      },
      {
        id: "item4_name",
        x: 580,
        y: 590,
        width: 700,
        height: 50,
        style: { fontSize: 32, fontWeight: "bold", color: "#222222", align: "left" },
      },
      {
        id: "item4_price",
        x: 580,
        y: 645,
        width: 700,
        height: 40,
        style: { fontSize: 26, fontWeight: "normal", color: "#E65100", align: "left" },
      },
      {
        id: "item4_desc",
        x: 580,
        y: 680,
        width: 700,
        height: 35,
        style: { fontSize: 20, fontWeight: "normal", color: "#666666", align: "left" },
      },
    ],
  },

  // ── Party orders / catering slide ──
  partyOrders: {
    templateKey: "templates/party-orders.png",
    duration: 5,
    type: "static",
    textZones: [],
  },

  // ── Download app slide ──
  downloadApp: {
    templateKey: "templates/download-app.png",
    duration: 5,
    type: "static",
    textZones: [],
  },

  // ── Corporate cafeteria slide ──
  corporateCafeteria: {
    templateKey: "templates/corporate-cafeteria.png",
    duration: 5,
    type: "static",
    textZones: [],
  },
};

/**
 * Defines the video sequence order.
 * Use slideType references + repeat patterns for menu slides.
 */
const defaultSequence = [
  { slideType: "corporateCafeteria" },
  { slideType: "brandIntro", perClient: true },
  { slideType: "topSellingHeader", perClient: true },
  { slideType: "menuItems", perClient: true },
  { slideType: "partyOrders" },
  { slideType: "downloadApp" },
];

module.exports = {
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
  slideTemplates,
  defaultSequence,
};
