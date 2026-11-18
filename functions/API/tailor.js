// Cloudflare Pages Function: POST /api/tailor
// Secrets (set in Cloudflare dashboard): GEMINI_API_KEY, GROQ_API_KEY
// Optional vars: GEMINI_MODEL, GROQ_MODEL

const MAX_CV = 12000;
const MAX_JD = 8000;

const SYSTEM = `You are an expert CV editor. You receive a candidate's CV and a target job description (JD).
Rewrite the CV so it fits the JD as well as honestly possible.

Rules:
- NEVER invent jobs, employers, dates, degrees, certifications, skills, tools or numbers that are not in the original CV.
- You may reorder sections, reword bullets, strengthen action verbs, rewrite the summary, and use the JD's keywords ONLY where the CV already shows that experience.
- Put the most relevant experience and skills first. Trim or shorten what is irrelevant to the JD.
- Keep the CV in the same language as the original CV.
- Output plain text (no markdown symbols like ** or #). Use simple section titles in capital letters and "-" for bullets.
- Respond with ONLY a JSON object: {"cv": "<the full tailored CV as plain text>", "changes": ["<short note>", ...], "gaps": ["<JD requirement not covered by the CV>", ...]}
- "changes": 3 to 6 short notes on what you changed. "gaps": up to 5 JD requirements the candidate does not show. Write both lists in the same language as the CV.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

async function callGemini(env, userText) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  if (!text) throw new Error("gemini empty");
  return text;
}

async function callGroq(env, userText) {
  const model = env.GROQ_MODEL || "llama-3.3-70b-versatile";
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
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("groq empty");
  return text;
}

function parseResult(raw) {
  const clean = raw.replace(/^```json|```$/g, "").trim();
  const obj = JSON.parse(clean);
  if (typeof obj.cv !== "string" || !obj.cv.trim()) throw new Error("bad shape");
  return {
    cv: obj.cv.trim(),
    changes: Array.isArray(obj.changes) ? obj.changes.slice(0, 8).map(String) : [],
    gaps: Array.isArray(obj.gaps) ? obj.gaps.slice(0, 8).map(String) : [],
  };
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
  if (cv.length < 50) return json({ error: "الصق نص السيرة الذاتية كاملاً." }, 400);
  if (jd.length < 30) return json({ error: "الصق وصف الوظيفة كاملاً." }, 400);
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

  const userText = `=== CURRENT CV ===\n${cv}\n\n=== TARGET JOB DESCRIPTION ===\n${jd}`;

  for (const [name, fn] of providers) {
    try {
      const raw = await fn(env, userText);
      return json({ ...parseResult(raw), provider: name });
    } catch (err) {
      console.log("provider failed:", name, String(err));
    }
  }
  return json({ error: "الخدمة مشغولة حالياً. حاول بعد دقيقة." }, 503);
}
