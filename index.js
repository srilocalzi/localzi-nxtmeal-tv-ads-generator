const services = require("./services");
const utils = require("./utils");

const log = utils.log;

const getMethod = (event) => event?.context?.["http-method"] || "";
const getBody = (event) => event?.["body-json"] || {};

const handlePost = async (event) => {
  const reqBody = getBody(event);
  log.info("POST /tv-ads-generator", { bodyKeys: Object.keys(reqBody) });

  const { action } = reqBody;

  if (action === "generate") {
    // Generate TV Ad video
    const result = await services.generateVideo(reqBody);
    return result;
  }

  return { message: "Unknown action. Use action: 'generate'" };
};

const handleGet = async (event) => {
  const querystring = event.params?.querystring || {};
  log.info("GET /tv-ads-generator", { params: Object.keys(querystring) });

  if (querystring.action === "config") {
    return services.getAdConfig();
  }

  if (querystring.subLocationID) {
    // Get generation history
    const history = await services.getGenerationHistory(querystring.subLocationID);
    return history;
  }

  return { message: "Use action=config or provide subLocationID to get generation history" };
};

const routes = {
  POST: handlePost,
  GET: handleGet,
};

exports.handler = async (event, context = {}) => {
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const method = getMethod(event);
    const handler = routes[method];

    if (!handler) {
      log.warn("Unsupported HTTP method", { method });
      return utils.response(502, `Unsupported method "${method}"`);
    }

    const result = await handler(event);
    return utils.response(200, result);
  } catch (err) {
    log.error("Handler Exception", { error: err.message, stack: err.stack });
    return utils.response(500, { message: err.message || "Internal Server Error" });
  }
};
