import { useState, type ReactNode } from 'react';
import { NavCard } from './NavCard';
import { MobileBackHeader } from './MobileBackHeader';
import styles from './MobileTabbedModule.module.css';

type CountTone = 'default' | 'alert' | 'warn';

export interface MobileTab<K extends string> {
  key: K;
  label: string;
  subtitle?: string;
  icon?: ReactNode;
  iconBg?: string;
  count?: number | string;
  countTone?: CountTone;
  content: ReactNode;
}

interface Props<K extends string> {
  tabs: MobileTab<K>[];
  /**
   * Optional controlled mode — pass `activeKey` + `onChange` to drive selection
   * from URL params (e.g. Fulfillment uses /fulfillment/:tab). If both are
   * omitted, the component manages its own state and starts at the picker.
   */
  activeKey?: K | null;
  onChange?: (key: K | null) => void;
}

// Mobile-only wrapper. Renders the tabs as a vertical NavCard list. When
// the operator taps a tab card, replaces the list with the tab's content
// plus a sticky back-header that returns to the picker.
//
// Desktop modules keep their existing horizontal tab strip + content layout;
// modules opt into this component only when on phone (see useIsMobile).
export function MobileTabbedModule<K extends string>({
  tabs,
  activeKey: controlledKey,
  onChange,
}: Props<K>) {
  const isControlled = controlledKey !== undefined;
  const [uncontrolledKey, setUncontrolledKey] = useState<K | null>(null);
  const activeKey = isControlled ? controlledKey : uncontrolledKey;
  const setActiveKey = (k: K | null) => {
    if (!isControlled) setUncontrolledKey(k);
    onChange?.(k);
  };

  const active = activeKey != null ? tabs.find(t => t.key === activeKey) : null;

  if (!active) {
    return (
      <div className={styles.cards}>
        {tabs.map(t => (
          <NavCard
            key={t.key}
            onClick={() => setActiveKey(t.key)}
            title={t.label}
            subtitle={t.subtitle}
            icon={t.icon}
            iconBg={t.iconBg}
            count={t.count}
            countTone={t.countTone}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <MobileBackHeader label={active.label} onBack={() => setActiveKey(null)} />
      {active.content}
    </>
  );
}
