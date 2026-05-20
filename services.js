const AWS = require("aws-sdk");
const sharp = require("sharp");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  log,
  getClientTableName,
  getMenuTableName,
  getTvAdsTableName,
  getSlidesBucketName,
  getOutputBucketName,
  getCdnBaseUrl,
} = require("./utils");
const { slideTemplates, defaultSequence, SLIDE_WIDTH, SLIDE_HEIGHT } = require("./slideConfig");

const db = new AWS.DynamoDB.DocumentClient({ region: "ap-south-1" });
const s3 = new AWS.S3({ region: "ap-south-1" });

const TMP_DIR = "/tmp/tv-ads";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";

// ── Data Fetching ──

/**
 * Get all clients (counters) for a given subLocationID
 */
async function getClientsForSubLocation(subLocationID) {
  const params = {
    TableName: getClientTableName(),
    IndexName: "subLocationID-index",
    KeyConditionExpression: "subLocationID = :slid",
    ExpressionAttributeValues: { ":slid": subLocationID },
  };

  const result = await db.query(params).promise();
  return (result.Items || []).filter((c) => c.status === "APPROVED");
}

/**
 * Get menu items for a client on a specific date and menu types
 */
async function getMenuForClient(clientID, date, menuTypes) {
  const params = {
    TableName: getMenuTableName(),
    KeyConditionExpression: "clientID = :cid",
    FilterExpression: "#d = :date",
    ExpressionAttributeNames: { "#d": "date" },
    ExpressionAttributeValues: {
      ":cid": clientID,
      ":date": date,
    },
  };

  const result = await db.query(params).promise();
  let items = result.Items || [];

  // Filter by menuTypes if specified
  if (menuTypes && menuTypes.length > 0) {
    items = items.filter((item) => menuTypes.includes(item.menuType));
  }

  return items;
}

// ── Image Composition ──

/**
 * Download a slide template from S3
 */
async function downloadTemplate(templateKey) {
  const localPath = path.join(TMP_DIR, "templates", path.basename(templateKey));
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(localPath)) return localPath;

  const data = await s3
    .getObject({ Bucket: getSlidesBucketName(), Key: templateKey })
    .promise();
  fs.writeFileSync(localPath, data.Body);
  return localPath;
}

/**
 * Create an SVG text overlay for a slide
 */
function createTextOverlaySvg(textData, textZones) {
  let svgElements = "";

  for (const zone of textZones) {
    const text = textData[zone.id];
    if (!text) continue;

    const { x, y, width, style } = zone;
    const anchor = style.align === "center" ? "middle" : style.align === "right" ? "end" : "start";
    const textX = style.align === "center" ? x + width / 2 : style.align === "right" ? x + width : x;

    svgElements += `
      <text
        x="${textX}"
        y="${y + style.fontSize}"
        font-size="${style.fontSize}"
        font-weight="${style.fontWeight}"
        fill="${style.color}"
        text-anchor="${anchor}"
        font-family="Arial, Helvetica, sans-serif"
      >${escapeXml(text)}</text>`;
  }

  return `<svg width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    ${svgElements}
  </svg>`;
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
 * Compose text onto a slide template and save as PNG
 */
async function composeSlide(templatePath, textData, textZones, outputPath) {
  const svgOverlay = createTextOverlaySvg(textData, textZones);
  const svgBuffer = Buffer.from(svgOverlay);

  await sharp(templatePath)
    .resize(SLIDE_WIDTH, SLIDE_HEIGHT)
    .composite([{ input: svgBuffer, top: 0, left: 0 }])
    .png()
    .toFile(outputPath);

  return outputPath;
}

// ── Video Generation ──

/**
 * Generate the slide sequence based on clients and menus
 */
async function generateSlideSequence(clients, menuData, subLocationName) {
  const slides = []; // { imagePath, duration }
  let slideIndex = 0;

  for (const seqItem of defaultSequence) {
    const template = slideTemplates[seqItem.slideType];
    if (!template) continue;

    if (seqItem.perClient) {
      // Generate per-client slides
      for (const client of clients) {
        const clientMenus = menuData[client.clientID] || [];

        if (seqItem.slideType === "brandIntro") {
          const templatePath = await downloadTemplate(template.templateKey);
          const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
          const textData = {
            brandName: client.clientName || client.counterName || "Menu",
            tagline: subLocationName || "",
          };
          await composeSlide(templatePath, textData, template.textZones, outputPath);
          slides.push({ imagePath: outputPath, duration: template.duration });

        } else if (seqItem.slideType === "topSellingHeader") {
          const templatePath = await downloadTemplate(template.templateKey);
          const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
          const textData = {
            counterName: client.clientName || client.counterName || "",
          };
          await composeSlide(templatePath, textData, template.textZones, outputPath);
          slides.push({ imagePath: outputPath, duration: template.duration });

        } else if (seqItem.slideType === "menuItems") {
          // Split menu items into slides of N items each
          const itemsPerSlide = template.itemsPerSlide || 4;
          for (let i = 0; i < clientMenus.length; i += itemsPerSlide) {
            const chunk = clientMenus.slice(i, i + itemsPerSlide);
            const templatePath = await downloadTemplate(template.templateKey);
            const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);

            const textData = {};
            chunk.forEach((item, idx) => {
              const num = idx + 1;
              textData[`item${num}_name`] = item.itemName || item.name || "";
              textData[`item${num}_price`] = item.price ? `₹${item.price}` : "";
              textData[`item${num}_desc`] = item.description || item.itemDescription || "";
            });

            await composeSlide(templatePath, textData, template.textZones, outputPath);
            slides.push({ imagePath: outputPath, duration: template.duration });
          }
        }
      }
    } else {
      // Static slides (no text overlay needed, just use template as-is)
      const templatePath = await downloadTemplate(template.templateKey);
      const outputPath = path.join(TMP_DIR, `slide_${slideIndex++}.png`);
      // Copy template as slide (resize to standard dimensions)
      await sharp(templatePath).resize(SLIDE_WIDTH, SLIDE_HEIGHT).png().toFile(outputPath);
      slides.push({ imagePath: outputPath, duration: template.duration });
    }
  }

  return slides;
}

/**
 * Stitch slides into MP4 using FFmpeg with configurable duration per slide
 */
function stitchSlidesToVideo(slides, outputPath) {
  // Create FFmpeg concat demuxer file
  const concatFilePath = path.join(TMP_DIR, "concat.txt");
  const lines = slides.map(
    (s) => `file '${s.imagePath}'\nduration ${s.duration}`
  );
  // FFmpeg concat needs the last file repeated without duration
  if (slides.length > 0) {
    lines.push(`file '${slides[slides.length - 1].imagePath}'`);
  }
  fs.writeFileSync(concatFilePath, lines.join("\n"));

  // Run FFmpeg
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

// ── Main Processing ──

/**
 * Main entry point for video generation
 */
async function generateVideo(reqBody) {
  const { subLocationID, subLocationName, date, menuTypes } = reqBody;

  if (!subLocationID || !date) {
    throw new Error("subLocationID and date are required");
  }

  log.info("Starting video generation", { subLocationID, date, menuTypes });

  // Clean /tmp workspace
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // 1. Fetch clients for this subLocation
  const clients = await getClientsForSubLocation(subLocationID);
  if (clients.length === 0) {
    throw new Error(`No approved clients found for subLocation: ${subLocationID}`);
  }
  log.info("Fetched clients", { count: clients.length });

  // 2. Fetch menus for each client
  const menuData = {};
  for (const client of clients) {
    menuData[client.clientID] = await getMenuForClient(client.clientID, date, menuTypes);
  }
  log.info("Fetched menus", {
    clients: Object.keys(menuData).length,
    totalItems: Object.values(menuData).reduce((sum, items) => sum + items.length, 0),
  });

  // 3. Generate composed slide images
  const slides = await generateSlideSequence(clients, menuData, subLocationName || "");
  if (slides.length === 0) {
    throw new Error("No slides generated - check template configuration");
  }
  log.info("Generated slides", { count: slides.length });

  // 4. Stitch into MP4
  const videoFileName = `tv-ad-${subLocationID}-${date.replace(/\//g, "-")}-${Date.now()}.mp4`;
  const videoLocalPath = path.join(TMP_DIR, videoFileName);
  stitchSlidesToVideo(slides, videoLocalPath);
  log.info("Video generated", { path: videoLocalPath });

  // 5. Upload to S3
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

  // 6. Generate playable URL
  const cdnBase = getCdnBaseUrl();
  const videoUrl = `${cdnBase}/tv-ads/${s3Key}`;

  // 7. Save record to DynamoDB
  const record = {
    subLocationID,
    generatedAt: new Date().toISOString(),
    videoUrl,
    s3Key,
    date,
    menuTypes: menuTypes || [],
    subLocationName: subLocationName || "",
    clientCount: clients.length,
    slideCount: slides.length,
    status: "COMPLETED",
  };
  await db
    .put({ TableName: getTvAdsTableName(), Item: record })
    .promise();

  // 8. Cleanup
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  return {
    videoUrl,
    s3Key,
    slideCount: slides.length,
    clientCount: clients.length,
    generatedAt: record.generatedAt,
  };
}

/**
 * Get generation history for a subLocation
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
  getClientsForSubLocation,
  getMenuForClient,
};
