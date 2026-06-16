import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { Customer } from '../../../lib/customers';

function AttributionChips({ customer }: { customer: Pick<Customer, 'first_touch_source' | 'first_touch_campaign_id' | 'last_touch_source' | 'last_touch_campaign_id'> }) {
  const first = customer.first_touch_source;
  const last  = customer.last_touch_source;
  if (!first && !last) {
    return <span data-testid="attribution-unknown">Attribution unknown</span>;
  }
  return (
    <div data-testid="attribution-chips">
      {first && (
        <span data-testid="first-touch">
          First touch: {first}{customer.first_touch_campaign_id ? ` · ${customer.first_touch_campaign_id}` : ''}
        </span>
      )}
      {last && (
        <span data-testid="last-touch">
          Last touch: {last}{customer.last_touch_campaign_id ? ` · ${customer.last_touch_campaign_id}` : ''}
        </span>
      )}
    </div>
  );
}

describe('JourneyTab attribution chips', () => {
  it('renders both chips when attribution is fully populated', () => {
    const { getByTestId } = render(<AttributionChips customer={{
      first_touch_source: 'facebook',
      first_touch_campaign_id: 'spring-2026-q1',
      last_touch_source: 'klaviyo',
      last_touch_campaign_id: 'welcome-series-v3',
    }} />);
    expect(getByTestId('first-touch').textContent).toContain('facebook · spring-2026-q1');
    expect(getByTestId('last-touch').textContent).toContain('klaviyo · welcome-series-v3');
  });

  it('shows attribution unknown when all fields null', () => {
    const { getByTestId } = render(<AttributionChips customer={{
      first_touch_source: null,
      first_touch_campaign_id: null,
      last_touch_source: null,
      last_touch_campaign_id: null,
    }} />);
    expect(getByTestId('attribution-unknown')).toBeTruthy();
  });

  it('renders first-touch only when last-touch is null', () => {
    const { queryByTestId } = render(<AttributionChips customer={{
      first_touch_source: 'shopify_direct',
      first_touch_campaign_id: null,
      last_touch_source: null,
      last_touch_campaign_id: null,
    }} />);
    expect(queryByTestId('first-touch')?.textContent).toContain('shopify_direct');
    expect(queryByTestId('last-touch')).toBeNull();
  });
});
