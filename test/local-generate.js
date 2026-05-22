/**
 * Local test: Generates a TV Ad video using real CDN slide templates + mock data.
 * Simulates the exact flow of services.js without AWS dependencies.
 *
 * Architecture:
 *   Slide 1 (static) → Client menus (Slide 3) → Counter menus (white bg + logo) → Slide 9 → Slide 10
 *
 * Usage: node test/local-generate.js
 * Output: test/output/tv-ad-demo.mp4
 */

const sharp = require("sharp");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const OUTPUT_DIR = path.join(__dirname, "output");
const TMP_DIR = path.join(OUTPUT_DIR, "slides");
const FFMPEG_PATH = "ffmpeg";
const SLIDE_WIDTH = 1366;
const SLIDE_HEIGHT = 768;
const CDN_PREFIX = "https://d2nahbmqd5vvug.cloudfront.net/nxtmeal";

// ══════════════════════════════════════════
// MOCK DATA - simulates DynamoDB responses
// ══════════════════════════════════════════

const mockInput = {
  subLocationID: "SUB-LOC-001",
  menuType: "lunch",
  date: "2025/05/22",
};

// Clients (isFixedMenu = true, daily menus by date + menuType)
const mockClients = [
  { clientID: "client-001", clientName: "Flavour Hub", type: "CLIENT", subLocationID: "SUB-LOC-001", isFixedMenu: true },
];

// Counters (QSR menus, no date/menuType)
const mockCounters = [
  {
    clientID: "counter-001", clientName: "Dakshin Delight", counterName: "Dakshin Delight",
    type: "COUNTER", subLocationID: "SUB-LOC-001",
    s3Url: "https://d2nahbmqd5vvug.cloudfront.net/nxtmeal/dakshin-delight-logo.png",
  },
  {
    clientID: "counter-002", clientName: "Chopstix Co.", counterName: "Chopstix Co.",
    type: "COUNTER", subLocationID: "SUB-LOC-001",
    s3Url: "https://d2nahbmqd5vvug.cloudfront.net/nxtmeal/chopstix-logo.png",
  },
];

// Daily menus for client (filtered by date + menuType=lunch)
const mockDailyMenus = {
  "client-001": [
    { menuName: "Paneer Butter Masala", itemPrice: 220, itemDescription: "Creamy tomato gravy with paneer cubes", menuType: "lunch" },
    { menuName: "Dal Makhani", itemPrice: 180, itemDescription: "Slow-cooked black lentils", menuType: "lunch" },
    { menuName: "Jeera Rice", itemPrice: 100, itemDescription: "Cumin-flavored basmati rice", menuType: "lunch" },
    { menuName: "Butter Naan (2 pcs)", itemPrice: 60, itemDescription: "Soft tandoor bread", menuType: "lunch" },
    { menuName: "Chicken Biryani", itemPrice: 260, itemDescription: "Fragrant basmati with chicken", menuType: "lunch" },
    { menuName: "Raita", itemPrice: 50, itemDescription: "Cool yogurt with cucumber", menuType: "lunch" },
  ],
};

// QSR menus for counters (no date/menuType filter)
const mockQsrMenus = {
  "counter-001": [
    { itemName: "Masala Dosa", itemPrice: 120 },
    { itemName: "Idli Sambar (3 pcs)", itemPrice: 80 },
    { itemName: "Medu Vada (2 pcs)", itemPrice: 70 },
    { itemName: "Rava Dosa", itemPrice: 130 },
    { itemName: "Filter Coffee", itemPrice: 40 },
  ],
  "counter-002": [
    { itemName: "Veg Fried Rice", itemPrice: 150 },
    { itemName: "Chicken Manchurian", itemPrice: 220 },
    { itemName: "Hakka Noodles", itemPrice: 180 },
    { itemName: "Spring Rolls (4 pcs)", itemPrice: 120 },
    { itemName: "Sweet Corn Soup", itemPrice: 90 },
    { itemName: "Chilli Paneer", itemPrice: 200 },
  ],
};

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      https.get(requestUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          makeRequest(response.headers.location);
        } else if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        } else {
          const file = fs.createWriteStream(destPath);
          response.pipe(file);
          file.on("finish", () => { file.close(); resolve(destPath); });
          file.on("error", reject);
        }
      }).on("error", reject);
    };
    makeRequest(url);
  });
}

function escapeXml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Compose CLIENT menu slide (Slide 3 template: food left, text right)
 */
async function composeClientMenuSlide(templatePath, menuItems, clientName, outputPath) {
  const items = menuItems.slice(0, 4);
  let svgElements = "";

  // Client name at top-right
  svgElements += `<text x="620" y="60" font-size="28" font-weight="bold" fill="#333333" font-family="Arial, Helvetica, sans-serif">${escapeXml(clientName)}</text>`;

  items.forEach((item, idx) => {
    const baseY = 110 + idx * 160;
    const name = item.menuName || item.itemName || "";
    const price = item.itemPrice || item.price || "";
    const desc = item.itemDescription || "";

    svgElements += `<text x="620" y="${baseY}" font-size="30" font-weight="bold" fill="#222222" font-family="Arial, Helvetica, sans-serif">${escapeXml(name)}</text>`;
    svgElements += `<text x="620" y="${baseY + 38}" font-size="22" font-weight="normal" fill="#E65100" font-family="Arial, Helvetica, sans-serif">Rs.${escapeXml(String(price))}</text>`;
    if (desc) {
      svgElements += `<text x="620" y="${baseY + 66}" font-size="16" font-weight="normal" fill="#666666" font-family="Arial, Helvetica, sans-serif">${escapeXml(desc.substring(0, 50))}</text>`;
    }
  });

  const svg = `<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">${svgElements}</svg>`;

  await sharp(templatePath)
    .resize(SLIDE_WIDTH, SLIDE_HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outputPath);
}

/**
 * Compose COUNTER menu slide (white bg + logo + name + items in 2 columns)
 */
async function composeCounterMenuSlide(counter, menuItems, outputPath) {
  const items = menuItems.slice(0, 6);
  const counterName = counter.counterName || counter.clientName || "";
  const composites = [];

  // Try to download logo
  if (counter.s3Url) {
    const logoPath = path.join(TMP_DIR, `logo_${counter.clientID}.png`);
    try {
      if (!fs.existsSync(logoPath)) {
        await downloadFile(counter.s3Url, logoPath);
      }
      const logoBuffer = await sharp(logoPath)
        .resize(150, 150, { fit: "inside", background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png()
        .toBuffer();
      composites.push({ input: logoBuffer, top: 25, left: 40 });
    } catch (e) {
      console.log(`   (logo download failed for ${counterName}: ${e.message})`);
    }
  }

  // Text overlay SVG
  let svgElements = "";
  svgElements += `<text x="220" y="80" font-size="36" font-weight="bold" fill="#222222" font-family="Arial, Helvetica, sans-serif">${escapeXml(counterName)}</text>`;
  svgElements += `<line x1="40" y1="180" x2="1326" y2="180" stroke="#E0E0E0" stroke-width="2"/>`;

  items.forEach((item, idx) => {
    const col = idx < 3 ? 0 : 1;
    const row = idx < 3 ? idx : idx - 3;
    const baseX = col === 0 ? 80 : 720;
    const baseY = 230 + row * 160;
    const name = item.itemName || item.menuName || "";
    const price = item.itemPrice || item.price || "";

    svgElements += `<text x="${baseX}" y="${baseY}" font-size="28" font-weight="bold" fill="#222222" font-family="Arial, Helvetica, sans-serif">${escapeXml(name)}</text>`;
    svgElements += `<text x="${baseX}" y="${baseY + 40}" font-size="22" font-weight="normal" fill="#E65100" font-family="Arial, Helvetica, sans-serif">Rs.${escapeXml(String(price))}</text>`;
  });

  const svg = `<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">${svgElements}</svg>`;
  composites.push({ input: Buffer.from(svg), top: 0, left: 0 });

  await sharp({
    create: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

// ══════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════

async function main() {
  console.log("TV Ads Generator - Architecture Test");
  console.log("=====================================");
  console.log(`Input: subLocationID=${mockInput.subLocationID}, menuType=${mockInput.menuType}, date=${mockInput.date}\n`);

  // Setup
  if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // Download static slides from CDN
  console.log("Downloading static slides from CDN...");
  const staticSlides = ["Slide 1", "Slide 3", "Slide 9", "Slide 10"];
  const templatePaths = {};
  for (const name of staticSlides) {
    const localPath = path.join(TMP_DIR, `${name}.png`);
    await downloadFile(`${CDN_PREFIX}/${name}.png`, localPath);
    templatePaths[name] = localPath;
    const stats = fs.statSync(localPath);
    console.log(`   OK  ${name}.png (${(stats.size / 1024).toFixed(0)} KB)`);
  }
  console.log("");

  const slides = [];
  let slideIndex = 0;

  // ── Slide 1: Opening (static) ──
  const openingPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(templatePaths["Slide 1"]).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(openingPath);
  slides.push({ imagePath: openingPath, duration: 5 });
  console.log(`[${slides.length}] Slide 1 - Opening (5s) STATIC`);

  // ── Client menu slides (Slide 3 template) ──
  console.log("\n--- CLIENTS (daily menus, Slide 3 template) ---");
  for (const client of mockClients) {
    const menus = mockDailyMenus[client.clientID] || [];
    console.log(`   ${client.clientName}: ${menus.length} items for ${mockInput.menuType}`);

    for (let i = 0; i < menus.length; i += 4) {
      const chunk = menus.slice(i, i + 4);
      const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
      await composeClientMenuSlide(templatePaths["Slide 3"], chunk, client.clientName, outputPath);
      slides.push({ imagePath: outputPath, duration: 6 });
      console.log(`   [${slides.length}] ${client.clientName} items ${i + 1}-${i + chunk.length} (6s)`);
    }
  }

  // ── Counter menu slides (white bg + logo + items) ──
  console.log("\n--- COUNTERS (QSR menus, white bg + logo) ---");
  for (const counter of mockCounters) {
    const menus = mockQsrMenus[counter.clientID] || [];
    console.log(`   ${counter.counterName}: ${menus.length} QSR items`);

    for (let i = 0; i < menus.length; i += 6) {
      const chunk = menus.slice(i, i + 6);
      const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
      await composeCounterMenuSlide(counter, chunk, outputPath);
      slides.push({ imagePath: outputPath, duration: 6 });
      console.log(`   [${slides.length}] ${counter.counterName} items ${i + 1}-${i + chunk.length} (6s)`);
    }
  }

  // ── Slide 9: Party Orders (static) ──
  console.log("\n--- CLOSING ---");
  const partyPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(templatePaths["Slide 9"]).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(partyPath);
  slides.push({ imagePath: partyPath, duration: 5 });
  console.log(`[${slides.length}] Slide 9 - Party Orders (5s) STATIC`);

  // ── Slide 10: Download App (static) ──
  const appPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(templatePaths["Slide 10"]).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(appPath);
  slides.push({ imagePath: appPath, duration: 5 });
  console.log(`[${slides.length}] Slide 10 - Download App (5s) STATIC`);

  // ── Stitch ──
  const totalDuration = slides.reduce((sum, s) => sum + s.duration, 0);
  console.log(`\nTotal: ${slides.length} slides, ${totalDuration}s`);
  console.log("\nStitching MP4...");

  const concatFilePath = path.join(TMP_DIR, "concat.txt");
  const lines = slides.map((s) => `file '${s.imagePath}'\nduration ${s.duration}`);
  lines.push(`file '${slides[slides.length - 1].imagePath}'`);
  fs.writeFileSync(concatFilePath, lines.join("\n"));

  const videoOutputPath = path.join(OUTPUT_DIR, "tv-ad-demo.mp4");
  const cmd = [
    FFMPEG_PATH, "-y", "-f concat", "-safe 0",
    `-i "${concatFilePath}"`,
    `-vf "scale=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:(ow-iw)/2:(oh-ih)/2"`,
    "-vsync vfr", "-pix_fmt yuv420p", "-c:v libx264", "-preset fast", "-crf 23",
    `"${videoOutputPath}"`,
  ].join(" ");

  execSync(cmd, { stdio: "pipe", timeout: 60000 });
  const stats = fs.statSync(videoOutputPath);
  console.log(`   Video: ${videoOutputPath}`);
  console.log(`   Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
