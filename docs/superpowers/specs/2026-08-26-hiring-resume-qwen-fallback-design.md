# Hiring: Qwen fallback for resume parsing — design

**Date:** 2026-08-26
**Module:** Hiring (Applicants tab → `parse-resume-batch` edge function)
**Status:** implemented alongside this spec (autonomous session; assumptions listed at the bottom)

## Problem

`parse-resume-batch` sends every uploaded resume to Claude (`claude-haiku-4-5`) as a
PDF/DOCX document block and gets back `{full_name, email, phone, suggested_scores}`.
The Anthropic account's credit ran out, so every upload now fails with
`Claude 400: … credit balance is too low …` and the Applicants uploader is dead
until someone tops up the account. We want a second provider (Qwen, via Alibaba
Cloud Model Studio / DashScope) that takes over automatically when Claude
returns an HTTP error, so resume intake keeps working.

## Scope

- In scope: `supabase/functions/parse-resume-batch` only — the one place resumes
  are read. Reusable pieces go in `supabase/functions/_shared/` (`qwen.ts`,
  `documentText.ts`) so `suggest-screening-rubric` (also Claude-backed, also
  Hiring) can adopt them later without redoing the work.
- Out of scope: switching the *primary* provider, any UI change beyond what the
  existing error banner already shows, other Claude-backed functions
  (`verify-address`, `match-invoice`, ticket classifier, follow-up drafts).

## Fallback rule

```
ANTHROPIC_API_KEY set?  QWEN_API_KEY set?  Behaviour
yes                     yes                Claude first; any non-2xx / network error → Qwen
yes                     no                 Claude only (today's behaviour)
no                      yes                Qwen directly
no                      no                 500 "no resume-parsing provider configured"
```

"Any non-2xx" is deliberate — the trigger the user sees today is a 400
(credit exhausted), but a 401 (rotated key), 429 (rate limit), 529 (overloaded)
or 5xx should all route to Qwen too. A *successful* Claude call whose JSON we
can't parse is **not** retried on Qwen: that's a model-output problem, not an
availability problem, and today's 502 "did not return valid JSON" still applies.

If Qwen also fails, the 502 error message carries both failures, e.g.
`Claude 400: credit balance too low…; Qwen fallback also failed: Qwen chat 401 …`,
so the operator can tell which key needs attention.

## How Qwen reads the file

Qwen's OpenAI-compatible chat endpoint has no document content block. Model
Studio does have a file API (`purpose=file-extract` + `fileid://` with
`qwen-long`), and a first cut used it — but the current docs only describe it
under the Beijing region, `qwen-long` isn't listed among the Singapore models,
and it means uploading every candidate's resume to a third-party store. So
instead the function extracts the text **locally** and sends it inline:

- PDF → `npm:unpdf` (pdf.js serverless build; ~180 ms for a one-page file under Deno).
- DOCX → `npm:fflate` unzips `word/document.xml`; a small flattener turns
  paragraphs into lines, `<w:tab/>`/`<w:br/>` into tab/newline, strips the
  rest and decodes entities.
- The text goes in the user message ahead of the same scoring prompt Claude
  gets (mirroring Claude's `[document, prompt]` order), capped at 60k chars.
- `POST {base}/chat/completions`, `model: qwen-plus` (Alibaba's own Singapore
  quickstart model), `Authorization: Bearer $QWEN_API_KEY`.
- A scanned / image-only PDF yields no text → clear error, never an empty
  prompt. Those still need Claude.

This works against any OpenAI-compatible Qwen host and any chat model, so a
workspace that lacks a particular file feature can't silently break the fallback.

## Configuration (Supabase secrets)

| Secret          | Required | Default                                                   |
|-----------------|----------|-----------------------------------------------------------|
| `QWEN_API_KEY`  | to enable the fallback | — (Model Studio key; `sk-…` or newer `sk-ws-…`) |
| `QWEN_BASE_URL` | no       | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Singapore/international shared host) |
| `QWEN_MODEL`    | no       | `qwen-plus`                                               |

The API key is region-bound — Alibaba's docs state Singapore, US (Virginia) and
Beijing keys "are not interchangeable" — so `QWEN_BASE_URL` exists to switch
regions without a code change. Alibaba now recommends workspace-dedicated hosts
(`https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`);
the shared hosts are documented as still fully functional, and both answered a
probe on 2026-08-26 (401 `invalid_api_key` for a dummy key, i.e. alive).

## Code shape

```
parse-resume-batch/index.ts
  buildScoringPrompt()            unchanged
  parseModelJson(text)            NEW pure fn — strips ``` fences, JSON.parse; shared by both providers
  pickProviders(anthropicKey, qwenKey) NEW pure fn — ordered provider list per the table above
  buildTextResumeMessage(prompt, text) NEW pure fn — resume text + prompt, capped
  extractWithClaude(...)          the existing fetch, now returns text or throws Error("Claude <status>: …")
  extractWithQwen(...)            extractDocumentText → chatCompletion; throws Error("Qwen …")
  handle()                        loops providers in order, records which one succeeded

_shared/documentText.ts
  extractDocumentText(bytes, mime) PDF via unpdf, DOCX via fflate + docxXmlToText()
_shared/qwen.ts
  chatCompletion({apiKey, baseUrl, model, system?, user, fetch?})  returns assistant text or throws
```

`fetch` is injectable so the client can be unit-tested with a stub.

The success response gains `provider: 'claude' | 'qwen'`. Nothing in the UI
reads it yet — the client type `ParseResumeResult` is left alone until
something does — it's there for the network tab, and the activity-log entry
now records `Parsed by Claude` / `Parsed by Qwen` in `detail` so we can see
later how often the fallback carried the load.

## Testing

- `parse-resume-batch/index.test.ts`: `pickProviders` table, `parseModelJson`
  (fenced / bare / invalid), `buildTextResumeMessage` (order, cap).
- `_shared/qwen.test.ts`: stubbed-fetch — URL, bearer header, message shape,
  base-URL/model overrides, 401 / network / empty-response errors.
- `_shared/documentText.test.ts`: `docxXmlToText` cases; real extraction from
  a tiny generated PDF and DOCX; unsupported mime; DOCX missing its document part.
- Run: `cd supabase/functions && npx deno@2 test --allow-net --allow-env --allow-read parse-resume-batch _shared/qwen.test.ts _shared/documentText.test.ts`
  (Deno isn't installed on this machine; `npx deno@2` fetches it. Existing
  Hiring edge-function tests already run this way.)
- No live provider call in tests. Manual validation after deploy: with
  `QWEN_API_KEY` set, upload a resume while the Anthropic key is still
  exhausted, confirm the candidate row appears and the response says
  `provider: "qwen"`.

## Risks

- `npm:unpdf` inside the Supabase edge runtime: an old (2023, esm.sh-era)
  GitHub issue reports "PDF.js is not available" on deploy. It works under
  plain Deno 2.9 locally with the `npm:` specifier. If it fails in production
  the error is `Qwen fallback could not read the file: …` on every PDF, and
  the Claude path is unaffected. Worth watching on the first real upload.

## Assumptions made without the user (flag if wrong)

1. The `sk-ws-…` key is from Alibaba Cloud Model Studio's **international
   (Singapore)** console — hence the default base URL. If it's a Beijing-region
   key, set `QWEN_BASE_URL`.
2. Only resume parsing needs the fallback right now; the rubric suggester keeps
   failing loudly on Claude until someone asks.
3. Falling back on *every* HTTP error (not just 400) is what "a 400 or
   something" was asking for.
