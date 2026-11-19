import type { ServiceTicket } from '../../lib/service';
import type { PartyResolver } from '../../lib/customers';
import { CustomerPartyName } from '../../components/CustomerPartyName';

// FR-6: one adapter from "a ticket" to "the person it's about", so every
// Service surface resolves the household the same way.
//
// `partiesFor` is optional on purpose. These components are rendered in bare
// unit tests and in a couple of places with no directory loaded; without a
// resolver they degrade to the ticket's own customer_name snapshot rather than
// rendering an empty cell.

type TicketLike = Pick<
  ServiceTicket,
  'customer_id' | 'customer_name' | 'customer_email' | 'customer_phone'
>;

export function TicketPartyLabel({
  ticket, partiesFor, variant = 'inline',
}: {
  ticket: TicketLike | null | undefined;
  partiesFor?: PartyResolver;
  variant?: 'full' | 'inline';
}) {
  if (!ticket) return <>No customer</>;

  const fallback = ticket.customer_name ?? ticket.customer_email ?? 'No customer';
  if (!partiesFor) return <>{fallback}</>;

  const parties = partiesFor({
    customerId: ticket.customer_id,
    fallbackName: fallback,
    fallbackPhone: ticket.customer_phone,
    fallbackEmail: ticket.customer_email,
  });
  return <CustomerPartyName parties={parties} variant={variant} />;
}
