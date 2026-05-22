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

// ══════════════════════════════════════════
// DATA FETCHING
// ══════════════════════════════════════════

/**
 * Get all clients AND counters for a subLocationID.
 * Returns { clients: [...], counters: [...] }
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
 * daily-menus table: PK = clientID, SK = sortKey (encodes date + item).
 */
async function getDailyMenus(clientID, date, menuType) {
  const params = {
    TableName: getDailyMenusTableName(),
    KeyConditionExpression: "clientID = :cid",
    ExpressionAttributeValues: { ":cid": clientID },
  };

  const result = await db.query(params).promise();
  let items = result.Items || [];

  // Filter by date (sortKey or date field)
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
 * qsr-menus table: GSI clientID-index.
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

  // Exclude sold-out items
  items = items.filter((item) => !item.soldOut);

  return items;
}

// ══════════════════════════════════════════
// SLIDE COMPOSITION
// ══════════════════════════════════════════

/**
 * Download a static slide from CDN (Slide 1, 3, 9, 10).
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

/**
 * Download a file from URL to local path.
 */
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

/**
 * Download counter logo from its S3/CDN URL.
 */
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
 * Compose a CLIENT menu slide using Slide 3 template.
 * Food imagery on left, menu items text on right white area.
 */
async function composeClientMenuSlide(templatePath, menuItems, clientName, outputPath) {
  const itemsToShow = menuItems.slice(0, 4); // Max 4 items per slide
  let svgElements = "";

  // Client/brand name at top-right
  svgElements += `<text x="620" y="60" font-size="28" font-weight="bold" fill="#333333" font-family="Arial, Helvetica, sans-serif">${escapeXml(clientName)}</text>`;

  itemsToShow.forEach((item, idx) => {
    const baseY = 110 + idx * 160;
    const name = item.menuName || item.itemName || item.name || "";
    const price = item.itemPrice || item.price || "";
    const desc = item.itemDescription || item.description || "";

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

  return outputPath;
}

/**
 * Compose a COUNTER menu slide.
 * White background + counter logo (top-left) + counter name + menu items with prices.
 */
async function composeCounterMenuSlide(counter, menuItems, outputPath) {
  const itemsToShow = menuItems.slice(0, 6); // Max 6 items per counter slide
  const counterName = counter.counterName || counter.clientName || "";
  const logoUrl = counter.s3Url || counter.bannerImage || "";

  // Create white background
  const composites = [];

  // Download and add logo if available
  let logoStartY = 30;
  if (logoUrl) {
    const logoPath = await downloadLogo(logoUrl);
    if (logoPath) {
      try {
        const logoBuffer = await sharp(logoPath)
          .resize(180, 180, { fit: "inside", background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .png()
          .toBuffer();
        composites.push({ input: logoBuffer, top: 20, left: 30 });
        logoStartY = 20;
      } catch (e) {
        log.warn("Logo resize failed", { error: e.message });
      }
    }
  }

  // Build text SVG
  let svgElements = "";

  // Counter name
  svgElements += `<text x="240" y="80" font-size="36" font-weight="bold" fill="#222222" font-family="Arial, Helvetica, sans-serif">${escapeXml(counterName)}</text>`;

  // Menu items - arranged in 2 columns
  itemsToShow.forEach((item, idx) => {
    const col = idx < 3 ? 0 : 1;
    const row = idx < 3 ? idx : idx - 3;
    const baseX = col === 0 ? 80 : 720;
    const baseY = 220 + row * 160;

    const name = item.menuName || item.itemName || item.name || "";
    const price = item.itemPrice || item.price || "";

    svgElements += `<text x="${baseX}" y="${baseY}" font-size="28" font-weight="bold" fill="#222222" font-family="Arial, Helvetica, sans-serif">${escapeXml(name)}</text>`;
    svgElements += `<text x="${baseX}" y="${baseY + 36}" font-size="22" font-weight="normal" fill="#E65100" font-family="Arial, Helvetica, sans-serif">Rs.${escapeXml(String(price))}</text>`;
  });

  const svg = `<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">${svgElements}</svg>`;
  composites.push({ input: Buffer.from(svg), top: 0, left: 0 });

  // White background base
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

/**
 * Stitch slides into MP4 using FFmpeg.
 */
function stitchSlidesToVideo(slides, outputPath) {
  const concatFilePath = path.join(TMP_DIR, "concat.txt");
  const lines = slides.map((s) => `file '${s.imagePath}'\nduration ${s.duration}`);
  if (slides.length > 0) {
    lines.push(`file '${slides[slides.length - 1].imagePath}'`);
  }
  fs.writeFileSync(concatFilePath, lines.join("\n"));

  const cmd = [
    FFMPEG_PATH,
    "-y",
    "-f concat",
    "-safe 0",
    `-i "${concatFilePath}"`,
    "-vf", `"scale=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:(ow-iw)/2:(oh-ih)/2"`,
    "-vsync vfr",
    "-pix_fmt yuv420p",
    "-c:v libx264",
    "-preset fast",
    "-crf 23",
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
 * Input: { subLocationID, menuType, date }
 *
 * Flow:
 *  1. Fetch clients + counters for subLocation
 *  2. For clients: fetch daily menus (date + menuType) → use Slide 3 template
 *  3. For counters: fetch QSR menus → generate white bg + logo + items
 *  4. Stitch: Slide 1 → [client slides] → [counter slides] → Slide 9 → Slide 10
 *  5. Upload to S3, return CDN URL
 */
async function generateVideo(reqBody) {
  const { subLocationID, menuType, date } = reqBody;

  if (!subLocationID || !date) {
    throw new Error("subLocationID and date are required");
  }

  log.info("Starting video generation", { subLocationID, date, menuType });

  // Clean /tmp workspace
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // 1. Fetch all entities for this subLocation
  const { clients, counters } = await getEntitiesForSubLocation(subLocationID);
  log.info("Fetched entities", { clients: clients.length, counters: counters.length });

  if (clients.length === 0 && counters.length === 0) {
    throw new Error(`No clients or counters found for subLocation: ${subLocationID}`);
  }

  // 2. Download static slide templates from CDN
  const slide1Path = await downloadSlideFromCdn("Slide 1");
  const slide3Path = await downloadSlideFromCdn("Slide 3");
  const slide9Path = await downloadSlideFromCdn("Slide 9");
  const slide10Path = await downloadSlideFromCdn("Slide 10");

  const slides = []; // { imagePath, duration }
  let slideIndex = 0;

  // ── Slide 1: Opening (static) ──
  const openingPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(slide1Path).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(openingPath);
  slides.push({ imagePath: openingPath, duration: 5 });

  // ── Client slides (daily menus - uses Slide 3 template) ──
  for (const client of clients) {
    const menus = await getDailyMenus(client.clientID, date, menuType);
    if (menus.length === 0) continue;

    // Split into slides of 4 items each
    for (let i = 0; i < menus.length; i += 4) {
      const chunk = menus.slice(i, i + 4);
      const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
      await composeClientMenuSlide(slide3Path, chunk, client.clientName || "", outputPath);
      slides.push({ imagePath: outputPath, duration: 6 });
    }
  }

  // ── Counter slides (QSR menus - white bg + logo + items) ──
  for (const counter of counters) {
    const menus = await getQsrMenus(counter.clientID);
    if (menus.length === 0) continue;

    // Split into slides of 6 items each
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
  log.info("Video stitched", { path: videoLocalPath });

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
  log.info("Uploaded to S3", { bucket: getOutputBucketName(), key: s3Key });

  // 5. Generate playable URL
  const videoUrl = `${CDN_BASE}/tv-ads/${s3Key}`;

  // 6. Save record to DynamoDB
  const record = {
    subLocationID,
    generatedAt: new Date().toISOString(),
    videoUrl,
    s3Key,
    date,
    menuType: menuType || "all",
    clientCount: clients.length,
    counterCount: counters.length,
    slideCount: slides.length,
    status: "COMPLETED",
  };
  await db.put({ TableName: getTvAdsTableName(), Item: record }).promise();

  // 7. Cleanup
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

/**
 * Get generation history for a subLocation.
 */
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
