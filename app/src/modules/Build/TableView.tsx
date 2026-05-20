import type { FactoryOrder, FreightShipment, BuildDefect, BurnInTest } from '../../lib/build';
import type { Unit } from '../../lib/stock';
import styles from './Build.module.css';

type Props = {
  orders: FactoryOrder[];
  shipments: FreightShipment[];
  defects: BuildDefect[];
  tests: BurnInTest[];
  units: Unit[];
  batchFilter: string;
  search: string;
};

export function TableView(_props: Props) {
  return (
    <div className={styles.empty}>
      Table view — to be implemented in Task 11.
    </div>
  );
}
