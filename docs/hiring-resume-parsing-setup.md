# Hiring — resume parsing providers (Claude → Qwen → OpenAI)

The Applicants tab's resume uploader calls the `parse-resume-batch` edge
function, which reads each PDF/DOCX with an LLM to pull out name / email /
phone and a JD-grounded rubric score. Three providers are wired in; each is
tried in turn until one answers.

| Order | Provider | Secret(s) | Notes |
|---|---|---|---|
| 1 | Claude (`claude-haiku-4-5`) | `ANTHROPIC_API_KEY` | Reads the PDF/DOCX directly as a document block |
| 2 | Qwen (`qwen-plus`, Alibaba Model Studio) | `QWEN_API_KEY`, optional `QWEN_BASE_URL`, `QWEN_MODEL` | Text extracted locally, sent inline |
| 3 | OpenAI (`gpt-4o-mini`) | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `OPENAI_MODEL` | Text extracted locally, sent inline |

A provider with no key is skipped entirely. Any HTTP or network error (400
"credit balance too low", 401, 429, 529, 5xx…) moves on to the next one. If
every configured provider fails, the error names each failure in turn:

```
Claude 400: credit balance is too low…; then Qwen chat 401: … ; then OpenAI chat 404: …
```

Successful responses carry `provider: "claude" | "qwen" | "openai"`, and the
activity-log entry says `Parsed by <provider>`. A failure response also
carries `providers_tried`, which is the quickest way to see which keys the
function can actually see.

**Not retried across providers:** a provider that answers successfully but
returns unparseable JSON. That's a model-output problem, not availability —
retry the upload instead.

## Changing the order

Set `RESUME_PROVIDER_ORDER` to a comma-separated list, e.g.
`OPENAI,CLAUDE`. Case and whitespace don't matter. Any provider you don't
name is appended in default order rather than disabled, so a typo degrades
to the default instead of silently switching a provider off.

Useful when Claude is out of credit and you'd rather not eat a failed call
on every upload: `supabase secrets set RESUME_PROVIDER_ORDER=openai,qwen,claude`.

## Setting the keys

```powershell
# OpenAI
.\app\node_modules\.bin\supabase.cmd secrets set OPENAI_API_KEY=sk-proj-xxxxxxxx
# Qwen (Alibaba Cloud Model Studio; sk-… or newer sk-ws-…)
.\app\node_modules\.bin\supabase.cmd secrets set QWEN_API_KEY=sk-ws-xxxxxxxx
# optional overrides
# ... secrets set OPENAI_MODEL=gpt-4.1-mini
# ... secrets set QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# ... secrets set RESUME_PROVIDER_ORDER=openai,qwen,claude
```

**Qwen keys are region-bound** — Alibaba's docs state Singapore, US and
Beijing keys "are not interchangeable". The default base URL is the
international (Singapore) shared host; a Beijing-console key needs
`QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`.
Workspace-dedicated hosts
(`https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`)
also work.

**`OPENAI_BASE_URL`** lets you point at Azure OpenAI, an internal gateway, or
any other OpenAI-compatible host instead of `api.openai.com`.

Then redeploy: the GitHub `Deploy Supabase backend` workflow runs on push to
`supabase/functions/**` (runs can take ~20 min to appear — an empty Actions
list right after a push doesn't mean it didn't trigger), or run
`supabase functions deploy parse-resume-batch --project-ref txeftbbzeflequvrmjjr`.

## How the fallbacks read the file

Neither Qwen's nor OpenAI's chat API takes a DOCX, and OpenAI's PDF input
needs a different request shape per model generation. So the function
extracts the text itself — `unpdf` (pdf.js) for PDF, `fflate` + a
WordprocessingML flattener for DOCX (`_shared/documentText.ts`) — and sends
it inline ahead of the same scoring prompt Claude gets. Nothing is uploaded
to a third-party file store. Both providers speak the same
OpenAI-compatible wire format, so they share one client
(`_shared/openaiCompat.ts`).

A scanned / image-only PDF has no text layer and is reported as such
(`Qwen found no text in this file`); those still need Claude.

`max_tokens` is deliberately not sent — reasoning models reject the
parameter, and capping a JSON reply risks truncating it into something
unparseable.

## Troubleshooting

- **`… chat 401`** — the message names the exact secret and base URL to
  check. For Qwen this is usually a wrong-region key.
- **`… chat 404`** — the model doesn't exist for that account; the message
  names the env var to set. OpenAI retires model names over time, so
  `gpt-4o-mini` may need updating via `OPENAI_MODEL`.
- **`… could not read the file`** — pdf.js or the DOCX unzip failed. Try a
  `.docx` to see whether it's PDF-specific; if every PDF fails, the
  `npm:unpdf` bundle isn't loading in the edge runtime. Claude is unaffected
  either way (the parsers load via dynamic import, so they can't break boot).
- **`No resume-parsing provider configured`** — no key at all is set.
- **A provider never appears in `providers_tried`** — its key is unset or
  empty. Confirm with `supabase secrets list` that the name matches exactly.

## Tests

```powershell
cd supabase/functions
npx deno@2 test --allow-net --allow-env --allow-read parse-resume-batch _shared/openaiCompat.test.ts _shared/providerConfig.test.ts _shared/documentText.test.ts
```

Deno isn't installed on the dev machine; `npx deno@2` fetches it. The tests
stub `fetch` (no live provider calls) and extract text from tiny generated
PDF/DOCX files.
