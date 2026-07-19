// app/src/modules/Products/IssueChatPanel.tsx
import { useState } from 'react';
import { sendIssueChatMessage } from '../../lib/products';
import styles from './Products.module.css';

type ChatTurn = { role: 'user' | 'assistant'; content: string; filed?: boolean };

export function IssueChatPanel({
  products,
  knownTeam,
}: {
  products: { id: string; label: string }[];
  knownTeam: string[];
}) {
  const [productId, setProductId] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const nextTurns: ChatTurn[] = [...turns, { role: 'user', content: text }];
    setTurns(nextTurns);
    setInput('');
    setSending(true);
    try {
      const response = await sendIssueChatMessage({
        messages: nextTurns.map(t => ({ role: t.role, content: t.content })),
        product_id: productId || null,
        products,
        knownTeam,
      });
      setTurns(prev => [...prev, { role: 'assistant', content: response.reply, filed: response.filed }]);
    } catch {
      setTurns(prev => [...prev, { role: 'assistant', content: "Something went wrong sending that — try again." }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.chatPanel}>
      <div className={styles.chatProductRow}>
        <span className={styles.chatProductLabel}>Product:</span>
        <select
          className={styles.chatProductSelect}
          value={productId}
          onChange={e => setProductId(e.target.value)}
        >
          <option value="">Unset — let the chat figure it out</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      <div className={styles.chatThread}>
        {turns.length === 0 && (
          <div className={styles.chatBubbleBot}>
            Describe an issue — what's wrong, who should own it, and a link if you have one — and I'll file it.
          </div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={
              t.role === 'user'
                ? styles.chatBubbleUser
                : t.filed
                  ? styles.chatBubbleFiled
                  : styles.chatBubbleBot
            }
          >
            {t.filed ? `✓ ${t.content}` : t.content}
          </div>
        ))}
        {sending && <div className={styles.chatThinking}>Thinking…</div>}
      </div>

      <div className={styles.chatInputRow}>
        <input
          className={styles.chatInput}
          placeholder="Describe the issue…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !sending) void send(); }}
          disabled={sending}
        />
        <button className={styles.chatSendBtn} onClick={() => void send()} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
