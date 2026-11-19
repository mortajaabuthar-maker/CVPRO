// Cloudflare Pages Function: POST /api/tailor
// Secrets: GEMINI_API_KEY, GROQ_API_KEY. Optional: GEMINI_MODEL, GROQ_MODEL, TURNSTILE_SECRET.
const MAX_CV = 12000;
const MAX_JD = 8000;

const SYSTEM = `You are an expert CV editor and career-document assistant. Transform the supplied CV into a clear, professional, well-structured CV. A target job description is optional; when provided, tailor the CV to it honestly.
STRICT RULES:
- Never invent or assume employers, job titles, dates, degrees, certifications, skills, tools, achievements, metrics, or personal/contact details.
- Keep the CV language the same as the source unless the user explicitly requests another language.
- Reorganize, rewrite, improve clarity, strengthen verbs, remove redundancy, and prioritize relevant content.
- Preserve useful details. Do not discard entire roles or sections without reason.
- If information is unclear or missing, leave it blank or flag it in gaps; do not guess.
- Return valid JSON only, with this schema:
{"personalInfo":{"name":"","contact":"","location":"","linkedin":""},"summary":"","experience":["Role — Company — Dates\\n- Bullet 1\\n- Bullet 2"],"education":["..."],"skills":["..."],"certifications":["..."],"projects":["..."],"languages":["..."],"changes":["..."],"gaps":["..."]}
Each section array should contain plain strings, one item per entry. Keep bullet content inside experience entries as lines. changes: 3-6 concise notes; gaps: up to 5 missing JD requirements (empty when no JD). Both in CV language.`;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

async function callGemini(env, userText) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: userText }] }], generationConfig: { temperature: 0.25, responseMimeType: "application/json" } })
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("");
  if (!text) throw new Error("Gemini empty response");
  return text;
}
async function callGroq(env, userText) {
  const model = env.GROQ_MODEL || "openai/gpt-oss-120b";
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0.25, response_format: { type: "json_object" }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userText }] })
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json(); const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq empty response"); return text;
}
function parseResult(raw) {
  const obj = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "").trim());
  if (!obj || typeof obj !== "object" || typeof obj.summary !== "string") throw new Error("Bad AI response shape");
  const arr = v => Array.isArray(v) ? v.slice(0, 30).map(x => String(x).trim()).filter(Boolean) : [];
  const pi = obj.personalInfo && typeof obj.personalInfo === "object" ? obj.personalInfo : {};
  return {
    personalInfo: { name: String(pi.name || ""), contact: String(pi.contact || ""), location: String(pi.location || ""), linkedin: String(pi.linkedin || "") },
    summary: obj.summary.trim(), experience: arr(obj.experience), education: arr(obj.education), skills: arr(obj.skills), certifications: arr(obj.certifications), projects: arr(obj.projects), languages: arr(obj.languages), changes: arr(obj.changes).slice(0, 8), gaps: arr(obj.gaps).slice(0, 8)
  };
}
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData(); form.append("secret", env.TURNSTILE_SECRET); form.append("response", token); form.append("remoteip", ip);
  try { const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form }); return (await res.json()).success === true; } catch { return false; }
}
async function checkLimits(env, ip) {
  const kv = env.RATE_KV; if (!kv) return null;
  const perIp = Number(env.RATE_LIMIT || 5), daily = Number(env.DAILY_CAP || 400), day = new Date().toISOString().slice(0, 10);
  const [ipCount, dayCount] = (await Promise.all([kv.get(`ip:${ip}`), kv.get(`day:${day}`)])).map(v => Number(v || 0));
  if (dayCount >= daily) return "وصلنا الحد اليومي للخدمة المجانية. جرّب لاحقاً.";
  if (ipCount >= perIp) return "طلبات كثيرة. انتظر 10 دقائق وحاول مرة ثانية.";
  await Promise.all([kv.put(`ip:${ip}`, String(ipCount + 1), { expirationTtl: 600 }), kv.put(`day:${day}`, String(dayCount + 1), { expirationTtl: 90000 })]);
  return null;
}
export async function onRequestPost({ request, env }) {
  let body; try { body = await request.json(); } catch { return json({ error: "الطلب غير صالح." }, 400); }
  const cv = String(body?.cv || "").trim(), jd = String(body?.jd || "").trim();
  if (cv.length < 50) return json({ error: "أدخل نص السيرة الذاتية بشكل كامل." }, 400);
  if (jd && jd.length < 30) return json({ error: "وصف الوظيفة قصير جداً. أضف النص كاملاً أو اتركه فارغاً." }, 400);
  if (cv.length > MAX_CV || jd.length > MAX_JD) return json({ error: "النص طويل جداً. اختصره وحاول مرة ثانية." }, 413);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await verifyTurnstile(env, body?.ts, ip))) return json({ error: "فشل التحقق. أعد تحميل الصفحة وحاول مرة ثانية." }, 403);
  const limited = await checkLimits(env, ip); if (limited) return json({ error: limited }, 429);
  const providers = []; if (env.GEMINI_API_KEY) providers.push(callGemini); if (env.GROQ_API_KEY) providers.push(callGroq);
  if (!providers.length) return json({ error: "الخدمة غير مهيأة بعد." }, 500);
  if (providers.length > 1 && Math.random() < 0.5) providers.reverse();
  const userText = `=== ORIGINAL CV ===\n${cv}\n\n=== TARGET JOB DESCRIPTION (OPTIONAL) ===\n${jd || "No job description supplied. Improve the CV generally without tailoring it to a specific job."}`;
  for (const provider of providers) { try { return json(parseResult(await provider(env, userText))); } catch (err) { console.log("AI provider failed:", String(err)); } }
  return json({ error: "الخدمة مشغولة حالياً. حاول بعد دقيقة." }, 503);
}
export async function onRequestGet({ env }) { return json({ ok: true, configured: !!(env.GEMINI_API_KEY || env.GROQ_API_KEY) }); }
