import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ValidatedNumberField } from '../ValidatedNumberField';

const Harness = ({ initial = 5, min = 1, fallback = 90, onCommit }: { initial?: number; min?: number; fallback?: number; onCommit?: (n: number) => void }) => {
  const [value, setValue] = useState(initial);
  return (
    <ValidatedNumberField
      label="Days"
      value={value}
      min={min}
      fallback={fallback}
      onCommit={(n) => {
        setValue(n);
        onCommit?.(n);
      }}
    />
  );
};

const setup = (props: React.ComponentProps<typeof Harness> = {}) => {
  const onCommit = jest.fn();
  render(<Harness {...props} onCommit={onCommit} />);
  return { onCommit, user: userEvent.setup(), input: screen.getByLabelText('Days') };
};

describe('ValidatedNumberField', () => {
  it('shows the current value', () => {
    const { input } = setup({ initial: 12 });

    expect(input).toHaveValue(12);
  });

  it('commits a valid number as it is typed', async () => {
    const { user, input, onCommit } = setup();

    await user.clear(input);
    await user.type(input, '30');

    expect(onCommit).toHaveBeenLastCalledWith(30);
  });

  it('does not commit while the field is empty', async () => {
    const { user, input, onCommit } = setup();

    await user.clear(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue(null);
  });

  it('commits the fallback when an empty field is left', async () => {
    const { user, input, onCommit } = setup();

    await user.clear(input);
    await user.tab();

    expect(onCommit).toHaveBeenCalledWith(90);
    expect(input).toHaveValue(90);
  });

  it('commits the fallback when a number below the minimum is left', async () => {
    const { user, input, onCommit } = setup({ min: 1 });

    await user.clear(input);
    await user.type(input, '0');
    await user.tab();

    expect(onCommit).toHaveBeenLastCalledWith(90);
  });

  it('accepts zero when the minimum is zero', async () => {
    const { user, input, onCommit } = setup({ min: 0, fallback: 0, initial: 4 });

    await user.clear(input);
    await user.type(input, '0');
    await user.tab();

    expect(onCommit).toHaveBeenLastCalledWith(0);
  });

  it('keeps a valid entry unchanged when the field is left', async () => {
    const { user, input } = setup();

    await user.clear(input);
    await user.type(input, '30');
    await user.tab();

    expect(input).toHaveValue(30);
  });
});
