import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import Service from '../index';

vi.mock('../FollowUpsTab', () => ({ FollowUpsTab: () => <div>FOLLOWUPS_TAB</div> }));
vi.mock('../OnboardingTab', () => ({ OnboardingTab: () => <div>ONBOARDING_TAB</div> }));
vi.mock('../SupportTab', () => ({ SupportTab: () => <div>SUPPORT_TAB</div> }));
vi.mock('../InboxTab', () => ({ InboxTab: () => <div>INBOX_TAB</div> }));

describe('Service tab deep-linking', () => {
  it('opens the Follow-Ups tab when ?tab=followups', () => {
    render(<MemoryRouter initialEntries={['/service?tab=followups']}><Service /></MemoryRouter>);
    expect(screen.getByText('FOLLOWUPS_TAB')).toBeInTheDocument();
  });
  it('defaults to onboarding with no/unknown tab', () => {
    render(<MemoryRouter initialEntries={['/service?tab=bogus']}><Service /></MemoryRouter>);
    expect(screen.getByText('ONBOARDING_TAB')).toBeInTheDocument();
  });
  it('no longer offers a Replacement tab', () => {
    render(<MemoryRouter initialEntries={['/service']}><Service /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Replacement' })).not.toBeInTheDocument();
  });
  it('redirects the old ?tab=replacement deep link to Fulfillment', () => {
    render(
      <MemoryRouter initialEntries={['/service?tab=replacement']}>
        <Routes>
          <Route path="/service" element={<Service />} />
          <Route path="/fulfillment/replacements" element={<div>FULFILLMENT_REPLACEMENTS</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('FULFILLMENT_REPLACEMENTS')).toBeInTheDocument();
  });
});
