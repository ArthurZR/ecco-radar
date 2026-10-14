import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RejectDialog, PublishedDialog } from '../components/StatusActions';
import { StatusBadge, Thumb } from '../components/ui';
import { NAV } from '../App';

describe('navigation', () => {
  it('follows the order in the specification', () => {
    expect(NAV.map((n) => n.label)).toEqual(['RADAR', 'Explore', 'Archive', 'Caption Studio', 'Insights', 'Sources', 'Settings']);
  });
});

describe('RejectDialog', () => {
  it('sends the chosen reason and scope', () => {
    const onConfirm = vi.fn();
    render(<RejectDialog refLabel="#00042" onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'weak_attribution' } });
    fireEvent.click(screen.getByLabelText('This creator'));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm).toHaveBeenCalledWith({ status: 'rejected', reasonCode: 'weak_attribution', reasonScope: 'creator', notes: undefined });
  });
});

describe('PublishedDialog', () => {
  it('states that RADAR does not publish', () => {
    render(<PublishedDialog refLabel="#00001" onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText(/does not post, schedule or contact any platform/)).toBeInTheDocument();
  });
});

describe('ui', () => {
  it('labels manual publication as a report, not an action', () => {
    render(<StatusBadge status="manually_published" long />);
    expect(screen.getByText('Manually published')).toBeInTheDocument();
  });
  it('shows a labelled box when there is no image', () => {
    render(<MemoryRouter><Thumb src={null} alt="x" /></MemoryRouter>);
    expect(screen.getByText('No preview')).toBeInTheDocument();
  });
});
