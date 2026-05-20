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

export function PipelineBoard(_props: Props) {
  return (
    <div className={styles.empty}>
      Pipeline Board — to be implemented in Task 6.
    </div>
  );
}
