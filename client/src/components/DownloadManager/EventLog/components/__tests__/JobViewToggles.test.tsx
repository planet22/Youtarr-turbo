import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import JobViewToggles from '../JobViewToggles';

const setup = (over: Partial<React.ComponentProps<typeof JobViewToggles>> = {}) => {
  const props = {
    swimlanes: false,
    onSwimlanesChange: jest.fn(),
    swimlanesAvailable: true,
    groupByJob: false,
    onGroupByJobChange: jest.fn(),
    groupTimeline: false,
    onGroupTimelineChange: jest.fn(),
    ...over,
  };
  render(<JobViewToggles {...props} />);
  return props;
};

describe('JobViewToggles', () => {
  test('shows both main options off', () => {
    setup();

    expect(screen.getByRole('button', { name: 'Swimlanes' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'By job' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('shows an option that is on as pressed', () => {
    setup({ swimlanes: true });

    expect(screen.getByRole('button', { name: 'Swimlanes' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('turns swimlanes on when clicked', async () => {
    const props = setup();

    await userEvent.click(screen.getByRole('button', { name: 'Swimlanes' }));

    expect(props.onSwimlanesChange).toHaveBeenCalledWith(true);
  });

  test('turns swimlanes off when clicked while on', async () => {
    const props = setup({ swimlanes: true });

    await userEvent.click(screen.getByRole('button', { name: 'Swimlanes' }));

    expect(props.onSwimlanesChange).toHaveBeenCalledWith(false);
  });

  test('turns grouping on without touching swimlanes', async () => {
    const props = setup();

    await userEvent.click(screen.getByRole('button', { name: 'By job' }));

    expect(props.onGroupByJobChange).toHaveBeenCalledWith(true);
    expect(props.onSwimlanesChange).not.toHaveBeenCalled();
  });

  test('hides Swimlanes when it is not available', () => {
    setup({ swimlanesAvailable: false });

    expect(screen.queryByRole('button', { name: 'Swimlanes' })).not.toBeInTheDocument();
  });

  test('still offers By job when Swimlanes is unavailable', () => {
    setup({ swimlanesAvailable: false });

    expect(screen.getByRole('button', { name: 'By job' })).toBeInTheDocument();
  });

  test('hides the Timeline option until By job is on', () => {
    setup();

    expect(screen.queryByRole('button', { name: 'Timeline' })).not.toBeInTheDocument();
  });

  test('offers Timeline once By job is on', () => {
    setup({ groupByJob: true });

    expect(screen.getByRole('button', { name: 'Timeline' })).toBeInTheDocument();
  });

  test('turns the timeline option on when clicked', async () => {
    const props = setup({ groupByJob: true });

    await userEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    expect(props.onGroupTimelineChange).toHaveBeenCalledWith(true);
  });
});
