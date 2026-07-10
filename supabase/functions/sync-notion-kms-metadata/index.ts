// supabase/functions/sync-notion-kms-metadata/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

type KmsPageRow = {
  id: string;
  notion_page_id: string;
};

async function notionGet(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${NOTION_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  if (!res.ok) throw new Error(`Notion GET ${path} → ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export function extractTitle(page: Record<string, unknown>): string {
  try {
    const props = page.properties as Record<string, unknown> | undefined;
    if (!props) return '';
    const prop =
      (props.title ?? props.Name ?? props.name) as
        | { title?: Array<{ plain_text: string }> }
        | undefined;
    return prop?.title?.[0]?.plain_text ?? '';
  } catch {
    return '';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const NOTION_TOKEN = Deno.env.get('NOTION_TOKEN');

  if (!NOTION_TOKEN) {
    return new Response(JSON.stringify({ error: 'NOTION_TOKEN secret not set' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    await authenticate(req, admin);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { data: rows, error: fetchErr } = await admin
    .from('kms_pages')
    .select('id, notion_page_id')
    .returns<KmsPageRow[]>();

  if (fetchErr) {
    return new Response(JSON.stringify({ error: fetchErr.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!rows?.length) {
    return new Response(JSON.stringify({ synced: 0, message: 'No pages registered' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Cache Notion user IDs → names within this run (avoids duplicate user fetches)
  const userCache = new Map<string, string>();
  const errors: string[] = [];
  let synced = 0;

  for (const row of rows) {
    try {
      const page = await notionGet(`/pages/${row.notion_page_id}`, NOTION_TOKEN);

      const lastEditedById =
        (page.last_edited_by as { id?: string } | undefined)?.id ?? null;

      let lastEditedByName = 'Notion User';
      if (lastEditedById) {
        if (userCache.has(lastEditedById)) {
          lastEditedByName = userCache.get(lastEditedById)!;
        } else {
          try {
            const user = await notionGet(`/users/${lastEditedById}`, NOTION_TOKEN);
            const name = (user.name as string | undefined) ?? 'Notion User';
            userCache.set(lastEditedById, name);
            lastEditedByName = name;
          } catch {
            // user info unavailable — use fallback, still continue syncing
            userCache.set(lastEditedById, 'Notion User');
          }
        }
      }

      const { error: updateErr } = await admin
        .from('kms_pages')
        .update({
          title: extractTitle(page),
          last_edited_by_name: lastEditedByName,
          last_edited_time: page.last_edited_time as string,
          synced_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      if (updateErr) throw new Error(updateErr.message);
      synced++;
    } catch (err) {
      errors.push(
        `${row.notion_page_id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return new Response(JSON.stringify({ synced, errors }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
