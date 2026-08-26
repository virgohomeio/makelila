# Hiring — resume parsing providers (Claude primary, Qwen fallback)

The Applicants tab's resume uploader calls the `parse-resume-batch` edge
function, which reads each PDF/DOCX with an LLM to pull out name / email /
phone and a JD-grounded rubric score. Two providers are wired in:

| Provider | Role | Secret(s) |
|---|---|---|
| Claude (`claude-haiku-4-5`) | primary | `ANTHROPIC_API_KEY` |
| Qwen (`qwen-plus` via Alibaba Cloud Model Studio) | fallback — used when Claude returns any HTTP error (400 "credit balance too low", 401, 429, 529, 5xx…) or when no Anthropic key is set | `QWEN_API_KEY`, optional `QWEN_BASE_URL`, `QWEN_MODEL` |

If both fail, the upload error shows both messages
(`Claude 400: …; Qwen fallback also failed: Qwen chat 401: …`) so you can
tell which key needs attention. Successful responses carry
`provider: "claude" | "qwen"`, and the activity-log entry says
`Parsed by Claude` / `Parsed by Qwen`.

## Setting the Qwen key

1. Create an API key in Alibaba Cloud Model Studio (new keys start with
   `sk-ws-`, older ones with `sk-`; both work). **Note the region** — keys
   are region-bound:
   - International (Singapore) console → default base URL, nothing else to set.
   - China (Beijing) console → also set `QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`.
   - Workspace-dedicated hosts (`https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`)
     also work via `QWEN_BASE_URL` if Alibaba ever retires the shared host.
2. From the repo root:

```powershell
.\app\node_modules\.bin\supabase.cmd secrets set QWEN_API_KEY=sk-ws-xxxxxxxxxxxxxxxx
# optional overrides
# .\app\node_modules\.bin\supabase.cmd secrets set QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# .\app\node_modules\.bin\supabase.cmd secrets set QWEN_MODEL=qwen-flash
```

3. Redeploy the function (the GitHub `Deploy Supabase backend` workflow does
   this on push to `supabase/functions/**`, or run
   `supabase functions deploy parse-resume-batch --project-ref txeftbbzeflequvrmjjr`).
4. Validate: upload a resume from the Applicants tab. In the browser network
   tab the `parse-resume-batch` response should say `"provider":"qwen"` while
   the Anthropic account is still out of credit, and the candidate card should
   appear with contact info and suggested scores as before.

## How Qwen reads the file

Qwen's chat API has no document content block, so the function extracts the
text itself — `unpdf` (pdf.js) for PDF, `fflate` + a WordprocessingML
flattener for DOCX (`supabase/functions/_shared/documentText.ts`) — and
sends it inline ahead of the same scoring prompt Claude gets. Nothing is
uploaded to Alibaba's file store. A scanned / image-only PDF has no text
layer and is reported as such (`Qwen fallback found no text in this file`);
those still need Claude.

## Troubleshooting

- **`Qwen chat 401`** — wrong key, or a key from the other region. Check
  which console it came from and set/clear `QWEN_BASE_URL` accordingly.
- **`Qwen chat 4xx` mentioning the model** — `qwen-plus` isn't enabled for
  the workspace; pick one that is (`QWEN_MODEL=qwen-flash`, `qwen3-max`, …)
  from Model Studio's model list for your region.
- **`Qwen fallback could not read the file`** — pdf.js / the DOCX unzip
  failed on this particular file. Check the function logs; if it's every
  PDF, the `npm:unpdf` bundle may not be loading in the edge runtime.
- **`Qwen did not return valid JSON`** — the model answered but not in the
  expected shape; retry the upload. Not retried on the other provider by design.
- **Only Claude ever runs** — `QWEN_API_KEY` is unset or empty. Empty string
  is treated as unset on purpose.

## Tests

```powershell
cd supabase/functions
npx deno@2 test --allow-net --allow-env --allow-read parse-resume-batch _shared/qwen.test.ts _shared/documentText.test.ts
```

Deno isn't installed on the dev machine; `npx deno@2` fetches it. The tests
stub `fetch` (no live provider calls) and extract text from tiny generated
PDF/DOCX files.
