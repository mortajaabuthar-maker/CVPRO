// Cloudflare Pages Function: POST /api/tailor
// Takes the text of a CV (and optionally a job description) and returns a STRUCTURED CV as JSON.
// The browser turns that JSON into the preview, the Word file and the PDF.
//
// Secrets (set in Cloudflare dashboard): GEMINI_API_KEY, GROQ_API_KEY
// Optional vars: GEMINI_MODEL, GROQ_MODEL, DEBUG (set to "1" to show provider errors to the client)
// Optional: TURNSTILE_SECRET, KV binding RATE_KV, RATE_LIMIT, DAILY_CAP

const MAX_CV = 12000;
const MAX_JD = 8000;

const SYSTEM = `You are an expert CV editor and formatter.
You receive (1) a candidate's current CV as raw text extracted from a PDF or Word file, so lines may be broken, columns merged or the order scrambled, and (2) optionally a target job description (JD).
Turn the CV into a clean, well-structured, ATS-friendly CV, returned as JSON.

Rules:
- NEVER invent jobs, employers, dates, degrees, certifications, skills, tools, links or numbers that are not in the original CV.
- Keep every real fact: all jobs, dates, education, certifications, languages, projects and contact details. If something does not fit a standard section (volunteering, awards, publications, references...), put it in "additional". Do not drop content to make the CV shorter.
- Copy dates, numbers and proper names exactly as written in the original.
- Order jobs, education and projects from most recent to oldest.
- Bullets: one idea each, start with a strong action verb, concise, at most 6 per role. Merge duplicates. If the original has only a paragraph for a job, split it into bullets.
- Summary: 2 to 3 sentences using only facts from the CV. If the original has no summary, write one from its facts.
- If a JD is provided: tailor the CV to it. Put the most relevant experience and skills first, shorten what is irrelevant, and use the JD's keywords ONLY where the CV already shows that experience. List up to 5 JD requirements the CV does not show in "gaps".
- If no JD is provided: only restructure and polish. "gaps" must be an empty list.
- Keep the CV in the same language as the original. Section labels must be in that language too.
- All strings are plain text. No markdown, no asterisks, no "#", no bullet characters inside strings.
- Respond with ONLY one JSON object in exactly this shape (use "" or [] for what the CV does not have):
{
  "lang": "<ISO 639-1 code of the CV language, e.g. en or ar>",
  "labels": {"summary":"","experience":"","education":"","skills":"","certifications":"","languages":"","projects":""},
  "name": "",
  "title": "<professional headline, taken from the CV or the most recent role>",
  "contact": ["<email>", "<phone>", "<city, country>", "<linkedin or website>"],
  "summary": "",
  "experience": [{"role":"","company":"","location":"","dates":"","bullets":[""]}],
  "education": [{"degree":"","school":"","location":"","dates":"","details":[""]}],
  "skills": [{"group":"<category or empty>","items":[""]}],
  "certifications": [""],
  "languages": ["<language (level)>"],
  "projects": [{"name":"","dates":"","bullets":[""]}],
  "additional": [{"title":"","items":[""]}],
  "changes": ["<short note on what you changed>"],
  "gaps": [""]
}
- "changes": 3 to 6 short notes, written in the same language as the CV.`;

const DEFAULT_LABELS = {
  en: {
    summary: "Summary", experience: "Experience", education: "Education", skills: "Skills",
    certifications: "Certifications", languages: "Languages", projects: "Projects",
  },
  ar: {
    summary: "الملخص المهني", experience: "الخبرات العملية", education: "التعليم", skills: "المهارات",
    certifications: "الشهادات", languages: "اللغات", projects: "المشاريع",
  },
};
const RTL_LANGS = new Set(["ar", "fa", "he", "ur", "ps", "ku"]);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

async function callGemini(env, userText) {
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: 8192 },
      }),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  if (!text) throw new Error("gemini empty");
  return text;
}

async function callGroq(env, userText) {
  const model = env.GROQ_MODEL || "openai/gpt-oss-120b";
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("groq empty");
  return text;
}

// ---------- Normalising the model output so the browser can trust the shape ----------
const s = (v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
const strs = (v, max = 40) => (Array.isArray(v) ? v : []).map(s).filter(Boolean).slice(0, max);
const objs = (v, max = 30) =>
  (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object").slice(0, max);

function normalizeSkills(v) {
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) {
    return [{ group: "", items: strs(v) }];
  }
  return objs(v)
    .map((g) => ({ group: s(g.group), items: strs(g.items) }))
    .filter((g) => g.items.length);
}

function parseResult(raw) {
  const clean = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const c = JSON.parse(clean);
  if (!c || typeof c !== "object") throw new Error("bad shape");

  const lang = s(c.lang).toLowerCase().slice(0, 2) || "en";
  const base = DEFAULT_LABELS[lang] || DEFAULT_LABELS.en;
  const lb = c.labels && typeof c.labels === "object" ? c.labels : {};
  const labels = {};
  for (const k of Object.keys(DEFAULT_LABELS.en)) labels[k] = s(lb[k]) || base[k];

  const cv = {
    lang,
    dir: RTL_LANGS.has(lang) ? "rtl" : "ltr",
    labels,
    name: s(c.name),
    title: s(c.title),
    contact: strs(c.contact, 8),
    summary: s(c.summary),
    experience: objs(c.experience)
      .map((e) => ({
        role: s(e.role), company: s(e.company), location: s(e.location), dates: s(e.dates),
        bullets: strs(e.bullets, 12),
      }))
      .filter((e) => e.role || e.company),
    education: objs(c.education)
      .map((e) => ({
        degree: s(e.degree), school: s(e.school), location: s(e.location), dates: s(e.dates),
        details: strs(e.details, 6),
      }))
      .filter((e) => e.degree || e.school),
    skills: normalizeSkills(c.skills),
    certifications: strs(c.certifications),
    languages: strs(c.languages, 12),
    projects: objs(c.projects)
      .map((p) => ({ name: s(p.name), dates: s(p.dates), bullets: strs(p.bullets, 8) }))
      .filter((p) => p.name),
    additional: objs(c.additional, 8)
      .map((a) => ({ title: s(a.title), items: strs(a.items) }))
      .filter((a) => a.title && a.items.length),
  };

  if (!cv.name && !cv.summary && !cv.experience.length && !cv.education.length) {
    throw new Error("empty cv");
  }
  return { cv, changes: strs(c.changes, 8), gaps: strs(c.gaps, 8) };
}

// Optional bot check. Active only if TURNSTILE_SECRET is set.
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// Optional limits. Active only if a KV namespace is bound as RATE_KV.
// RATE_LIMIT = requests per IP per 10 minutes (default 5), DAILY_CAP = total requests per day (default 400).
async function checkLimits(env, ip) {
  const kv = env.RATE_KV;
  if (!kv) return null;
  const perIp = Number(env.RATE_LIMIT || 5);
  const daily = Number(env.DAILY_CAP || 400);
  const day = new Date().toISOString().slice(0, 10);
  const [ipCount, dayCount] = (await Promise.all([kv.get(`ip:${ip}`), kv.get(`day:${day}`)])).map(
    (v) => Number(v || 0)
  );
  if (dayCount >= daily) return "وصلنا الحد اليومي للخدمة المجانية. جرّب باجر.";
  if (ipCount >= perIp) return "طلبات كثيرة منك. انتظر 10 دقائق وحاول مرة ثانية.";
  await Promise.all([
    kv.put(`ip:${ip}`, String(ipCount + 1), { expirationTtl: 600 }),
    kv.put(`day:${day}`, String(dayCount + 1), { expirationTtl: 90000 }),
  ]);
  return null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "الطلب غير صالح." }, 400);
  }

  const cv = String(body?.cv || "").trim();
  const jd = String(body?.jd || "").trim();
  if (cv.length < 50) return json({ error: "ارفع سيرتك أو الصق نصها كاملاً." }, 400);
  if (jd && jd.length < 30) return json({ error: "وصف الوظيفة قصير. الصقه كاملاً أو اتركه فارغاً." }, 400);
  if (cv.length > MAX_CV || jd.length > MAX_JD)
    return json({ error: "النص طويل جداً. اختصره وحاول مرة ثانية." }, 413);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await verifyTurnstile(env, body?.ts, ip)))
    return json({ error: "فشل التحقق. أعد تحميل الصفحة وحاول مرة ثانية." }, 403);
  const limited = await checkLimits(env, ip);
  if (limited) return json({ error: limited }, 429);

  // Providers that have a key configured
  const providers = [];
  if (env.GEMINI_API_KEY) providers.push(["gemini", callGemini]);
  if (env.GROQ_API_KEY) providers.push(["groq", callGroq]);
  if (!providers.length) return json({ error: "الخدمة غير مهيأة بعد." }, 500);

  // Spread load across both free tiers: random first choice, the other is the fallback
  if (providers.length > 1 && Math.random() < 0.5) providers.reverse();

  const userText =
    `=== CURRENT CV ===\n${cv}\n\n=== TARGET JOB DESCRIPTION ===\n` +
    (jd || "(none provided: only restructure and polish the CV)");

  const errors = [];
  for (const [name, fn] of providers) {
    try {
      const raw = await fn(env, userText);
      return json({ ...parseResult(raw), tailored: !!jd, provider: name });
    } catch (err) {
      console.log("provider failed:", name, String(err));
      errors.push(`${name}: ${String(err.message || err)}`);
    }
  }
  const detail = env.DEBUG ? " [" + errors.join(" | ") + "]" : "";
  return json({ error: "الخدمة مشغولة حالياً. حاول بعد دقيقة." + detail }, 503);
}

// Health check: open /api/tailor in the browser. Shows only whether keys are configured.
export async function onRequestGet({ env }) {
  return json({ ok: true, gemini: !!env.GEMINI_API_KEY, groq: !!env.GROQ_API_KEY });
}
