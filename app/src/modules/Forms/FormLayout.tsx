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
        <header className={styles.header}>
          <img
            src={`${import.meta.env.BASE_URL}vcycene-logo-square.png`}
            alt="VCycene"
            className={styles.logo}
          />
          <div className={styles.wordmark}>
            make <span className={styles.lila}>LILA</span>
          </div>
        </header>
        <main className={styles.main}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.intro}>{intro}</p>
          {children}
        </main>
        <footer className={styles.footer}>
          VCycene Inc. · <a href="mailto:support@lilacomposter.com">support@lilacomposter.com</a> · <a href="https://lilacomposter.com" target="_blank" rel="noopener noreferrer">lilacomposter.com</a>
        </footer>
      </div>
    </div>
  );
}
