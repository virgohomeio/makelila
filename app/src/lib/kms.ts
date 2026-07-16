import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type KmsPageMeta = {
  id: string;
  notion_page_id: string;
  section: string;
  label: string;
  notion_url: string | null;
  title: string | null;
  last_edited_by_name: string | null;
  last_edited_time: string | null;
  synced_at: string | null;
};

export function useKmsPages(): { pages: KmsPageMeta[]; loading: boolean; error: string | null } {
  const [pages, setPages] = useState<KmsPageMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('kms_pages')
      .select('*')
      .order('section')
      .order('label')
      .then(({ data, error: e }) => {
        if (e) setError(e.message);
        else setPages((data ?? []) as KmsPageMeta[]);
        setLoading(false);
      });
  }, []);

  return { pages, loading, error };
}
