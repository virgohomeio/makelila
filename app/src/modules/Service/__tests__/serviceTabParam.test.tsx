import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import Service from '../index';

vi.mock('../FollowUpsTab', () => ({ FollowUpsTab: () => <div>FOLLOWUPS_TAB</div> }));
vi.mock('../OnboardingTab', () => ({ OnboardingTab: () => <div>ONBOARDING_TAB</div> }));
vi.mock('../SupportTab', () => ({ SupportTab: () => <div>SUPPORT_TAB</div> }));
vi.mock('../InboxTab', () => ({ InboxTab: () => <div>INBOX_TAB</div> }));
vi.mock('../ReplacementTab', () => ({ default: () => <div>REPLACEMENT_TAB</div> }));

describe('Service tab deep-linking', () => {
  it('opens the Follow-Ups tab when ?tab=followups', () => {
    render(<MemoryRouter initialEntries={['/service?tab=followups']}><Service /></MemoryRouter>);
    expect(screen.getByText('FOLLOWUPS_TAB')).toBeInTheDocument();
  });
  it('defaults to onboarding with no/unknown tab', () => {
    render(<MemoryRouter initialEntries={['/service?tab=bogus']}><Service /></MemoryRouter>);
    expect(screen.getByText('ONBOARDING_TAB')).toBeInTheDocument();
  });
});
