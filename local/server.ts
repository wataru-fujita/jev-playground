import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { TypeSafeClient, choice, score, noul } from "@typesafe-ai/sdk";
import { PURPOSES, bestDevice, evalDevice, q4SizeGb } from "./public/eval.js";

// JEV playground: pick a Hugging Face model, devices and a purpose, then ask JEV
// two ways (text only vs. text + structured data) and compare with plain code.

// 環境変数ファイルを読む。JEV_ENV_FILE があればそのファイル、なければ ./.env(どちらもなければ、すでにある環境変数だけを使う)。
// 同期フォルダ(OneDrive など)の外に、キーのファイルを置けるようにするため。
const envFile = process.env.JEV_ENV_FILE ?? ".env";
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = 3210;
const HF = "https://huggingface.co";
const INPUT_USD_PER_MTOK = 0.042; // output is free

if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set");
const client = new TypeSafeClient({ defaultModel: "jev-latest" });

type Pool = { name: string; gb: number; bw: number; ratio: number };
type Device = { id: string; name: string; default?: boolean; pools: Pool[]; note?: string };
// devices.json (your own devices, not committed) wins; otherwise the sample devices.example.json is used.
const loadDevices = () =>
  JSON.parse(readFileSync(existsSync("devices.json") ? "devices.json" : "devices.example.json", "utf8")) as Device[];

const EXPAND = [
  "downloads", "downloadsAllTime", "likes", "safetensors", "createdAt",
  "lastModified", "tags", "pipeline_tag", "gated", "trendingScore",
];

type HfModel = {
  id: string;
  downloads?: number;
  downloadsAllTime?: number;
  likes?: number;
  createdAt?: string;
  lastModified?: string;
  tags?: string[];
  pipeline_tag?: string;
  safetensors?: { total?: number };
};

function expandParams() {
  const p = new URLSearchParams();
  for (const e of EXPAND) p.append("expand[]", e);
  return p;
}

async function hfJson(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Hugging Face ${r.status}`);
  return r.json();
}

const daysSince = (iso?: string) =>
  iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000)) : null;

function summarize(m: HfModel) {
  return {
    id: m.id,
    downloads30d: m.downloads ?? 0,
    downloadsAll: m.downloadsAllTime ?? 0,
    likes: m.likes ?? 0,
    ageDays: daysSince(m.createdAt),
    updatedDaysAgo: daysSince(m.lastModified),
    pipeline: m.pipeline_tag ?? null,
    paramsB: m.safetensors?.total ? m.safetensors.total / 1e9 : null,
    tags: m.tags ?? [],
  };
}

async function getModel(id: string) {
  return (await hfJson(`${HF}/api/models/${id}?${expandParams()}`)) as HfModel;
}

async function getCard(id: string) {
  const r = await fetch(`${HF}/${id}/raw/main/README.md`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return "";
  return (await r.text()).slice(0, 4000);
}

const textQuestions = {
  usecase: choice("What is the main intended use of the model described in `model_card`?", {
    chat: "General conversation or instruction following",
    coding: "Writing or reviewing code",
    vision: "Understanding images or video",
    embedding: "Text embeddings, retrieval or reranking",
    other: "Anything else, or the card does not say",
  }),
  suits_purpose: noul("The model described in `model_card` is a good fit for the `purpose`."),
  japanese: noul("The model card says or clearly implies that the model supports Japanese."),
  hype: score("How promotional (versus factual) is the writing in `model_card`?", [
    "Plain and factual, mostly specs and usage",
    "Mixed: some claims, some facts",
    "Heavily promotional, superlatives and unsupported claims",
  ]),
};

function structuredQuestions(devices: Device[]) {
  const q: Record<string, ReturnType<typeof noul | typeof score | typeof choice>> = {
    adoption: score(
      "How widely adopted is this model, given `downloads_30d` and `likes` relative to `age_days`?",
      ["Barely used", "Niche but real use", "Well used", "Very widely adopted"],
    ),
    maintained: noul("The model appears to be actively maintained, judging from `days_since_update` and `age_days`."),
    momentum: choice("Is attention on this model rising, steady or fading? Compare `downloads_30d` with `downloads_all_time` and `age_days`.", {
      rising: "Most of its downloads are recent",
      steady: "Downloads are spread fairly evenly over its life",
      fading: "Most downloads came long ago",
      unclear: "Not enough data to tell",
    }),
  };
  // One yes/no question per selected device, all answered in the same request.
  for (const d of devices) {
    q[`runs_${d.id}`] = noul(
      `The model can run on the device \`devices.${d.id}\` at 4-bit quantization and be fast enough for the \`purpose\`, given \`estimated_4bit_size_gb\`, the device's pool sizes (\`gb\`) and bandwidths (\`bandwidth_gb_per_s\`).`,
    );
  }
  // One choice whose options are built from the selected devices.
  q.best_device = choice(
    "Which device is the best place to run this model for the `purpose`? Prefer a device where it fits in memory and generation is fast enough.",
    {
      ...Object.fromEntries(devices.map((d) => [d.id, `Run it on ${d.name}`])),
      none: "It does not fit well on any of the devices",
    },
  );
  return q;
}

// Questions edited in the browser arrive as plain JSON; check shape and size before use.
const QID_RE = /^[\w-]{1,40}$/;
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

function sanitizeQuestions(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("質問の形式が正しくありません");
  const entries = Object.entries(raw as Record<string, any>);
  if (entries.length < 1 || entries.length > 14) throw new Error("質問は1〜14個にしてください");
  const out: Record<string, unknown> = {};
  for (const [id, q] of entries) {
    if (!QID_RE.test(id)) throw new Error(`質問ID「${id}」は英数字・_・- のみ(40文字まで)です`);
    const instructions = str(q?.instructions, 600);
    if (!instructions?.trim()) throw new Error(`「${id}」の質問文が空か長すぎます`);
    if (q.type === "noul") {
      out[id] = { type: "noul", instructions };
    } else if (q.type === "choice") {
      const c = q.criteria;
      const keys = c && typeof c === "object" ? Object.keys(c) : [];
      if (keys.length < 2 || keys.length > 12) throw new Error(`「${id}」の選択肢は2〜12個にしてください`);
      const criteria: Record<string, string> = {};
      for (const k of keys) {
        const d = str(c[k], 300);
        if (!k.trim() || k.length > 40 || d === null) throw new Error(`「${id}」の選択肢が不正です`);
        criteria[k] = d;
      }
      out[id] = { type: "choice", instructions, criteria };
    } else if (q.type === "score") {
      const c = q.criteria;
      if (!Array.isArray(c) || c.length < 2 || c.length > 8) throw new Error(`「${id}」の段階は2〜8個にしてください`);
      const levels = c.map((x) => str(x, 300));
      if (levels.some((x) => x === null)) throw new Error(`「${id}」の段階が不正です`);
      out[id] = { type: "score", instructions, criteria: levels };
    } else {
      throw new Error(`「${id}」の種類が不正です`);
    }
  }
  return out;
}

async function judge(
  id: string,
  mode: "text" | "structured",
  deviceIds: string[],
  purpose: string,
  custom?: unknown,
) {
  const all = loadDevices();
  const devices = all.filter((d) => deviceIds.includes(d.id));
  if (mode === "structured" && !devices.length) throw new Error("端末を1つ以上選んでください");

  const m = await getModel(id);
  const s = summarize(m);
  const license = (m.tags ?? []).find((t) => t.startsWith("license:"))?.slice(8) ?? null;
  const purposeLabel = PURPOSES[purpose as keyof typeof PURPOSES]?.label ?? purpose;

  const state =
    mode === "text"
      ? { model_name: id, purpose: purposeLabel, model_card: await getCard(id) }
      : {
          model_name: id,
          purpose: purposeLabel,
          parameters_billion: s.paramsB === null ? null : Math.round(s.paramsB * 100) / 100,
          estimated_4bit_size_gb: s.paramsB === null ? null : q4SizeGb(s.paramsB),
          downloads_30d: s.downloads30d,
          downloads_all_time: s.downloadsAll,
          likes: s.likes,
          age_days: s.ageDays,
          days_since_update: s.updatedDaysAgo,
          pipeline: s.pipeline,
          license,
          tags: s.tags.slice(0, 25),
          devices: Object.fromEntries(
            devices.map((d) => [
              d.id,
              {
                name: d.name,
                pools: d.pools.map((p) => ({
                  name: p.name,
                  gb: p.gb,
                  usable_fraction: p.ratio,
                  bandwidth_gb_per_s: p.bw,
                })),
              },
            ]),
          ),
        };
  const questions = custom
    ? (sanitizeQuestions(custom) as typeof textQuestions)
    : mode === "text" ? textQuestions : structuredQuestions(devices);

  const t0 = Date.now();
  const res = await client.systemOne({ state, questions });
  const ms = Date.now() - t0;

  const usage = (res as { usage?: { input_tokens: number; output_tokens: number } }).usage;
  const costUsd = usage ? (usage.input_tokens / 1e6) * INPUT_USD_PER_MTOK : 0;
  if (usage) {
    appendFileSync(
      "usage-log.jsonl",
      JSON.stringify({ at: new Date().toISOString(), id, mode, model: res.model, ...usage, costUsd }) + "\n",
    );
  }
  const code = devices.map((d) => ({ id: d.id, name: d.name, ...evalDevice(s.paramsB, d, purpose) }));
  return {
    mode, state, questions, answers: res.answers, usage, costUsd, ms, jevModel: res.model,
    summary: s, code, codeBest: bestDevice(s.paramsB, devices, purpose),
  };
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

async function readBody(req: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 60_000) throw new Error("body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const ID_RE = /^[\w.-]+\/[\w.-]+$/;
const DEVICE_ID_RE = /^[\w-]+$/;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, readFileSync("public/index.html", "utf8"), "text/html");
    }
    if (req.method === "GET" && url.pathname === "/eval.js") {
      return send(res, 200, readFileSync("public/eval.js", "utf8"), "text/javascript");
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      const sort = url.searchParams.get("sort") === "downloads" ? "downloads" : "trendingScore";
      const q = (url.searchParams.get("q") ?? "").slice(0, 80);
      const p = expandParams();
      p.set("sort", sort);
      p.set("limit", "20");
      p.set("pipeline_tag", "text-generation");
      if (q) p.set("search", q);
      const list = (await hfJson(`${HF}/api/models?${p}`)) as HfModel[];
      return send(res, 200, { devices: loadDevices(), models: list.map(summarize) });
    }
    if (req.method === "POST" && url.pathname === "/api/judge") {
      const body = await readBody(req);
      const deviceIds: string[] = Array.isArray(body.devices) ? body.devices.slice(0, 12) : [];
      if (
        !ID_RE.test(body.id) ||
        !["text", "structured"].includes(body.mode) ||
        !(body.purpose in PURPOSES) ||
        !deviceIds.every((d) => DEVICE_ID_RE.test(d))
      ) {
        return send(res, 400, { error: "bad request" });
      }
      return send(res, 200, await judge(body.id, body.mode, deviceIds, body.purpose, body.questions));
    }
    if (req.method === "GET" && url.pathname === "/api/questions") {
      const ids = (url.searchParams.get("devices") ?? "").split(",").filter((d) => DEVICE_ID_RE.test(d));
      const devs = loadDevices().filter((d) => ids.includes(d.id));
      const mode = url.searchParams.get("mode");
      return send(res, 200, { questions: mode === "text" ? textQuestions : structuredQuestions(devs) });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[playground]", e);
    send(res, 500, { error: e instanceof Error ? e.message : "error" });
  }
// Local only by default. For phone access over Tailscale, start-vpn.ps1 sets HOST to the Tailscale IP
// (never 0.0.0.0: this page spends API credit).
}).listen(PORT, process.env.HOST ?? "127.0.0.1", () => console.log(`http://${process.env.HOST ?? "localhost"}:${PORT}`));
