import { supabase } from './supabase';
import { logAction } from './activityLog';

export type OrderStatus = 'pending' | 'approved' | 'flagged' | 'held';

export type LineItem = {
  sku: string;
  name: string;
  qty: number;
  price_usd: number;
};

export type Order = {
  id: string;
  order_ref: string;
  status: OrderStatus;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  quo_thread_url: string | null;
  address_line: string;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt' | 'remote' | 'condo';
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  total_usd: number;
  line_items: LineItem[];
  notes: string;
  dispositioned_by: string | null;
  dispositioned_at: string | null;
  created_at: string;
};

const ACTION_TYPE: Record<Exclude<OrderStatus, 'pending'>, string> = {
  approved: 'order_approve',
  flagged:  'order_flag',
  held:     'order_hold',
};

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('orders: not authenticated');
  return data.user.id;
}

export async function disposition(
  id: string,
  status: Exclude<OrderStatus, 'pending'>,
  reason?: string,
): Promise<void> {
  const userId = await currentUserId();

  const { error } = await supabase
    .from('orders')
    .update({
      status,
      dispositioned_by: userId,
      dispositioned_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;

  await logAction(ACTION_TYPE[status], `Order ${id.slice(0, 8)}`, reason ?? '');
}

export async function needInfo(id: string, note: string = ''): Promise<void> {
  await currentUserId();
  await logAction('order_need_info', `Order ${id.slice(0, 8)}`, note);
}

export async function updateNotes(id: string, notes: string): Promise<void> {
  const { error } = await supabase.from('orders').update({ notes }).eq('id', id);
  if (error) throw error;
}
