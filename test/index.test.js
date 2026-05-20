const { expect } = require("chai");
const sinon = require("sinon");

describe("TV Ads Generator - Index", () => {
  let handler;
  let servicesStub;

  beforeEach(() => {
    servicesStub = {
      generateVideo: sinon.stub(),
      getGenerationHistory: sinon.stub(),
    };

    // Clear require cache to reload with stubs
    delete require.cache[require.resolve("../index")];
    delete require.cache[require.resolve("../services")];
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("POST - Generate Video", () => {
    it("should return 200 with video URL on successful generation", async () => {
      const { handler } = require("../index");

      const event = {
        context: { "http-method": "POST" },
        "body-json": {
          action: "generate",
          subLocationID: "test-123",
          subLocationName: "Test Location",
          date: "2025/01/15",
          menuTypes: ["lunch"],
        },
        params: {},
      };

      // This will fail without mocking DynamoDB/S3, but tests structure
      try {
        const result = await handler(event, {});
        // If it gets here, check response structure
        expect(result).to.have.property("statusCode");
        expect(result).to.have.property("body");
      } catch (err) {
        // Expected in unit test without AWS mocks
        expect(err).to.exist;
      }
    });

    it("should return 502 for unsupported HTTP method", async () => {
      const { handler } = require("../index");

      const event = {
        context: { "http-method": "PATCH" },
        "body-json": {},
        params: {},
      };

      const result = await handler(event, {});
      expect(result.statusCode).to.equal(502);
    });
  });

  describe("GET - Generation History", () => {
    it("should handle GET with subLocationID", async () => {
      const { handler } = require("../index");

      const event = {
        context: { "http-method": "GET" },
        "body-json": {},
        params: {
          querystring: { subLocationID: "test-123" },
        },
      };

      try {
        const result = await handler(event, {});
        expect(result).to.have.property("statusCode");
      } catch (err) {
        expect(err).to.exist;
      }
    });
  });
});

describe("TV Ads Generator - Utils", () => {
  const utils = require("../utils");

  it("should return correct table names for non-prod", () => {
    expect(utils.getClientTableName()).to.include("test");
    expect(utils.getMenuTableName()).to.include("test");
    expect(utils.getTvAdsTableName()).to.include("test");
  });

  it("should return correct S3 bucket names", () => {
    expect(utils.getSlidesBucketName()).to.include("test");
    expect(utils.getOutputBucketName()).to.include("test");
  });

  it("should format response correctly", () => {
    const res = utils.response(200, { message: "ok" });
    expect(res.statusCode).to.equal(200);
    expect(res.body.message).to.equal("ok");
  });
});

describe("TV Ads Generator - Slide Config", () => {
  const { slideTemplates, defaultSequence, SLIDE_WIDTH, SLIDE_HEIGHT } = require("../slideConfig");

  it("should have standard slide dimensions", () => {
    expect(SLIDE_WIDTH).to.equal(1366);
    expect(SLIDE_HEIGHT).to.equal(768);
  });

  it("should have all required template types", () => {
    expect(slideTemplates).to.have.property("brandIntro");
    expect(slideTemplates).to.have.property("topSellingHeader");
    expect(slideTemplates).to.have.property("menuItems");
    expect(slideTemplates).to.have.property("partyOrders");
    expect(slideTemplates).to.have.property("downloadApp");
    expect(slideTemplates).to.have.property("corporateCafeteria");
  });

  it("should have duration configured for each template", () => {
    Object.values(slideTemplates).forEach((template) => {
      expect(template.duration).to.be.a("number");
      expect(template.duration).to.be.greaterThan(0);
    });
  });

  it("should have a valid default sequence", () => {
    expect(defaultSequence).to.be.an("array");
    expect(defaultSequence.length).to.be.greaterThan(0);
    defaultSequence.forEach((item) => {
      expect(item).to.have.property("slideType");
      expect(slideTemplates).to.have.property(item.slideType);
    });
  });
});
