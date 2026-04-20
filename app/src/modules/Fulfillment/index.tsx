import { useNavigate, useParams } from 'react-router-dom';
import Queue from './queue';
import Shelf from './shelf';
import styles from './Fulfillment.module.css';

type Tab = 'queue' | 'shelf';

export default function Fulfillment() {
  const { tab } = useParams<{ tab?: Tab }>();
  const navigate = useNavigate();
  const active: Tab = tab === 'shelf' ? 'shelf' : 'queue';

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${active === 'queue' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/queue')}
        >Fulfillment Queue</button>
        <button
          className={`${styles.tab} ${active === 'shelf' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/shelf')}
        >Inventory Shelf</button>
      </div>
      <div className={styles.tabPanel}>
        {active === 'queue' ? (
          <Queue />
        ) : (
          <Shelf />
        )}
      </div>
    </div>
  );
}
