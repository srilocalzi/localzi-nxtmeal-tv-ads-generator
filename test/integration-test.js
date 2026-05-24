/**
 * Integration test: Fetches REAL production data from DynamoDB and generates a video.
 *
 * subLocationID: 17705347457104282
 * date: tomorrow
 *
 * For non-counter clients: fetches menuTypes from client record,
 * generates one slide per menuType using BreakfastSlide/LunchSlide/SnacksSlide templates.
 *
 * Usage: node test/integration-test.js
 */

const AWS = require("aws-sdk");
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

// Production tables
const CLIENTS_TABLE = "localzi-nxtmeal-octopus-clients-prod";
const DAILY_MENUS_TABLE = "localzi-nxtmeal-octopus-daily-menus-prod";
const QSR_MENUS_TABLE = "localzi-nxtmeal-qsr-menus-prod";

// Input
const SUB_LOCATION_ID = "17705327354499446";

// Tomorrow's date
const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
})();

// Map menuType to template slide
const MENU_TYPE_SLIDE_MAP = {
  breakfast: "BreakfastSlide",
  lunch: "Lunch_DinnerSlide",
  snacks: "SnacksSlide",
  dinner: "Lunch_DinnerSlide",
};

const db = new AWS.DynamoDB.DocumentClient({ region: "ap-south-1" });

// ══════════════════════════════════════════
// DATA FETCHING (production)
// ══════════════════════════════════════════

async function getEntitiesForSubLocation(subLocationID) {
  const params = {
    TableName: CLIENTS_TABLE,
    FilterExpression: "subLocationID = :slid",
    ExpressionAttributeValues: { ":slid": subLocationID },
  };

  let items = [];
  let result;
  do {
    result = await db.scan(params).promise();
    items = items.concat(result.Items || []);
    params.ExclusiveStartKey = result.LastEvaluatedKey;
  } while (result.LastEvaluatedKey);

  const counters = items.filter((i) => i.type === "COUNTER");
  const clients = items.filter((i) => i.type !== "COUNTER");

  return { clients, counters, all: items };
}

async function getDailyMenus(clientID, date, menuType) {
  const params = {
    TableName: DAILY_MENUS_TABLE,
    KeyConditionExpression: "clientID = :cid",
    ExpressionAttributeValues: { ":cid": clientID },
  };
  const result = await db.query(params).promise();
  let items = result.Items || [];

  if (date) {
    const dateNorm = date.replace(/\//g, "-");
    items = items.filter((item) => {
      const itemDate = item.date || item.sortKey || "";
      return itemDate.includes(dateNorm) || itemDate.includes(date);
    });
  }

  if (menuType) {
    items = items.filter((item) =>
      (item.menuType || "").toLowerCase() === menuType.toLowerCase()
    );
  }

  items = items.filter((item) => !item.soldOut);
  return items;
}

async function getQsrMenus(clientID) {
  const params = {
    TableName: QSR_MENUS_TABLE,
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

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      https.get(requestUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          makeRequest(response.headers.location);
        } else if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${requestUrl}`));
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
 * Compose a CLIENT menu slide with centered text on menuType-specific template.
 * Each slide = one menu record showing menuName, price, and description items.
 */
async function composeClientMenuSlide(templatePath, menuRecord, clientName, menuType, outputPath) {
  const menuName = menuRecord.menuName || "";
  const price = menuRecord.price || menuRecord.itemPrice || "";
  const description = menuRecord.description || "";
  const descItems = description.split(",").map(s => s.trim()).filter(Boolean);

  let svgElements = "";
  const centerX = SLIDE_WIDTH / 2;
  let currentY = 130;

  // Client Name
  svgElements += `<text x="${centerX}" y="${currentY}" font-size="36" font-weight="bold" fill="#222222" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(clientName)}</text>`;
  currentY += 42;

  // Menu Type
  svgElements += `<text x="${centerX}" y="${currentY}" font-size="24" font-weight="normal" fill="#E65100" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(menuType)}</text>`;
  currentY += 38;

  // Template name + price
  const priceStr = price && price !== "0" ? ` - Rs.${price}` : "";
  svgElements += `<text x="${centerX}" y="${currentY}" font-size="22" font-weight="bold" fill="#444444" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">${escapeXml(menuName)}${escapeXml(priceStr)}</text>`;
  currentY += 32;

  // Separator
  svgElements += `<line x1="${centerX - 180}" y1="${currentY}" x2="${centerX + 180}" y2="${currentY}" stroke="#CCCCCC" stroke-width="1.5"/>`;
  currentY += 28;

  // Description items listed one below another
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

  await sharp({ create: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([
      { input: await sharp(templatePath).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toBuffer(), top: 0, left: 0 },
      { input: Buffer.from(svg), top: 0, left: 0 },
    ])
    .png()
    .toFile(outputPath);
}

async function composeCounterMenuSlide(counter, menuItems, outputPath) {
  const items = menuItems.slice(0, 6);
  const counterName = counter.counterName || counter.clientName || "";
  const composites = [];

  const logoUrl = counter.s3Url || counter.bannerImage || "";
  if (logoUrl) {
    const logoPath = path.join(TMP_DIR, `logo_${counter.clientID}.png`);
    try {
      if (!fs.existsSync(logoPath)) {
        await downloadFile(logoUrl, logoPath);
      }
      const logoBuffer = await sharp(logoPath)
        .resize(150, 150, { fit: "inside", background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png()
        .toBuffer();
      composites.push({ input: logoBuffer, top: 25, left: 40 });
    } catch (e) {
      console.log(`   (logo failed: ${e.message})`);
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
}

// ══════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════

async function main() {
  console.log("TV Ads Generator - PRODUCTION Integration Test");
  console.log("===============================================");
  console.log(`subLocationID: ${SUB_LOCATION_ID}`);
  console.log(`date: ${TOMORROW} (tomorrow)\n`);

  // Setup
  if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // 1. Fetch entities
  console.log("1. Querying localzi-nxtmeal-octopus-clients-prod...");
  const { clients, counters, all } = await getEntitiesForSubLocation(SUB_LOCATION_ID);
  console.log(`   Total records: ${all.length}`);
  console.log(`   Clients: ${clients.length} → ${clients.map(c => c.clientName).join(", ") || "(none)"}`);
  console.log(`   Counters: ${counters.length} → ${counters.map(c => c.counterName || c.clientName).join(", ") || "(none)"}`);

  if (clients.length > 0) {
    console.log(`\n   Client menuTypes available:`);
    for (const c of clients) {
      console.log(`     ${c.clientName}: ${JSON.stringify(c.menuTypes || [])}`);
    }
  }

  // 2. Fetch menus for clients (per menuType)
  console.log("\n2. Fetching daily menus for clients (per menuType)...");
  const clientMenuData = {}; // { clientID: { menuType: [records] } }
  for (const client of clients) {
    const menuTypes = client.menuTypes || [];
    clientMenuData[client.clientID] = {};

    for (const mt of menuTypes) {
      const menus = await getDailyMenus(client.clientID, TOMORROW, mt);
      clientMenuData[client.clientID][mt] = menus;
      console.log(`   ${client.clientName} [${mt}]: ${menus.length} records`);
      menus.forEach(m => {
        const descItems = (m.description || "").split(",").map(s => s.trim()).filter(Boolean);
        console.log(`     → ${m.menuName} (Rs.${m.price || "?"}) - ${descItems.length} items: ${descItems.slice(0, 4).join(", ")}${descItems.length > 4 ? "..." : ""}`);
      });
    }
  }

  // 3. Fetch QSR menus for counters
  console.log("\n3. Fetching QSR menus for counters...");
  const counterMenuData = {};
  for (const counter of counters) {
    const menus = await getQsrMenus(counter.clientID);
    counterMenuData[counter.clientID] = menus;
    console.log(`   ${counter.counterName || counter.clientName || counter.clientID}: ${menus.length} items`);
    if (menus.length > 0) {
      console.log(`     Sample: ${menus[0].itemName || menus[0].menuName || "?"} - Rs.${menus[0].itemPrice || menus[0].price || "?"}`);
    }
  }

  // 4. Download slide templates
  console.log("\n4. Downloading slide templates...");
  const templatePaths = {};
  const templatesToDownload = ["Slide 1", "Slide 9", "Slide 10", "BreakfastSlide", "Lunch_DinnerSlide", "SnacksSlide"];
  for (const name of templatesToDownload) {
    const localPath = path.join(TMP_DIR, `${name}.png`);
    try {
      await downloadFile(`${CDN_PREFIX}/${name}.png`, localPath);
      templatePaths[name] = localPath;
      console.log(`   OK  ${name}.png`);
    } catch (e) {
      console.log(`   FAIL  ${name}.png - ${e.message}`);
    }
  }

  // 5. Compose slides
  console.log("\n5. Composing slides...");
  const slides = [];
  let slideIndex = 0;

  // Slide 1 - Opening
  const openingPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(templatePaths["Slide 1"]).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(openingPath);
  slides.push({ imagePath: openingPath, duration: 5 });
  console.log(`   [${slides.length}] Opening (5s)`);

  // Client slides - per menuType
  for (const client of clients) {
    const menuTypes = client.menuTypes || [];
    for (const mt of menuTypes) {
      const menus = (clientMenuData[client.clientID] || {})[mt] || [];
      if (menus.length === 0) continue;

      const slideKey = MENU_TYPE_SLIDE_MAP[mt.toLowerCase()] || "Lunch_DinnerSlide";
      const templatePath = templatePaths[slideKey];
      if (!templatePath) {
        console.log(`   SKIP ${client.clientName} [${mt}] - template not available`);
        continue;
      }

      for (const menuRecord of menus) {
        const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
        await composeClientMenuSlide(templatePath, menuRecord, client.clientName || "", mt, outputPath);
        slides.push({ imagePath: outputPath, duration: 6 });
        const descCount = (menuRecord.description || "").split(",").filter(Boolean).length;
        console.log(`   [${slides.length}] ${client.clientName} [${mt}] "${menuRecord.menuName}" (${descCount} items) (6s)`);
      }
    }
  }

  // Counter slides
  for (const counter of counters) {
    const menus = counterMenuData[counter.clientID] || [];
    if (menus.length === 0) continue;

    for (let i = 0; i < menus.length; i += 6) {
      const chunk = menus.slice(i, i + 6);
      const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
      await composeCounterMenuSlide(counter, chunk, outputPath);
      slides.push({ imagePath: outputPath, duration: 6 });
      console.log(`   [${slides.length}] ${counter.counterName || counter.clientName} items ${i + 1}-${i + chunk.length} (6s)`);
    }
  }

  // Slide 9 - Party Orders
  const partyPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(templatePaths["Slide 9"]).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(partyPath);
  slides.push({ imagePath: partyPath, duration: 5 });
  console.log(`   [${slides.length}] Party Orders (5s)`);

  // Slide 10 - Download App
  const appPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
  await sharp(templatePaths["Slide 10"]).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(appPath);
  slides.push({ imagePath: appPath, duration: 5 });
  console.log(`   [${slides.length}] Download App (5s)`);

  const totalDuration = slides.reduce((sum, s) => sum + s.duration, 0);
  console.log(`\n   Total: ${slides.length} slides, ${totalDuration}s`);

  // 6. Stitch
  console.log("\n6. Stitching MP4...");
  const concatFilePath = path.join(TMP_DIR, "concat.txt");
  const lines = slides.map((s) => `file '${s.imagePath}'\nduration ${s.duration}`);
  lines.push(`file '${slides[slides.length - 1].imagePath}'`);
  fs.writeFileSync(concatFilePath, lines.join("\n"));

  const videoOutputPath = path.join(OUTPUT_DIR, `tv-ad-${SUB_LOCATION_ID}-${TOMORROW.replace(/\//g, "-")}.mp4`);
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
  console.log("\nDone! Opening video...");

  execSync(`open "${videoOutputPath}"`);
}

main().catch((err) => {
  console.error("\nERROR:", err.message);
  if (err.code === "CredentialsError" || err.message.includes("credentials")) {
    console.error("\nHint: Make sure AWS credentials are configured:");
    console.error("  aws configure --profile default");
    console.error("  OR export AWS_PROFILE=your-profile");
  }
  process.exit(1);
});
