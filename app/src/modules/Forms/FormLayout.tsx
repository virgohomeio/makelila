import type { ReactNode } from 'react';
import styles from './Forms.module.css';

export function FormLayout({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        {/* Brand stripe at top of card — Ladybug Red */}
        <div className={styles.brandStripe} />

        <header className={styles.header}>
          <img
            src={`${import.meta.env.BASE_URL}vcycene-logo-square.png`}
            alt="VCycene"
            className={styles.logo}
          />
          <div className={styles.brandLockup}>
            <div className={styles.wordmark}>make lila</div>
            <div className={styles.subwordmark}>VCycene Inc.</div>
          </div>
        </header>

        <main className={styles.main}>
          {title && <h1 className={styles.title}>{title}</h1>}
          {intro && <p className={styles.intro}>{intro}</p>}
          {children}
        </main>

        <footer className={styles.footer}>
          <div className={styles.footerLinks}>
            <a href="mailto:support@lilacomposter.com">support@lilacomposter.com</a>
            <span className={styles.footerDot}>·</span>
            <a href="https://lilacomposter.com" target="_blank" rel="noopener noreferrer">lilacomposter.com</a>
          </div>
          <div className={styles.footerCopy}>© VCycene Inc. — composting made effortless.</div>
        </footer>
      </div>
    </div>
  );
}
