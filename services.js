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
  getOutputBucketName,
  getCdnBaseUrl,
} = require("./utils");
const {
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
  DURATIONS,
  ITEMS_PER_CLIENT_SLIDE,
  ITEMS_PER_COUNTER_SLIDE,
  getIntroSlides,
  getOutroSlides,
  getThemeColors,
  getCounterNameOptions,
} = require("./slideConfig");

const db = new AWS.DynamoDB.DocumentClient({ region: "ap-south-1" });
const s3 = new AWS.S3({ region: "ap-south-1" });

const TMP_DIR = "/tmp/tv-ads";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";
const CDN_BASE = getCdnBaseUrl();
const SLIDES_CDN_PREFIX = `${CDN_BASE}/nxtmeal`;
const DEFAULT_THEME_COLOR = "#286C39";

async function getEntitiesForSubLocation(subLocationID) {
  const params = {
    TableName: getClientsTableName(),
    IndexName: "subLocationID-index",
    KeyConditionExpression: "subLocationID = :slid",
    ExpressionAttributeValues: { ":slid": subLocationID },
  };

  const result = await db.query(params).promise();
  const items = result.Items || [];

  return {
    counters: items.filter((item) => item.type === "COUNTER"),
    clients: items.filter((item) => item.type !== "COUNTER"),
  };
}

async function getDailyMenus(clientID, date, menuType) {
  const params = {
    TableName: getDailyMenusTableName(),
    KeyConditionExpression: "clientID = :cid",
    ExpressionAttributeValues: { ":cid": clientID },
  };

  const result = await db.query(params).promise();
  let items = result.Items || [];

  if (date) {
    const normalizedDate = date.replace(/\//g, "-");
    items = items.filter((item) => {
      const itemDate = item.date || item.sortKey?.split("#")[0] || "";
      return itemDate.includes(normalizedDate) || itemDate.includes(date);
    });
  }

  if (menuType) {
    items = items.filter(
      (item) => (item.menuType || "").toLowerCase() === menuType.toLowerCase()
    );
  }

  return items.filter((item) => item.description && item.description.trim().length > 0);
}

async function getQsrMenus(clientID) {
  const params = {
    TableName: getQsrMenusTableName(),
    IndexName: "clientID-index",
    KeyConditionExpression: "clientID = :cid",
    ExpressionAttributeValues: { ":cid": clientID },
  };

  const result = await db.query(params).promise();
  return (result.Items || []).filter((item) => !item.soldOut);
}

async function downloadSlideFromCdn(slideName) {
  const localPath = path.join(TMP_DIR, "templates", `${slideName}.png`);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await downloadFile(`${SLIDES_CDN_PREFIX}/${slideName}.png`, localPath);
  return localPath;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      const client = requestUrl.startsWith("https") ? https : require("http");
      client
        .get(requestUrl, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            makeRequest(response.headers.location);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode} for ${url}`));
            return;
          }

          const file = fs.createWriteStream(destPath);
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve(destPath);
          });
          file.on("error", reject);
        })
        .on("error", reject);
    };

    makeRequest(url);
  });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hexToRgb(hex) {
  const normalized = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }

  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function resolveThemeColor(themeColor) {
  return hexToRgb(themeColor) ? themeColor : DEFAULT_THEME_COLOR;
}

function getContrastTextColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return "#FFFFFF";
  }

  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.62 ? "#1C1C1C" : "#FFFFFF";
}

function toRgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return `rgba(40,108,57,${alpha})`;
  }

  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function titleCase(text) {
  return String(text || "")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function formatPrice(price) {
  if (price === undefined || price === null || price === "") {
    return "";
  }

  return `Rs.${price}`;
}

function normalizeClientSections(menuRecords) {
  return menuRecords.map((record) => {
    const descItems = String(record.description || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const visibleItems = descItems.slice(0, 4);

    if (descItems.length > visibleItems.length) {
      visibleItems.push(`+ ${descItems.length - visibleItems.length} more`);
    }

    return {
      title: record.menuName || record.templateName || "Menu",
      meta: formatPrice(record.itemPrice || record.price),
      items: visibleItems,
    };
  });
}

function normalizeCounterSections(menuItems) {
  return menuItems.map((item) => ({
    title: item.itemName || item.menuName || "Menu Item",
    meta: formatPrice(item.itemPrice || item.price),
    items: [],
  }));
}

async function composeThemedMenuSlide(model, outputPath) {
  const themeColor = resolveThemeColor(model.themeColor);
  const headerTextColor = getContrastTextColor(themeColor);
  const cardFill = toRgba(themeColor, 0.08);
  const cardStroke = toRgba(themeColor, 0.22);
  const accentFill = toRgba(themeColor, 0.12);
  const sections = model.sections || [];
  const columns = sections.length > 3 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(sections.length / columns));
  const gridTop = 195;
  const gridHeight = 498;
  const gap = 28;
  const cardWidth = columns === 1 ? 1030 : 496;
  const cardHeight = Math.max(120, Math.floor((gridHeight - gap * (rows - 1)) / rows));
  const startX = columns === 1 ? 168 : 171;

  let svg = `
    <svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" fill="#F7F5F0" />
      <rect x="0" y="0" width="${SLIDE_WIDTH}" height="146" fill="${themeColor}" />
      <circle cx="1220" cy="86" r="132" fill="${toRgba(themeColor, 0.22)}" />
      <circle cx="1095" cy="680" r="120" fill="${accentFill}" />
      <text x="683" y="76" text-anchor="middle" font-size="40" font-weight="700" letter-spacing="1" fill="${headerTextColor}" font-family="Arial, Helvetica, sans-serif">${escapeXml(model.displayName || "NXT Meal")}</text>
      <text x="683" y="112" text-anchor="middle" font-size="20" font-weight="500" fill="${headerTextColor}" font-family="Arial, Helvetica, sans-serif">${escapeXml(model.subTitle || "Curated menu highlights")}</text>
      <line x1="214" y1="154" x2="1152" y2="154" stroke="${cardStroke}" stroke-width="3" stroke-linecap="round" />
  `;

  sections.forEach((section, index) => {
    const columnIndex = columns === 1 ? 0 : index % columns;
    const rowIndex = columns === 1 ? index : Math.floor(index / columns);
    const cardX = startX + columnIndex * (cardWidth + gap);
    const cardY = gridTop + rowIndex * (cardHeight + gap);
    const textX = cardX + 28;
    let textY = cardY + 40;

    svg += `
      <rect x="${cardX}" y="${cardY}" rx="24" ry="24" width="${cardWidth}" height="${cardHeight}" fill="${cardFill}" stroke="${cardStroke}" stroke-width="1.5" />
      <text x="${textX}" y="${textY}" font-size="28" font-weight="700" fill="#1F1F1F" font-family="Arial, Helvetica, sans-serif">${escapeXml(section.title || "")}</text>
    `;

    if (section.meta) {
      svg += `
        <text x="${cardX + cardWidth - 28}" y="${textY}" text-anchor="end" font-size="18" font-weight="700" fill="${themeColor}" font-family="Arial, Helvetica, sans-serif">${escapeXml(section.meta)}</text>
      `;
    }

    textY += 20;

    (section.items || []).forEach((item) => {
      textY += 30;
      svg += `
        <text x="${textX}" y="${textY}" font-size="18" font-weight="400" fill="#474747" font-family="Arial, Helvetica, sans-serif">- ${escapeXml(item)}</text>
      `;
    });
  });

  svg += `
      <text x="171" y="722" font-size="16" font-weight="500" fill="#5A5A5A" font-family="Arial, Helvetica, sans-serif">Freshly prepared for your workplace menu screens</text>
    </svg>
  `;

  await sharp({
    create: {
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      channels: 4,
      background: { r: 247, g: 245, b: 240, alpha: 1 },
    },
  })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outputPath);

  return outputPath;
}

function stitchSlidesToVideo(slides, outputPath) {
  const concatFilePath = path.join(TMP_DIR, "concat.txt");
  const lines = slides.map((slide) => `file '${slide.imagePath}'\nduration ${slide.duration}`);
  if (slides.length > 0) {
    lines.push(`file '${slides[slides.length - 1].imagePath}'`);
  }
  fs.writeFileSync(concatFilePath, lines.join("\n"));

  const cmd = [
    FFMPEG_PATH,
    "-y",
    "-f concat",
    "-safe 0",
    `-i \"${concatFilePath}\"`,
    "-vf",
    `\"scale=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:(ow-iw)/2:(oh-ih)/2\"`,
    "-vsync vfr",
    "-pix_fmt yuv420p",
    "-c:v libx264",
    "-preset fast",
    "-crf 23",
    `\"${outputPath}\"`,
  ].join(" ");

  log.info("Running FFmpeg", { cmd });
  execSync(cmd, { stdio: "pipe", timeout: 600000 });
  return outputPath;
}

function buildSelectionDefaults(entities, themeColors) {
  let themeIndex = 0;
  const nextColor = () => {
    const color = themeColors[themeIndex % themeColors.length] || DEFAULT_THEME_COLOR;
    themeIndex += 1;
    return color;
  };

  return [
    ...entities.clients.map((client) => ({
      type: "CLIENT",
      clientID: client.clientID,
      displayName: client.clientName || "Client",
      themeColor: nextColor(),
      menuTypes: client.menuTypes || [],
    })),
    ...entities.counters.map((counter) => ({
      type: "COUNTER",
      clientID: counter.clientID,
      displayName: counter.counterName || counter.clientName || "Counter",
      themeColor: nextColor(),
    })),
  ];
}

function ensureSelections(reqBody) {
  if (Array.isArray(reqBody.selections) && reqBody.selections.length > 0) {
    return reqBody.selections;
  }

  return null;
}

async function buildSlidesForSelection(selection, date, slideIndexRef) {
  const selectionType = String(selection.type || "").toUpperCase();
  const displayName =
    selection.displayName || selection.clientName || selection.counterName || "NXT Meal";
  const themeColor = resolveThemeColor(selection.themeColor);
  const slides = [];

  if (selectionType === "CLIENT") {
    const menuTypes =
      Array.isArray(selection.menuTypes) && selection.menuTypes.length > 0
        ? selection.menuTypes
        : ["lunch"];

    for (const menuType of menuTypes) {
      const menuRecords = await getDailyMenus(selection.clientID, date, menuType);
      if (menuRecords.length === 0) {
        continue;
      }

      const chunks = chunkArray(menuRecords, ITEMS_PER_CLIENT_SLIDE);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const outputPath = path.join(TMP_DIR, `slide_${slideIndexRef.value++}.png`);
        const slideLabel = `${titleCase(menuType)} Menu${
          chunks.length > 1 ? ` ${chunkIndex + 1}` : ""
        }`;

        await composeThemedMenuSlide(
          {
            displayName,
            subTitle: slideLabel,
            themeColor,
            sections: normalizeClientSections(chunks[chunkIndex]),
          },
          outputPath
        );

        slides.push({ imagePath: outputPath, duration: DURATIONS.CLIENT_MENU });
      }
    }

    return slides;
  }

  if (selectionType === "COUNTER") {
    const menuItems = await getQsrMenus(selection.clientID);
    if (menuItems.length === 0) {
      return slides;
    }

    const chunks = chunkArray(menuItems, ITEMS_PER_COUNTER_SLIDE);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const outputPath = path.join(TMP_DIR, `slide_${slideIndexRef.value++}.png`);
      await composeThemedMenuSlide(
        {
          displayName,
          subTitle: `Counter Menu${chunks.length > 1 ? ` ${chunkIndex + 1}` : ""}`,
          themeColor,
          sections: normalizeCounterSections(chunks[chunkIndex]),
        },
        outputPath
      );

      slides.push({ imagePath: outputPath, duration: DURATIONS.COUNTER_MENU });
    }
  }

  return slides;
}

async function appendStaticSlides(slides, slideNames, duration, slideIndexRef) {
  for (const slideName of slideNames) {
    const templatePath = await downloadSlideFromCdn(slideName);
    const outputPath = path.join(TMP_DIR, `slide_${slideIndexRef.value++}.png`);
    await sharp(templatePath).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(outputPath);
    slides.push({ imagePath: outputPath, duration });
  }
}

async function generateVideo(reqBody) {
  const { date, kitchenID, subLocationID } = reqBody;
  const themeColors = getThemeColors();

  if (!date) {
    throw new Error("date is required");
  }

  log.info("Starting video generation", {
    date,
    kitchenID,
    subLocationID,
    requestedSelections: Array.isArray(reqBody.selections) ? reqBody.selections.length : 0,
  });

  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let selections = ensureSelections(reqBody);
  if (!selections && subLocationID) {
    const entities = await getEntitiesForSubLocation(subLocationID);
    selections = buildSelectionDefaults(entities, themeColors);
  }

  if (!selections || selections.length === 0) {
    throw new Error("At least one selection is required");
  }

  const slides = [];
  const slideIndexRef = { value: 0 };
  const introSlides = getIntroSlides();
  const outroSlides = getOutroSlides();

  await appendStaticSlides(slides, introSlides, DURATIONS.OPENING, slideIndexRef);

  let renderedSelectionCount = 0;
  for (const selection of selections) {
    const selectionSlides = await buildSlidesForSelection(selection, date, slideIndexRef);
    if (selectionSlides.length > 0) {
      renderedSelectionCount += 1;
      slides.push(...selectionSlides);
    }
  }

  await appendStaticSlides(slides, outroSlides, DURATIONS.PARTY_ORDERS, slideIndexRef);

  if (slides.length <= introSlides.length + outroSlides.length) {
    throw new Error("No menu content found to generate video");
  }

  const recordKey = kitchenID || subLocationID || "manual";
  const videoFileName = `tv-ad-${recordKey.replace(/[^a-zA-Z0-9-_]/g, "-")}-${date.replace(/\//g, "-")}-${Date.now()}.mp4`;
  const videoLocalPath = path.join(TMP_DIR, videoFileName);
  stitchSlidesToVideo(slides, videoLocalPath);

  const s3Key = `videos/${recordKey}/${videoFileName}`;
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

  const generatedAt = new Date().toISOString();
  const record = {
    subLocationID: recordKey,
    generatedAt,
    videoUrl: `${CDN_BASE}/tv-ads/${s3Key}`,
    s3Key,
    date,
    selectionCount: selections.length,
    renderedSelectionCount,
    slideCount: slides.length,
    status: "COMPLETED",
  };

  try {
    await db.put({ TableName: getTvAdsTableName(), Item: record }).promise();
  } catch (error) {
    log.warn("Failed to save generation history", {
      recordKey,
      error: error.message,
    });
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  return {
    videoUrl: record.videoUrl,
    s3Key,
    slideCount: slides.length,
    selectionCount: selections.length,
    renderedSelectionCount,
    generatedAt,
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

async function getAdConfig() {
  return {
    themeColors: getThemeColors(),
    counterNames: getCounterNameOptions(),
    introSlides: getIntroSlides(),
    outroSlides: getOutroSlides(),
  };
}

module.exports = {
  generateVideo,
  getGenerationHistory,
  getEntitiesForSubLocation,
  getDailyMenus,
  getQsrMenus,
  getAdConfig,
};
