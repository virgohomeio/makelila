import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { confirmAddress } from '../../lib/orders';
import { FormLayout } from './FormLayout';

export default function ConfirmAddressPage() {
  const [params] = useSearchParams();
  const orderId = params.get('order_id') ?? '';

  const [state, setState] = useState<'loading' | 'confirmed' | 'already' | 'error'>('loading');
  const [orderRef, setOrderRef] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) { setState('error'); setErrMsg('No order ID in link. Please use the link from your email.'); return; }
    confirmAddress(orderId)
      .then(({ order_ref, already_confirmed }) => {
        setOrderRef(order_ref);
        setState(already_confirmed ? 'already' : 'confirmed');
      })
      .catch(e => { setState('error'); setErrMsg((e as Error).message); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  return (
    <FormLayout title="Address Confirmation">
      {state === 'loading' && <p>Confirming your address…</p>}
      {state === 'confirmed' && (
        <>
          <p>✓ Your shipping address for order <strong>{orderRef}</strong> has been confirmed.</p>
          <p>We'll be in touch when your LILA ships!</p>
        </>
      )}
      {state === 'already' && (
        <>
          <p>Your address for order <strong>{orderRef}</strong> was already confirmed.</p>
          <p>Nothing more to do — we'll be in touch when your unit ships.</p>
        </>
      )}
      {state === 'error' && (
        <p style={{ color: '#c53030' }}>
          {errMsg ?? "Something went wrong. Please reply to your confirmation email and we'll help."}
        </p>
      )}
    </FormLayout>
  );
}
