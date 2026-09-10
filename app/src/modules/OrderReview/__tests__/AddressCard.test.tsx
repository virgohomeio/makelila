import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { verifyAddressMock, setDwellingMock, setAreaTypeMock } = vi.hoisted(() => ({
  verifyAddressMock: vi.fn(),
  setDwellingMock:   vi.fn(() => Promise.resolve()),
  setAreaTypeMock:   vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    verifyAddress: verifyAddressMock,
    setDwelling:   setDwellingMock,
    setAreaType:   setAreaTypeMock,
    setSalesConfirmedFit: vi.fn(() => Promise.resolve()),
  };
});
vi.mock('../../../lib/templates', () => ({ sendTemplate: vi.fn(() => Promise.resolve({ message_id: 'm1' })) }));

import { AddressCard } from '../detail/AddressCard';
import type { Order } from '../../../lib/orders';

// #1220 in production: a Richmond Hill house, verified 2026-09-10.
function mkOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'o1', order_ref: '#1220', status: 'pending', kind: 'sale',
    customer_name: 'Test Customer', customer_email: 'c@example.com', customer_phone: null,
    quo_thread_url: null,
    address_line: '118 Holly Dr', address_line2: null,
    city: 'Richmond Hill', region_state: 'ON', country: 'CA',
    address_verdict: 'house', address_verdict_source: 'sync-guess',
    area_type: null, area_type_source: 'auto', address_area_type_error: null,
    address_verified_at: null, address_match: null, address_unit_status: null,
    address_google_formatted: null, address_google_postal: null, address_customer_postal: 'L4S2R6',
    address_validation_granularity: null, address_usps_dpv: null, address_usps_record_type: null,
    address_is_residential: null, address_is_business: null,
    address_claude_verdict: null, address_claude_notes: null, address_claude_postal: null,
    address_confirmed_at: null, address_confirmation_sent_at: null,
    sales_confirmed_fit: false,
    ...over,
  } as unknown as Order;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('AddressCard — an unverified address says so', () => {
  it('does not present the sync-time guess as a confirmed building type', () => {
    // The bug: 280 of 287 orders read "HOUSE · Single-family · standard
    // delivery" whether or not anyone had ever checked.
    render(<AddressCard order={mkOrder()} />);
    expect(screen.getByText(/not confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/unconfirmed — guessed from the address text/i)).toBeInTheDocument();
    expect(screen.queryByText(/Single-family · standard delivery/i)).not.toBeInTheDocument();
  });

  it('shows the postal code as unverified until it has been checked', () => {
    render(<AddressCard order={mkOrder()} />);
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.getByText(/not checked against a postal authority yet/i)).toBeInTheDocument();
  });

  it('shows an unclassified area as unclassified, not as "Suburban"', () => {
    // The other half of the bug: `return 'suburban'` filed every non-rural
    // address as suburban with an "auto" provenance.
    render(<AddressCard order={mkOrder()} />);
    const areaSelect = screen.getByLabelText('Area type') as HTMLSelectElement;
    expect(areaSelect.value).toBe('');
    expect(screen.getByText(/urban and suburban cannot be told apart from a postal code/i)).toBeInTheDocument();
  });
});

describe('AddressCard — a verified address shows what was actually checked', () => {
  const verified = mkOrder({
    address_verified_at: '2026-09-10T15:14:35Z',
    address_match: 'match',
    address_verdict: 'house',
    address_verdict_source: 'google',
    address_google_postal: 'L4S 2R6',
    address_google_formatted: '118 Holly Drive, Richmond Hill, ON L4S 2R6, Canada',
    address_validation_granularity: 'PREMISE',
    area_type: 'suburban',
    area_type_source: 'verified',
    address_unit_status: 'not_required',
  });

  it('says the postal code matches, and where that came from', () => {
    render(<AddressCard order={verified} />);
    expect(screen.getByText(/POSTAL CODE MATCH/)).toBeInTheDocument();
    expect(screen.getByText(/matches the postal authority/i)).toBeInTheDocument();
  });

  it('attributes a confirmed building type to the verification', () => {
    render(<AddressCard order={verified} />);
    expect(screen.getByText(/confirmed by address verification/i)).toBeInTheDocument();
    expect(screen.getByText(/Single-family · standard delivery/i)).toBeInTheDocument();
  });

  it('attributes a classified area to the verification rather than to a guess', () => {
    render(<AddressCard order={verified} />);
    expect(screen.getByText(/classified by address verification/i)).toBeInTheDocument();
  });

  it('surfaces how precisely Google resolved the address', () => {
    // PREMISE vs ROUTE is exactly how much to trust the building type.
    render(<AddressCard order={verified} />);
    expect(screen.getByText('PREMISE')).toBeInTheDocument();
  });
});

describe('AddressCard — the missing unit number', () => {
  // #1209 in production: 10350 W Bay Harbor Dr, unit 4N, in a tower. It read
  // "house · standard delivery" before this.
  const noUnit = mkOrder({
    address_line: '10350 W Bay Harbor Dr', address_line2: null,
    city: 'Bay Harbor Is', region_state: 'FL', country: 'US',
    address_verified_at: '2026-09-10T15:14:35Z',
    address_match: 'match', address_verdict: 'apt', address_verdict_source: 'google',
    address_unit_status: 'missing', address_usps_dpv: 'D', address_usps_record_type: 'H',
  });

  it('shows a prominent alert naming the problem and the fix', () => {
    render(<AddressCard order={noUnit} />);
    expect(screen.getByText(/no unit number/i)).toBeInTheDocument();
    // Said twice on purpose: once in the alert, once as the building type's
    // delivery consequence.
    expect(screen.getAllByText(/multi-unit building/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/ask the customer for it before booking freight/i)).toBeInTheDocument();
  });

  it('cites the USPS record type behind the verdict', () => {
    render(<AddressCard order={noUnit} />);
    expect(screen.getByText(/USPS record type H/)).toBeInTheDocument();
  });

  it('asks for a sales fit confirmation, which a house never needs', () => {
    render(<AddressCard order={noUnit} />);
    expect(screen.getByText(/sales confirmed fit with customer \(required for an? apartment address\)/i))
      .toBeInTheDocument();
  });

  it('flags a unit the postal authority does not recognise at that address', () => {
    render(<AddressCard order={mkOrder({
      address_line2: '4N', address_verified_at: '2026-09-10T15:14:35Z',
      address_match: 'match', address_unit_status: 'unrecognized',
    })} />);
    expect(screen.getByText(/unit not recognised/i)).toBeInTheDocument();
  });
});

describe('AddressCard — running a verify', () => {
  it('reports what each pass established, including what it could not', async () => {
    // A verify that silently established nothing used to read exactly like one
    // that established everything.
    verifyAddressMock.mockResolvedValue({
      match: 'match', customer_postal: 'L4S2R6', google_postal: 'L4S 2R6',
      google_formatted: '118 Holly Drive, Richmond Hill, ON L4S 2R6, Canada',
      dwelling: 'house', dwelling_source: 'google', unit_status: 'not_required',
      area_type: null, area_type_error: 'No LLM provider configured — area type not classified.',
    });
    render(<AddressCard order={mkOrder()} />);
    fireEvent.click(screen.getByRole('button', { name: /verify address/i }));
    await waitFor(() => {
      expect(screen.getByText(/Building: house \(confirmed by the postal authority\)/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Area not classified — No LLM provider configured/)).toBeInTheDocument();
  });

  // uspsData is US-only, so a Canadian address gets no record of what kind of
  // building it is. The model pass names it instead, and the message says which
  // of the two happened rather than reading the same either way.
  it('distinguishes a building the model read from one a postal authority confirmed', async () => {
    verifyAddressMock.mockResolvedValue({
      match: 'match', customer_postal: 'L4S2R6', google_postal: 'L4S 2R6',
      google_formatted: '118 Holly Drive, Richmond Hill, ON L4S 2R6, Canada',
      dwelling: 'apt', dwelling_source: 'model', unit_status: 'unknown',
      area_type: 'urban', area_type_error: null,
    });
    render(<AddressCard order={mkOrder()} />);
    fireEvent.click(screen.getByRole('button', { name: /verify address/i }));
    await waitFor(() => {
      expect(screen.getByText(/Building: apartment \(read from the address — no postal-authority record\)/))
        .toBeInTheDocument();
    });
  });

  it('says plainly when Google resolved the street but not the building', () => {
    verifyAddressMock.mockResolvedValue({
      match: 'match', customer_postal: 'L4S2R6', google_postal: 'L4S 2R6', google_formatted: null,
      dwelling: 'house', dwelling_source: 'sync-guess', unit_status: 'unknown',
      area_type: 'suburban', area_type_error: null,
    });
    render(<AddressCard order={mkOrder()} />);
    fireEvent.click(screen.getByRole('button', { name: /verify address/i }));
    return waitFor(() => {
      expect(screen.getByText(/Building: still unconfirmed/)).toBeInTheDocument();
    });
  });
});

describe('AddressCard — operator override', () => {
  it('lets an operator set the building type themselves', async () => {
    render(<AddressCard order={mkOrder()} />);
    fireEvent.change(screen.getByLabelText('Building type'), { target: { value: 'condo' } });
    await waitFor(() => expect(setDwellingMock).toHaveBeenCalledWith('o1', 'condo'));
  });

  it('offers every dwelling type the verification can produce', () => {
    render(<AddressCard order={mkOrder()} />);
    const select = screen.getByLabelText('Building type');
    const values = Array.from(select.querySelectorAll('option')).map(o => (o as HTMLOptionElement).value);
    expect(values).toEqual(['house', 'apt', 'condo', 'remote', 'business', 'po_box']);
  });
});
