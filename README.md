# CVPRO

CVPRO is a responsive Arabic-first CV editor for Cloudflare Pages. Users can upload or paste an existing CV (PDF/DOCX), choose general improvement or job tailoring, edit structured sections, preview the document, and export Word or print/save as PDF.


## Features
- In-browser PDF and DOCX text extraction (file itself is not uploaded).
- CV improvement with an optional job description.
- Structured editable fields: personal details, summary, experience, education, skills, certifications, projects, and languages.
- AI change notes and job-requirement gaps.
- Redesigned responsive UI with upload drag-and-drop and Arabic RTL layout.
- CV live preview with improved print styles.
- DOCX download and browser print-to-PDF workflow.
- Gemini and Groq fallback providers.
- Optional Turnstile verification and KV-based request limits.

## Deploy
Deploy this repository as a Cloudflare Pages project. Use `public` as the static asset directory and keep the Pages Functions directory at `functions`.


## Environment variables / secrets
Set these in Cloudflare Pages:
- `GEMINI_API_KEY` (secret) — optional if Groq is configured.
- `GROQ_API_KEY` (secret) — optional if Gemini is configured.
- `GEMINI_MODEL` — optional; default currently `gemini-2.5-flash`.
- `GROQ_MODEL` — optional; default currently `openai/gpt-oss-120b`.
- `TURNSTILE_SECRET` — optional; enables server-side Turnstile validation.

For rate limiting, bind a Cloudflare KV namespace named `RATE_KV` and optionally set:
- `RATE_LIMIT` — requests per IP per 10 minutes (default 5).
- `DAILY_CAP` — total requests per day (default 400).

When Turnstile is enabled, also set the public site key in `public/index.html` in `TURNSTILE_SITE_KEY`.

## Privacy note
The CV text is extracted locally in the browser. Only extracted text is sent to the configured AI provider for processing. This project does not intentionally persist uploaded CVs or submitted CV text. Review the AI provider's own retention/privacy terms before deployment and disclose the provider processing to users.


## Export
- **Word**: generated client-side using the `docx` library loaded from CDN.
- **PDF**: use the browser print dialog and select “Save as PDF”. This approach uses browser print rendering and supports selecting the destination/printer.


## Limitations in this MVP
- Scanned/image-only PDFs require manual text input; OCR is not included.
- Section editing is text-based rather than a rich WYSIWYG editor.
- Word export is a simple document structure; template styling and advanced RTL layout are planned.
- AI quality and free-tier availability depend on the configured provider/model.
- Upload extraction depends on third-party browser libraries loaded from CDN.
