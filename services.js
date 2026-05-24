const AWS = require("aws-sdk");
const sharp = require("sharp");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const {
  log,
  getClientsTableName,
  getDailyMenusTableName,
  getQsrMenusTableName,
  getTvAdsTableName,
  getSlidesBucketName,
  getOutputBucketName,
  getCdnBaseUrl,
} = require("./utils");

const db = new AWS.DynamoDB.DocumentClient({ region: "ap-south-1" });
const s3 = new AWS.S3({ region: "ap-south-1" });

const TMP_DIR = "/tmp/tv-ads";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";
const SLIDE_WIDTH = 1366;
const SLIDE_HEIGHT = 768;
const CDN_BASE = getCdnBaseUrl();
const SLIDES_CDN_PREFIX = `${CDN_BASE}/nxtmeal`;

// Map menuType to slide template filename
const MENU_TYPE_SLIDE_MAP = {
  breakfast: "BreakfastSlide",
  lunch: "Lunch_DinnerSlide",
  snacks: "SnacksSlide",
  dinner: "Lunch_DinnerSlide",
};

// Map counter names to their slide template filenames on CDN
const COUNTER_SLIDE_MAP = {
  "chopstix co": "ChopstixSlide",
  "chopstix co.": "ChopstixSlide",
  "dakshin delight": "DakshinDelightSlide",
  "flavour hub": "FlavourHubSlide",
  "grab & go": "Grab&GoSlide",
  "grab and go": "Grab&GoSlide",
  "north plate": "NorthPlateSlide",
  "beans & bowls": "Beans&Bowls",
  "beans and bowls": "Beans&Bowls",
};

// ══════════════════════════════════════════
// DATA FETCHING
// ══════════════════════════════════════════

/**
 * Get all clients AND counters for a subLocationID.
 */
async function getEntitiesForSubLocation(subLocationID) {
  const params = {
    TableName: getClientsTableName(),
    IndexName: "subLocationID-index",
    KeyConditionExpression: "subLocationID = :slid",
    ExpressionAttributeValues: { ":slid": subLocationID },
  };

  const result = await db.query(params).promise();
  const items = result.Items || [];

  const counters = items.filter((i) => i.type === "COUNTER");
  const clients = items.filter((i) => i.type !== "COUNTER");

  return { clients, counters };
}

/**
 * Get daily menu items for a CLIENT on a specific date + menuType.
 */
async function getDailyMenus(clientID, date, menuType) {
  const params = {
    TableName: getDailyMenusTableName(),
    KeyConditionExpression: "clientID = :cid",
    ExpressionAttributeValues: { ":cid": clientID },
  };

  const result = await db.query(params).promise();
  let items = result.Items || [];

  // Filter by date
  if (date) {
    items = items.filter((item) => {
      const itemDate = item.date || item.sortKey?.split("#")[0] || "";
      return itemDate.includes(date.replace(/\//g, "-")) || itemDate.includes(date);
    });
  }

  // Filter by menuType
  if (menuType) {
    items = items.filter((item) => item.menuType?.toLowerCase() === menuType.toLowerCase());
  }

  // Exclude items with empty description (nothing to display)
  items = items.filter((item) => item.description && item.description.trim().length > 0);

  return items;
}

/**
 * Get QSR menu items for a COUNTER.
 */
async function getQsrMenus(clientID) {
  const params = {
    TableName: getQsrMenusTableName(),
    IndexName: "clientID-index",
    KeyConditionExpression: "clientID = :cid",
    ExpressionAttributeValues: { ":cid": clientID },
  };

  const result = await db.query(params).promise();
  let items = result.Items || [];
  items = items.filter((item) => !item.soldOut);
  return items;
}

// ══════════════════════════════════════════
// SLIDE COMPOSITION
// ══════════════════════════════════════════

/**
 * Download a slide from CDN.
 */
async function downloadSlideFromCdn(slideName) {
  const localPath = path.join(TMP_DIR, "templates", `${slideName}.png`);
  if (fs.existsSync(localPath)) return localPath;

  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const url = `${SLIDES_CDN_PREFIX}/${slideName}.png`;
  await downloadFile(url, localPath);
  return localPath;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      const client = requestUrl.startsWith("https") ? https : require("http");
      client.get(requestUrl, (response) => {
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

async function downloadLogo(logoUrl) {
  if (!logoUrl) return null;
  const hash = Buffer.from(logoUrl).toString("base64url").slice(0, 20);
  const localPath = path.join(TMP_DIR, "logos", `${hash}.png`);
  if (fs.existsSync(localPath)) return localPath;

  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    await downloadFile(logoUrl, localPath);
    return localPath;
  } catch (err) {
    log.warn("Failed to download logo", { logoUrl, error: err.message });
    return null;
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Compose a CLIENT menu slide using menuType-specific template.
 * Groups ALL templates for a menuType onto one slide using multi-column layout.
 * 
 * Layout:
 *   ClientName (centered)
 *   MenuType (centered)
 *   ───────────────────
 *   [Col 1]              [Col 2]
 *   TemplateName         TemplateName
 *   • item1              • item1
 *   • item2              • item2
 */
async function composeClientMenuSlide(templatePath, menuRecords, clientName, menuType, outputPath) {
  let svgElements = "";
  const centerX = SLIDE_WIDTH / 2;
  let headerY = 115;

  // Header: Client Name
  svgElements += `<text x="${centerX}" y="${headerY}" font-size="34" font-weight="bold" fill="#222222" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(clientName)}</text>`;
  headerY += 36;

  // Header: Menu Type
  svgElements += `<text x="${centerX}" y="${headerY}" font-size="22" font-weight="normal" fill="#E65100" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(menuType)}</text>`;
  headerY += 28;

  // Separator
  svgElements += `<line x1="${centerX - 200}" y1="${headerY}" x2="${centerX + 200}" y2="${headerY}" stroke="#CCCCCC" stroke-width="1.5"/>`;
  headerY += 20;

  const contentStartY = headerY;
  const maxContentY = 720; // bottom limit for content

  if (menuRecords.length === 1) {
    // Single template: centered layout
    const rec = menuRecords[0];
    const menuName = rec.menuName || "";
    const descItems = (rec.description || "").split(",").map(s => s.trim()).filter(Boolean);

    let y = contentStartY;
    svgElements += `<text x="${centerX}" y="${y}" font-size="22" font-weight="bold" fill="#333333" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(menuName)}</text>`;
    y += 30;

    const maxItems = Math.min(descItems.length, Math.floor((maxContentY - y) / 26));
    const fontSize = maxItems > 10 ? 17 : 20;
    const lh = maxItems > 10 ? 24 : 28;

    for (let i = 0; i < maxItems; i++) {
      svgElements += `<text x="${centerX}" y="${y}" font-size="${fontSize}" fill="#444444" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(descItems[i])}</text>`;
      y += lh;
    }
    if (descItems.length > maxItems) {
      svgElements += `<text x="${centerX}" y="${y}" font-size="15" fill="#888888" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">+ ${descItems.length - maxItems} more</text>`;
    }
  } else if (menuRecords.length === 2) {
    // 2 templates: 2-column layout
    const colX = [SLIDE_WIDTH * 0.30, SLIDE_WIDTH * 0.70];
    for (let col = 0; col < 2; col++) {
      const rec = menuRecords[col];
      const menuName = rec.menuName || "";
      const descItems = (rec.description || "").split(",").map(s => s.trim()).filter(Boolean);

      let y = contentStartY;
      svgElements += `<text x="${colX[col]}" y="${y}" font-size="19" font-weight="bold" fill="#333333" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(menuName)}</text>`;
      y += 28;

      const maxItems = Math.min(descItems.length, Math.floor((maxContentY - y) / 24));
      for (let i = 0; i < maxItems; i++) {
        svgElements += `<text x="${colX[col]}" y="${y}" font-size="17" fill="#444444" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(descItems[i])}</text>`;
        y += 24;
      }
      if (descItems.length > maxItems) {
        svgElements += `<text x="${colX[col]}" y="${y}" font-size="14" fill="#888888" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">+ ${descItems.length - maxItems} more</text>`;
      }
    }
  } else {
    // 3-4+ templates: 2-column grid layout, templates distributed across columns
    const colX = [SLIDE_WIDTH * 0.30, SLIDE_WIDTH * 0.70];
    const colY = [contentStartY, contentStartY];

    for (let i = 0; i < menuRecords.length; i++) {
      // Place in the column with less Y usage
      const col = colY[0] <= colY[1] ? 0 : 1;
      const rec = menuRecords[i];
      const menuName = rec.menuName || "";
      const descItems = (rec.description || "").split(",").map(s => s.trim()).filter(Boolean);

      let y = colY[col];
      if (y >= maxContentY) continue;

      svgElements += `<text x="${colX[col]}" y="${y}" font-size="17" font-weight="bold" fill="#333333" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(menuName)}</text>`;
      y += 24;

      const availLines = Math.floor((maxContentY - y) / 22);
      const maxItems = Math.min(descItems.length, availLines - 1);
      for (let j = 0; j < maxItems; j++) {
        svgElements += `<text x="${colX[col]}" y="${y}" font-size="15" fill="#444444" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(descItems[j])}</text>`;
        y += 22;
      }
      if (descItems.length > maxItems) {
        svgElements += `<text x="${colX[col]}" y="${y}" font-size="13" fill="#888888" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">+ ${descItems.length - maxItems} more</text>`;
        y += 22;
      }
      y += 12; // gap before next template
      colY[col] = y;
    }
  }

  const svg = `<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">${svgElements}</svg>`;

  await sharp({ create: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([
      { input: await sharp(templatePath).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toBuffer(), top: 0, left: 0 },
      { input: Buffer.from(svg), top: 0, left: 0 },
    ])
    .png()
    .toFile(outputPath);

  return outputPath;
}

/**
 * Compose a COUNTER menu slide using counter-specific template.
 * Template has food/counter-themed border with center area for text.
 * Shows counter name + menu items with prices, centered.
 */
async function composeCounterMenuSlide(counter, menuItems, templatePath, outputPath) {
  const items = menuItems.slice(0, 8);
  const counterName = counter.counterName || counter.clientName || "";

  let svgElements = "";
  const centerX = SLIDE_WIDTH / 2;
  let currentY = 130;

  // Counter Name
  svgElements += `<text x="${centerX}" y="${currentY}" font-size="34" font-weight="bold" fill="#222222" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(counterName)}</text>`;
  currentY += 36;

  // Separator
  svgElements += `<line x1="${centerX - 180}" y1="${currentY}" x2="${centerX + 180}" y2="${currentY}" stroke="#CCCCCC" stroke-width="1.5"/>`;
  currentY += 28;

  // Menu items with prices
  const fontSize = items.length > 6 ? 18 : 22;
  const lineHeight = items.length > 6 ? 26 : 32;
  const priceGap = items.length > 6 ? 22 : 26;

  items.forEach((item) => {
    const name = item.itemName || item.menuName || "";
    const price = item.itemPrice || item.price || "";

    svgElements += `<text x="${centerX}" y="${currentY}" font-size="${fontSize}" font-weight="bold" fill="#333333" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(name)}</text>`;
    currentY += priceGap;

    if (price) {
      svgElements += `<text x="${centerX}" y="${currentY}" font-size="${fontSize - 4}" font-weight="normal" fill="#E65100" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">Rs.${escapeXml(String(price))}</text>`;
    }
    currentY += lineHeight;
  });

  const svg = `<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">${svgElements}</svg>`;

  await sharp({ create: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([
      { input: await sharp(templatePath).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toBuffer(), top: 0, left: 0 },
      { input: Buffer.from(svg), top: 0, left: 0 },
    ])
    .png()
    .toFile(outputPath);

  return outputPath;
}

// ══════════════════════════════════════════
// VIDEO GENERATION
// ══════════════════════════════════════════

function stitchSlidesToVideo(slides, outputPath) {
  const concatFilePath = path.join(TMP_DIR, "concat.txt");
  const lines = slides.map((s) => `file '${s.imagePath}'\nduration ${s.duration}`);
  if (slides.length > 0) {
    lines.push(`file '${slides[slides.length - 1].imagePath}'`);
  }
  fs.writeFileSync(concatFilePath, lines.join("\n"));

  const cmd = [
    FFMPEG_PATH, "-y", "-f concat", "-safe 0",
    `-i "${concatFilePath}"`,
    "-vf", `"scale=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:(ow-iw)/2:(oh-ih)/2"`,
    "-vsync vfr", "-pix_fmt yuv420p", "-c:v libx264", "-preset fast", "-crf 23",
    `"${outputPath}"`,
  ].join(" ");

  log.info("Running FFmpeg", { cmd });
  execSync(cmd, { stdio: "pipe", timeout: 600000 });
  return outputPath;
}

// ══════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════

/**
 * Generate TV Ad video.
 *
 * Input: { subLocationID, date }
 *
 * Flow:
 *  1. Fetch clients + counters for subLocation
 *  2. For clients: read menuTypes from client record, fetch daily menus per menuType
 *     → use menuType-specific template (BreakfastSlide, LunchSlide, SnacksSlide)
 *  3. For counters: fetch QSR menus → white bg + logo + items
 *  4. Stitch: Slide 1 → [client menu slides per menuType] → [counter slides] → Slide 9 → Slide 10
 *  5. Upload to S3, return CDN URL
 */
async function generateVideo(reqBody) {
  const { subLocationID, date } = reqBody;

  if (!subLocationID || !date) {
    throw new Error("subLocationID and date are required");
  }

  log.info("Starting video generation", { subLocationID, date });

  // Clean /tmp workspace
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // 1. Fetch all entities for this subLocation
  const { clients, counters } = await getEntitiesForSubLocation(subLocationID);
  log.info("Fetched entities", { clients: clients.length, counters: counters.length });

  if (clients.length === 0 && counters.length === 0) {
    throw new Error(`No clients or counters found for subLocation: ${subLocationID}`);
  }

  // 2. Download static slide templates
  const slide1Path = await downloadSlideFromCdn("Slide 1");
  const slide9Path = await downloadSlideFromCdn("Slide 9");
  const slide10Path = await downloadSlideFromCdn("Slide 10");

  const slides = [];
  let slideIndex = 0;

  // ── Slide 1: Opening (static) ──
  const openingPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(slide1Path).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(openingPath);
  slides.push({ imagePath: openingPath, duration: 5 });

  // ── Client slides (grouped by menuType across all clients) ──
  // Collect all menu records grouped by menuType
  const menuTypeGroups = {}; // { menuType: [records] }
  let clientName = "";
  for (const client of clients) {
    if (!clientName) clientName = client.clientName || "";
    const menuTypes = client.menuTypes || [];
    for (const menuType of menuTypes) {
      const menus = await getDailyMenus(client.clientID, date, menuType);
      if (menus.length === 0) continue;
      const key = menuType.toLowerCase();
      if (!menuTypeGroups[key]) menuTypeGroups[key] = { menuType, records: [] };
      menuTypeGroups[key].records.push(...menus);
    }
  }

  // Generate one slide per menuType with all templates grouped
  for (const key of Object.keys(menuTypeGroups)) {
    const { menuType, records } = menuTypeGroups[key];
    const slideKey = MENU_TYPE_SLIDE_MAP[key] || "Lunch_DinnerSlide";
    const templatePath = await downloadSlideFromCdn(slideKey);

    const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
    await composeClientMenuSlide(templatePath, records, clientName, menuType, outputPath);
    slides.push({ imagePath: outputPath, duration: 6 });
  }
  }

  // ── Counter slides (QSR menus with per-counter templates) ──
  for (const counter of counters) {
    const menus = await getQsrMenus(counter.clientID);
    if (menus.length === 0) continue;

    // Get counter-specific template
    const counterName = (counter.counterName || counter.clientName || "").toLowerCase().trim();
    const slideKey = COUNTER_SLIDE_MAP[counterName];
    let templatePath;
    if (slideKey) {
      templatePath = await downloadSlideFromCdn(slideKey);
    } else {
      // Fallback: use Lunch_DinnerSlide if no specific template
      templatePath = await downloadSlideFromCdn("Lunch_DinnerSlide");
      log.warn("No counter template found", { counterName });
    }

    for (let i = 0; i < menus.length; i += 8) {
      const chunk = menus.slice(i, i + 8);
      const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
      await composeCounterMenuSlide(counter, chunk, templatePath, outputPath);
      slides.push({ imagePath: outputPath, duration: 6 });
    }
  }

  // ── Slide 9: Party Orders (static) ──
  const partyPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(slide9Path).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(partyPath);
  slides.push({ imagePath: partyPath, duration: 5 });

  // ── Slide 10: Download App (static) ──
  const appPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(slide10Path).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(appPath);
  slides.push({ imagePath: appPath, duration: 5 });

  if (slides.length <= 3) {
    throw new Error("No menu content found to generate video");
  }

  log.info("Generated slides", { count: slides.length });

  // 3. Stitch into MP4
  const videoFileName = `tv-ad-${subLocationID}-${date.replace(/\//g, "-")}-${Date.now()}.mp4`;
  const videoLocalPath = path.join(TMP_DIR, videoFileName);
  stitchSlidesToVideo(slides, videoLocalPath);

  // 4. Upload to S3
  const s3Key = `videos/${subLocationID}/${videoFileName}`;
  const videoBuffer = fs.readFileSync(videoLocalPath);
  await s3
    .putObject({
      Bucket: getOutputBucketName(),
      Key: s3Key,
      Body: videoBuffer,
      ContentType: "video/mp4",
      CacheControl: "max-age=86400",
    })
    .promise();

  // 5. Generate URL + save record
  const videoUrl = `${CDN_BASE}/tv-ads/${s3Key}`;
  const record = {
    subLocationID,
    generatedAt: new Date().toISOString(),
    videoUrl,
    s3Key,
    date,
    clientCount: clients.length,
    counterCount: counters.length,
    slideCount: slides.length,
    status: "COMPLETED",
  };
  await db.put({ TableName: getTvAdsTableName(), Item: record }).promise();

  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  return {
    videoUrl,
    s3Key,
    slideCount: slides.length,
    clientCount: clients.length,
    counterCount: counters.length,
    generatedAt: record.generatedAt,
  };
}

async function getGenerationHistory(subLocationID) {
  const params = {
    TableName: getTvAdsTableName(),
    KeyConditionExpression: "subLocationID = :slid",
    ExpressionAttributeValues: { ":slid": subLocationID },
    ScanIndexForward: false,
    Limit: 20,
  };
  const result = await db.query(params).promise();
  return result.Items || [];
}

module.exports = {
  generateVideo,
  getGenerationHistory,
  getEntitiesForSubLocation,
  getDailyMenus,
  getQsrMenus,
};
