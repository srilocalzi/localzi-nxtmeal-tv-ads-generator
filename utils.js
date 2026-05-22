const getEnvironment = () => (process.env.ENVIRONMENT || "DEVELOPMENT").toUpperCase();

const isProd = () => getEnvironment() === "PRODUCTION";

// ── DynamoDB Table Names ──
const getClientsTableName = () =>
  isProd()
    ? "localzi-nxtmeal-octopus-clients-prod"
    : "localzi-nxtmeal-octopus-clients-test";

const getDailyMenusTableName = () =>
  isProd()
    ? "localzi-nxtmeal-octopus-daily-menus-prod"
    : "localzi-nxtmeal-octopus-daily-menus-test";

const getQsrMenusTableName = () =>
  isProd()
    ? "localzi-nxtmeal-qsr-menus-prod"
    : "localzi-nxtmeal-qsr-menus-test";

const getTvAdsTableName = () =>
  isProd()
    ? "localzi-nxtmeal-tv-ads-prod"
    : "localzi-nxtmeal-tv-ads-test";

// ── S3 Bucket Names ──
const getSlidesBucketName = () =>
  isProd()
    ? "localzi-nxtmeal-tv-ads-slides-prod"
    : "localzi-nxtmeal-tv-ads-slides-test";

const getOutputBucketName = () =>
  isProd()
    ? "localzi-nxtmeal-tv-ads-output-prod"
    : "localzi-nxtmeal-tv-ads-output-test";

const getCdnBaseUrl = () =>
  process.env.CDN_BASE_URL || "https://d2nahbmqd5vvug.cloudfront.net";

// ── Logger ──
const log = {
  info: (msg, meta = {}) =>
    console.info(JSON.stringify({ level: "INFO", msg, ...meta })),
  warn: (msg, meta = {}) =>
    console.warn(JSON.stringify({ level: "WARN", msg, ...meta })),
  error: (msg, meta = {}) =>
    console.error(JSON.stringify({ level: "ERROR", msg, ...meta })),
};

// ── Response Helper ──
const response = (statusCode, body) => ({
  statusCode,
  body,
});

module.exports = {
  getEnvironment,
  isProd,
  getClientsTableName,
  getDailyMenusTableName,
  getQsrMenusTableName,
  getTvAdsTableName,
  getSlidesBucketName,
  getOutputBucketName,
  getCdnBaseUrl,
  log,
  response,
};
