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

  // Exclude sold-out items
  items = items.filter((item) => !item.soldOut);

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
 * Template has food border with transparent/white center.
 * Each slide = one menu record showing:
 *   ClientName
 *   MenuType
 *   templateName (menuName) - Rs.costPerPlate
 *   ---
 *   Items from description (comma-separated), listed one below another
 */
async function composeClientMenuSlide(templatePath, menuRecord, clientName, menuType, outputPath) {
  const menuName = menuRecord.menuName || "";
  const price = menuRecord.price || menuRecord.itemPrice || "";
  const description = menuRecord.description || "";
  const descItems = description.split(",").map(s => s.trim()).filter(Boolean);

  let svgElements = "";
  const centerX = SLIDE_WIDTH / 2;
  let currentY = 130;

  // Client Name (large, centered)
  svgElements += `<text x="${centerX}" y="${currentY}" font-size="36" font-weight="bold" fill="#222222" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(clientName)}</text>`;
  currentY += 42;

  // Menu Type
  svgElements += `<text x="${centerX}" y="${currentY}" font-size="24" font-weight="normal" fill="#E65100" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(menuType)}</text>`;
  currentY += 38;

  // Template name + price
  const priceStr = price && price !== "0" ? ` - Rs.${price}` : "";
  svgElements += `<text x="${centerX}" y="${currentY}" font-size="22" font-weight="bold" fill="#444444" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(menuName)}${escapeXml(priceStr)}</text>`;
  currentY += 32;

  // Separator line
  svgElements += `<line x1="${centerX - 180}" y1="${currentY}" x2="${centerX + 180}" y2="${currentY}" stroke="#CCCCCC" stroke-width="1.5"/>`;
  currentY += 28;

  // Description items (listed one below another, max ~12 to fit)
  const maxItems = Math.min(descItems.length, 12);
  const fontSize = descItems.length > 8 ? 18 : 22;
  const lineHeight = descItems.length > 8 ? 28 : 34;

  for (let i = 0; i < maxItems; i++) {
    svgElements += `<text x="${centerX}" y="${currentY}" font-size="${fontSize}" font-weight="normal" fill="#333333" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(descItems[i])}</text>`;
    currentY += lineHeight;
  }

  if (descItems.length > maxItems) {
    svgElements += `<text x="${centerX}" y="${currentY}" font-size="16" font-weight="normal" fill="#888888" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">+ ${descItems.length - maxItems} more</text>`;
  }

  const svg = `<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">${svgElements}</svg>`;

  // Flatten template (handle transparency by compositing on white first)
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
 * Compose a COUNTER menu slide.
 * White background + counter logo + counter name + menu items.
 */
async function composeCounterMenuSlide(counter, menuItems, outputPath) {
  const items = menuItems.slice(0, 6);
  const counterName = counter.counterName || counter.clientName || "";
  const logoUrl = counter.s3Url || counter.bannerImage || "";
  const composites = [];

  if (logoUrl) {
    const logoPath = await downloadLogo(logoUrl);
    if (logoPath) {
      try {
        const logoBuffer = await sharp(logoPath)
          .resize(150, 150, { fit: "inside", background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .png()
          .toBuffer();
        composites.push({ input: logoBuffer, top: 25, left: 40 });
      } catch (e) {
        log.warn("Logo resize failed", { error: e.message });
      }
    }
  }

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

  // ── Client slides (per menuType from client record) ──
  for (const client of clients) {
    const menuTypes = client.menuTypes || [];
    if (menuTypes.length === 0) continue;

    for (const menuType of menuTypes) {
      const menus = await getDailyMenus(client.clientID, date, menuType);
      if (menus.length === 0) continue;

      // Get the appropriate template for this menuType
      const slideKey = MENU_TYPE_SLIDE_MAP[menuType.toLowerCase()] || "LunchSlide";
      const templatePath = await downloadSlideFromCdn(slideKey);

      // One slide per menu record (each record = one meal template with description items)
      for (const menuRecord of menus) {
        const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
        await composeClientMenuSlide(templatePath, menuRecord, client.clientName || "", menuType, outputPath);
        slides.push({ imagePath: outputPath, duration: 6 });
      }
    }
  }

  // ── Counter slides (QSR menus) ──
  for (const counter of counters) {
    const menus = await getQsrMenus(counter.clientID);
    if (menus.length === 0) continue;

    for (let i = 0; i < menus.length; i += 6) {
      const chunk = menus.slice(i, i + 6);
      const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
      await composeCounterMenuSlide(counter, chunk, outputPath);
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
