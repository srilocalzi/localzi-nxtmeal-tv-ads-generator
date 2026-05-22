/**
 * Slide configuration constants for TV Ads video generation.
 *
 * Static slides (always present in every video):
 *   - Slide 1: NXT Meal corporate cafeteria intro (position: FIRST)
 *   - Slide 9: Party orders CTA (position: SECOND LAST)
 *   - Slide 10: Download NXTMeal App (position: LAST)
 *
 * Dynamic slides:
 *   - Slide 3: Client menu template (food imagery left, menu items text right)
 *             Used for all clients (daily menus by date + menuType)
 *
 *   - Counter slides: Generated dynamically (white bg + logo + items)
 *             Used for all counters (QSR menus, no menuType filter)
 */

const SLIDE_WIDTH = 1366;
const SLIDE_HEIGHT = 768;

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
  DURATIONS,
  ITEMS_PER_CLIENT_SLIDE,
  ITEMS_PER_COUNTER_SLIDE,
};
