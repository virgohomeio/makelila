import type { Order } from '../../lib/orders';
import { CustomerCard } from './detail/CustomerCard';
import { AddressCard }  from './detail/AddressCard';
import { FreightCard }  from './detail/FreightCard';
import { LineItemsCard } from './detail/LineItemsCard';
import { NotesCard } from './detail/NotesCard';
import styles from './OrderReview.module.css';

export function Detail({ order }: { order: Order }) {
  return (
    <section className={styles.detail}>
      <div className={styles.detailBody}>
        <CustomerCard order={order} />
        <AddressCard order={order} />
        <FreightCard order={order} />
        <LineItemsCard order={order} />
        <NotesCard order={order} />
      </div>
    </section>
  );
}
