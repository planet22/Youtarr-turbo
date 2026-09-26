import React, { useEffect, useState } from 'react';
import { TextField, TextFieldProps } from '../../../ui';

interface ValidatedNumberFieldProps
  extends Omit<TextFieldProps, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'min'> {
  value: number;
  /** Smallest accepted value; anything below it (or not a number) is invalid. */
  min: number;
  /** Committed when the field is left with an invalid or empty entry. */
  fallback: number;
  onCommit: (value: number) => void;
}

/**
 * Number input that lets the user clear it and retype. A valid entry is
 * committed as they type; an empty or invalid one is only replaced with
 * `fallback` when the field loses focus.
 */
export function ValidatedNumberField({ value, min, fallback, onCommit, ...textFieldProps }: ValidatedNumberFieldProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const parse = (text: string): number | null => {
    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : null;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
    const parsed = parse(e.target.value);
    if (parsed !== null) onCommit(parsed);
  };

  const handleBlur = () => {
    const committed = parse(draft) ?? fallback;
    setDraft(String(committed));
    onCommit(committed);
  };

  return <TextField {...textFieldProps} type="number" value={draft} onChange={handleChange} onBlur={handleBlur} />;
}
