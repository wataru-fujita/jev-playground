import { app } from "@azure/functions";
import {
  DEVICE_ID_RE, HttpError, ID_RE, expandParams, hfJson, judge, loadDevices, route,
  structuredQuestions, summarize, textQuestions,
} from "../lib.js";
import { PURPOSES } from "../eval.js";

const HF = "https://huggingface.co";

app.http("models", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "models",
  handler: route(async (req) => {
    const sort = req.query.get("sort") === "downloads" ? "downloads" : "trendingScore";
    const q = (req.query.get("q") ?? "").slice(0, 80);
    const p = expandParams();
    p.set("sort", sort);
    p.set("limit", "20");
    p.set("pipeline_tag", "text-generation");
    if (q) p.set("search", q);
    const list = await hfJson(`${HF}/api/models?${p}`);
    return { devices: loadDevices(), models: list.map(summarize) };
  }),
});

app.http("questions", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "questions",
  handler: route(async (req) => {
    const ids = (req.query.get("devices") ?? "").split(",").filter((d) => DEVICE_ID_RE.test(d));
    const devs = loadDevices().filter((d) => ids.includes(d.id));
    return { questions: req.query.get("mode") === "text" ? textQuestions : structuredQuestions(devs) };
  }),
});

app.http("judge", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "judge",
  handler: route(async (req, ctx) => {
    const body = await req.json().catch(() => ({}));
    const deviceIds = Array.isArray(body.devices) ? body.devices.slice(0, 12) : [];
    if (
      typeof body.id !== "string" || !ID_RE.test(body.id) ||
      !["text", "structured"].includes(body.mode) ||
      !(body.purpose in PURPOSES) ||
      !deviceIds.every((d) => typeof d === "string" && DEVICE_ID_RE.test(d))
    ) {
      throw new HttpError(400, "bad request");
    }
    return judge(body.id, body.mode, deviceIds, body.purpose, body.questions, (m) => ctx.log(m));
  }, { counted: true }),
});
