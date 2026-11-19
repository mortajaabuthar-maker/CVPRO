# CVPRO

Upload an old CV (PDF or Word) and get a clean, well-structured CV back as **Word (.docx)** and **PDF**.
Optionally paste a job description and the CV is tailored to it (without inventing experience).

## How it works
1. Browser reads the uploaded PDF/DOCX (pdf.js / mammoth) and extracts the text.
2. `POST /api/tailor` (Cloudflare Pages Function) sends the text to Gemini or Groq (free tiers, with fallback)
   and gets back a structured JSON CV.
3. The browser renders one template from that JSON:
   - preview on the page
   - Word: generated in the browser with `docx`
   - PDF: the browser's print engine (real selectable text, Arabic/RTL supported)

## Cloudflare settings
Secrets: `GEMINI_API_KEY`, `GROQ_API_KEY` (one is enough)
Optional variables: `GEMINI_MODEL`, `GROQ_MODEL`, `DEBUG=1` (shows provider errors in the response, for troubleshooting only)
Optional: `TURNSTILE_SECRET` (+ site key in `public/index.html`), KV binding `RATE_KV`, `RATE_LIMIT`, `DAILY_CAP`

Build settings: no build command, output directory `public`.
