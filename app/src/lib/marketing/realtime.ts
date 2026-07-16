import { supabase } from '../supabase';

// Marketing tables are bulk-written by sync edge functions (one sync upserts
// dozens of rows), so a naive reload-per-event would refetch dozens of times
// per sync. This helper coalesces each burst into a single trailing reload.

// Several tabs mount the same hook at once (e.g. useFbCampaigns in the module
// header and in DashboardTab); a per-subscription suffix keeps channel topics
// unique so the joins can't collide.
let seq = 0;

/** Subscribe to postgres_changes on `tables` and call `reload` (debounced)
 *  whenever any of them change. Returns a cleanup fn for useEffect. */
export function subscribeReload(
  channelName: string,
  tables: string[],
  reload: () => void,
  debounceMs = 500,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  };
  let channel = supabase.channel(`${channelName}:${++seq}`);
  for (const table of tables) {
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
  }
  channel.subscribe();
  return () => {
    if (timer) clearTimeout(timer);
    void supabase.removeChannel(channel);
  };
}
