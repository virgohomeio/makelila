# Hiring: multi-provider fallback for resume parsing — design

**Date:** 2026-08-26
**Module:** Hiring (Applicants tab → `parse-resume-batch` edge function)
**Status:** shipped. Qwen fallback deployed 2026-08-26 (`ff18ed3`); OpenAI added as a
third provider in the same session, at the user's request.

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
  are read. Reusable pieces go in `supabase/functions/_shared/`
  (`openaiCompat.ts`, `qwen.ts`, `openai.ts`, `documentText.ts`) so
  `suggest-screening-rubric` (also Claude-backed, also Hiring) can adopt them
  later without redoing the work.
- Out of scope: switching the *primary* provider, any UI change beyond what the
  existing error banner already shows, other Claude-backed functions
  (`verify-address`, `match-invoice`, ticket classifier, follow-up drafts).

## Fallback rule

Each provider with a key configured is tried in order — default
`claude, qwen, openai` — until one answers:

| Providers with keys | Behaviour |
|---|---|
| all three | Claude → Qwen → OpenAI |
| Claude + one fallback | Claude, then that fallback |
| Claude only | Claude only (pre-fallback behaviour) |
| fallbacks only | those, in order — no Anthropic key needed |
| none | 500 "no resume-parsing provider configured" |

`RESUME_PROVIDER_ORDER` (comma-separated, case/whitespace-insensitive)
overrides the order. Providers the operator doesn't name are appended in
default order rather than dropped, so a typo degrades to the default instead
of silently disabling a configured provider.

Falling through on *any* non-2xx is deliberate — the trigger the user saw was a
400 (credit exhausted), but a 401 (rotated key), 429 (rate limit), 529
(overloaded) or 5xx should all move to the next provider too. A *successful*
call whose JSON we can't parse is **not** retried elsewhere: that's a
model-output problem, not an availability problem, and the 502 "did not return
valid JSON" still applies.

If every provider fails, the 502 message chains them — each error already
names its own provider, e.g. `Claude 400: credit balance too low…; then Qwen
chat 401: … ; then OpenAI chat 404: …` — so the operator can tell which key
needs attention. The response also carries `providers_tried`, the quickest
way to see which keys the function can actually see.

## How the fallbacks read the file

Neither fallback's chat endpoint takes a DOCX, and OpenAI's PDF input needs a
different request shape per model generation. Model
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
- `POST {base}/chat/completions`, `Authorization: Bearer <key>`. Qwen and
  OpenAI speak the same wire format, so they share one client
  (`_shared/openaiCompat.ts`); only base URL, key, model and error label differ.
- `max_tokens` is deliberately omitted: reasoning models reject the parameter,
  and capping a JSON reply risks truncating it into something unparseable.
- A scanned / image-only PDF yields no text → clear error, never an empty
  prompt. Those still need Claude.

This works against any OpenAI-compatible host and any chat model, so a
workspace that lacks a particular file feature can't silently break a fallback —
and `OPENAI_BASE_URL` / `QWEN_BASE_URL` can point at Azure, a gateway, or
another region without a code change.

## Configuration (Supabase secrets)

| Secret          | Required | Default                                                   |
|-----------------|----------|-----------------------------------------------------------|
| `QWEN_API_KEY`  | to enable Qwen | — (Model Studio key; `sk-…` or newer `sk-ws-…`) |
| `QWEN_BASE_URL` | no       | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Singapore/international shared host) |
| `QWEN_MODEL`    | no       | `qwen-plus`                                               |
| `OPENAI_API_KEY` | to enable OpenAI | — (`sk-…` / `sk-proj-…`)                     |
| `OPENAI_BASE_URL` | no      | `https://api.openai.com/v1` (point at Azure / a gateway to override) |
| `OPENAI_MODEL`  | no       | `gpt-4o-mini` — OpenAI retires names over time; a 404 says to set this |
| `RESUME_PROVIDER_ORDER` | no | `claude,qwen,openai`                              |

The Qwen key is region-bound — Alibaba's docs state Singapore, US (Virginia) and
Beijing keys "are not interchangeable" — so `QWEN_BASE_URL` exists to switch
regions without a code change. Alibaba now recommends workspace-dedicated hosts
(`https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`);
the shared hosts are documented as still fully functional, and both answered a
probe on 2026-08-26 (401 `invalid_api_key` for a dummy key, i.e. alive).

## Code shape

```
parse-resume-batch/index.ts
  buildScoringPrompt()            unchanged
  parseModelJson(text)            pure fn — strips ``` fences, JSON.parse; shared by all providers
  parseProviderOrder(csv)         pure fn — RESUME_PROVIDER_ORDER to try-order, unnamed appended
  pickProviders(keys, orderCsv?)  pure fn — that order filtered to providers holding a key
  buildTextResumeMessage(prompt, text) pure fn — resume text + prompt, capped at 60k chars
  extractWithClaude(...)          document block; returns text or throws Error("Claude <status>: …")
  extractWithTextProvider(p, cfg, …)  extractDocumentText → chatCompletion; throws Error("<Label> …")
  handle()                        loops providers in order, records which one succeeded

_shared/documentText.ts
  extractDocumentText(bytes, mime) PDF via unpdf, DOCX via fflate + docxXmlToText()
                                   both loaded by DYNAMIC import so a parser that
                                   fails to initialise can't break function boot
_shared/openaiCompat.ts
  chatCompletion({label, apiKey, baseUrl, model, system?, user, maxTokens?, …})
                                   returns assistant text or throws "<label> …";
                                   401/404 errors name the env var to check
_shared/qwen.ts / _shared/openai.ts
  {qwen,openai}ConfigFromEnv()     defaults + overrides; null when the key is unset/empty
```

`fetch` is injectable so the client can be unit-tested with a stub.

The success response gains `provider: 'claude' | 'qwen' | 'openai'`, and a
failure response carries `providers_tried`. Nothing in the UI reads either yet
— the client type `ParseResumeResult` is left alone until something does —
they're there for the network tab, and the activity-log entry records
`Parsed by <provider>` in `detail` so we can see later how often each provider
carried the load.

## Testing

- `parse-resume-batch/index.test.ts`: `pickProviders` / `parseProviderOrder`
  (ordering, typos, duplicates, empty keys), `parseModelJson` (fenced / bare /
  invalid), `buildTextResumeMessage` (order, cap).
- `_shared/openaiCompat.test.ts`: stubbed-fetch — URL, bearer header, message
  shape, max_tokens omitted-unless-asked, trailing-slash base URL,
  label-prefixed errors, 401/404 hints, network and empty-response errors.
- `_shared/providerConfig.test.ts`: env defaults and overrides for both
  providers; null on unset/empty key.
- `_shared/documentText.test.ts`: `docxXmlToText` cases; real extraction from
  a tiny generated PDF and DOCX; unsupported mime; DOCX missing its document part.
- Run: `cd supabase/functions && npx deno@2 test --allow-net --allow-env --allow-read parse-resume-batch _shared/openaiCompat.test.ts _shared/providerConfig.test.ts _shared/documentText.test.ts` (43 tests)
  (Deno isn't installed on this machine; `npx deno@2` fetches it. Existing
  Hiring edge-function tests already run this way.)
- No live provider call in tests. Manual validation after deploy: upload a
  resume while the Anthropic key is still exhausted, confirm the candidate row
  appears and the response names whichever fallback answered.

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
4. OpenAI goes **after** Qwen rather than ahead of it, so adding it doesn't
   change what was already being tested. Flip with `RESUME_PROVIDER_ORDER`.
5. `gpt-4o-mini` as the OpenAI default: cheap, long-lived, widely available.
   Model availability couldn't be verified against the account from here, so a
   404 is made self-explaining rather than guessed at.
