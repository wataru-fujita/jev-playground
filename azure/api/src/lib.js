import { existsSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { TypeSafeClient, choice, score, noul } from "@typesafe-ai/sdk";
import { PURPOSES, bestDevice, evalDevice, q4SizeGb } from "./eval.js";

// Shared logic for the Azure Functions endpoints (ported from jev-playground/server.ts).

const HF = "https://huggingface.co";
const INPUT_USD_PER_MTOK = 0.042; // output is free

let client;
function getClient() {
  if (!process.env.TYPESAFE_API_KEY) throw new HttpError(500, "サーバーに TYPESAFE_API_KEY が設定されていません");
  return (client ??= new TypeSafeClient({ defaultModel: "jev-latest" }));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- simple shared-passphrase check (the page itself is public; only the API is gated) ----
const sha = (s) => createHash("sha256").update(s).digest();

// APP_USERS = "label:passphrase,label:passphrase" (labels a-z0-9_-, passphrases base64url, no ':' or ',').
// APP_PASSWORD alone still works as a single "owner" login. Removing a label revokes that person only.
function loadUsers() {
  const users = [];
  for (const part of (process.env.APP_USERS ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i > 0 && i < part.length - 1) users.push({ label: part.slice(0, i).trim(), pass: part.slice(i + 1).trim() });
  }
  if (process.env.APP_PASSWORD) users.push({ label: "owner", pass: process.env.APP_PASSWORD });
  return users;
}

// Returns the label of the person whose passphrase matched; throws 401 otherwise.
export function checkPassword(req) {
  const users = loadUsers();
  if (!users.length) throw new HttpError(500, "サーバーに合言葉(APP_USERS / APP_PASSWORD)が設定されていません");
  const given = sha(req.headers.get("x-app-password") ?? "");
  let who = null;
  // Check every entry (no early exit) and hash both sides so the comparison is constant-time.
  for (const u of users) if (timingSafeEqual(given, sha(u.pass)) && !who) who = u.label;
  if (!who) throw new HttpError(401, "合言葉が違います");
  return who;
}

// Best-effort daily cap on judge calls per person. In-memory, so it resets when the instance restarts;
// the hard cap on spending is the prepaid JEV credit.
const usage = new Map();
const DAILY_LIMIT = Number(process.env.DAILY_JUDGE_LIMIT ?? 100);

function countJudge(who) {
  if (who === "owner") return;
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(who);
  const n = u && u.day === day ? u.n : 0;
  if (n >= DAILY_LIMIT) throw new HttpError(429, `本日の判定回数の上限(${DAILY_LIMIT}回)に達しました。明日また試してください`);
  usage.set(who, { day, n: n + 1 });
}

// devices.json (your own devices, not committed) wins; otherwise the sample devices.example.json is used.
export const loadDevices = () => {
  const own = new URL("../devices.json", import.meta.url);
  return JSON.parse(readFileSync(existsSync(own) ? own : new URL("../devices.example.json", import.meta.url), "utf8"));
};

const EXPAND = [
  "downloads", "downloadsAllTime", "likes", "safetensors", "createdAt",
  "lastModified", "tags", "pipeline_tag", "gated", "trendingScore",
];

export function expandParams() {
  const p = new URLSearchParams();
  for (const e of EXPAND) p.append("expand[]", e);
  return p;
}

export async function hfJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new HttpError(502, `Hugging Face ${r.status}`);
  return r.json();
}

const daysSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000)) : null);

export function summarize(m) {
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

const getModel = (id) => hfJson(`${HF}/api/models/${id}?${expandParams()}`);

async function getCard(id) {
  const r = await fetch(`${HF}/${id}/raw/main/README.md`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return "";
  return (await r.text()).slice(0, 4000);
}

export const textQuestions = {
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

export function structuredQuestions(devices) {
  const q = {
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
  for (const d of devices) {
    q[`runs_${d.id}`] = noul(
      `The model can run on the device \`devices.${d.id}\` at 4-bit quantization and be fast enough for the \`purpose\`, given \`estimated_4bit_size_gb\`, the device's pool sizes (\`gb\`) and bandwidths (\`bandwidth_gb_per_s\`).`,
    );
  }
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
const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);

export function sanitizeQuestions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "質問の形式が正しくありません");
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > 14) throw new HttpError(400, "質問は1〜14個にしてください");
  const out = {};
  for (const [id, q] of entries) {
    if (!QID_RE.test(id)) throw new HttpError(400, `質問ID「${id}」は英数字・_・- のみ(40文字まで)です`);
    const instructions = str(q?.instructions, 600);
    if (!instructions?.trim()) throw new HttpError(400, `「${id}」の質問文が空か長すぎます`);
    if (q.type === "noul") {
      out[id] = { type: "noul", instructions };
    } else if (q.type === "choice") {
      const c = q.criteria;
      const keys = c && typeof c === "object" ? Object.keys(c) : [];
      if (keys.length < 2 || keys.length > 12) throw new HttpError(400, `「${id}」の選択肢は2〜12個にしてください`);
      const criteria = {};
      for (const k of keys) {
        const d = str(c[k], 300);
        if (!k.trim() || k.length > 40 || d === null) throw new HttpError(400, `「${id}」の選択肢が不正です`);
        criteria[k] = d;
      }
      out[id] = { type: "choice", instructions, criteria };
    } else if (q.type === "score") {
      const c = q.criteria;
      if (!Array.isArray(c) || c.length < 2 || c.length > 8) throw new HttpError(400, `「${id}」の段階は2〜8個にしてください`);
      const levels = c.map((x) => str(x, 300));
      if (levels.some((x) => x === null)) throw new HttpError(400, `「${id}」の段階が不正です`);
      out[id] = { type: "score", instructions, criteria: levels };
    } else {
      throw new HttpError(400, `「${id}」の種類が不正です`);
    }
  }
  return out;
}

export async function judge(id, mode, deviceIds, purpose, custom, log) {
  const devices = loadDevices().filter((d) => deviceIds.includes(d.id));
  if (mode === "structured" && !devices.length) throw new HttpError(400, "端末を1つ以上選んでください");

  const m = await getModel(id);
  const s = summarize(m);
  const license = (m.tags ?? []).find((t) => t.startsWith("license:"))?.slice(8) ?? null;
  const purposeLabel = PURPOSES[purpose]?.label ?? purpose;

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
                pools: d.pools.map((p) => ({ name: p.name, gb: p.gb, usable_fraction: p.ratio, bandwidth_gb_per_s: p.bw })),
              },
            ]),
          ),
        };
  const questions = custom ? sanitizeQuestions(custom) : mode === "text" ? textQuestions : structuredQuestions(devices);

  const t0 = Date.now();
  const res = await getClient().systemOne({ state, questions });
  const ms = Date.now() - t0;

  const usage = res.usage;
  const costUsd = usage ? (usage.input_tokens / 1e6) * INPUT_USD_PER_MTOK : 0;
  // Azure has no writable local disk worth keeping, so usage goes to the function log instead.
  if (usage) log?.(`[jev] ${id} ${mode} in=${usage.input_tokens} out=${usage.output_tokens} cost=$${costUsd.toFixed(6)}`);
  const code = devices.map((d) => ({ id: d.id, name: d.name, ...evalDevice(s.paramsB, d, purpose) }));
  return {
    mode, state, questions, answers: res.answers, usage, costUsd, ms, jevModel: res.model,
    summary: s, code, codeBest: bestDevice(s.paramsB, devices, purpose),
  };
}

export const ID_RE = /^[\w.-]+\/[\w.-]+$/;
export const DEVICE_ID_RE = /^[\w-]+$/;

// Wraps a handler: password check, JSON in/out, errors as { error }.
export function route(handler, { counted = false } = {}) {
  return async (req, ctx) => {
    try {
      const who = checkPassword(req);
      if (counted) countJudge(who);
      ctx.log(`[auth] user=${who} ${req.method} ${new URL(req.url).pathname}`);
      return { status: 200, jsonBody: await handler(req, ctx), headers: { "cache-control": "no-store" } };
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) ctx.error("[api]", e);
      if (status === 401) await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return { status, jsonBody: { error: e instanceof Error ? e.message : "error" } };
    }
  };
}
