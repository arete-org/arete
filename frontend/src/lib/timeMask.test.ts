import { describe, expect, it } from 'vitest';
import { digitsValue, editDigits, formatDigits, pastedDigits, plausibleTime, valueDigits, type TimeMask } from './timeMask';

/** Keys typed at the end of the field, as the browser edits it ('⌫' is Backspace); returns the text shown. */
function type(keys: string, mask: TimeMask, start = '', replace = false): string {
  let digits = start;
  for (const key of keys) {
    const shown = formatDigits(digits, mask);
    digits = editDigits(digits, shown, key === '⌫' ? shown.slice(0, -1) : shown + key, replace, mask) ?? digits;
    replace = false;
  }
  return formatDigits(digits, mask);
}

describe('timer-style duration', () => {
  it('fills digits from the right and reads seconds', () => {
    for (const [keys, text, seconds] of [['2000', '20:00', 1200], ['100', '1:00', 60], ['90', '0:90', 90], ['13000', '1:30:00', 5400], ['5', '0:05', 5]] as const) {
      expect(type(keys, 'duration')).toBe(text);
      expect(digitsValue(keys, 'duration')).toBe(seconds);
    }
  });

  it('normalises seconds of 60 or more once the stored value is shown again', () => {
    expect(formatDigits(valueDigits(90, 'duration'), 'duration')).toBe('1:30');
    expect(formatDigits(valueDigits(5400, 'duration'), 'duration')).toBe('1:30:00');
    expect(formatDigits(valueDigits(45, 'duration'), 'duration')).toBe('0:45');
  });

  it('restarts a focused value with the first digit, then appends', () => {
    expect(type('25', 'duration', '2000', true)).toBe('0:25');
    expect(type('25', 'duration', '2000')).toBe('20:00:25');
    expect(type('⌫', 'duration', '2000', true)).toBe('');
    // A digit typed over the selected value is shorter than it, yet no deletion.
    expect(editDigits('2000', '20:00', '9', true, 'duration', false)).toBe('9');
  });

  it('removes the last digit on backspace', () => {
    expect(type('⌫', 'duration', '2000')).toBe('2:00');
    expect(type('⌫⌫⌫', 'duration', '100')).toBe('');
    // Whatever the deletion took, a separator included, the last digit goes.
    expect(editDigits('2000', '20:00', '2000', false, 'duration')).toBe('200');
  });

  it('ignores leading zeros, letters and digits past the limit, and leaves empty or zero unset', () => {
    expect(type('0020', 'duration')).toBe('0:20');
    expect(type('1234567', 'duration')).toBe('12:34:56');
    expect(editDigits('20', '0:20', '0:20a', false, 'duration')).toBeNull();
    expect(digitsValue('', 'duration')).toBeNull();
    expect(valueDigits(null, 'duration')).toBe('');
  });

  it('never cuts a stored value longer than the field', () => {
    const digits = valueDigits(100 * 3600, 'duration');
    expect(formatDigits(digits, 'duration')).toBe('100:00:00');
    expect(type('5', 'duration', digits)).toBe('100:00:00');
    expect(type('⌫', 'duration', digits)).toBe('10:00:00');
  });

  it('accepts a paste of digits or of a written duration, nothing else', () => {
    expect(pastedDigits('20:00', 'duration')).toBe('2000');
    expect(pastedDigits(' 1:30:00 ', 'duration')).toBe('13000');
    expect(pastedDigits('1:30', 'duration')).toBe('130');
    expect(pastedDigits('2000', 'duration')).toBe('2000');
    for (const text of ['1h30', '20 min', '1:3', '1:5:00', 'abc', '', '1234567']) expect(pastedDigits(text, 'duration')).toBeNull();
  });

  it('holds plausible durations up to 10:00:00', () => {
    expect(plausibleTime(36_000, 'duration')).toBe(true);
    expect(plausibleTime(36_001, 'duration')).toBe(false);
  });
});

describe("timer-style pace in m'ss per km", () => {
  it('fills digits from the right and reads seconds per km', () => {
    expect(type('330', 'pace')).toBe("3'30");
    expect(digitsValue('330', 'pace')).toBe(210);
    expect(type('1030', 'pace')).toBe("10'30");
    expect(digitsValue('1030', 'pace')).toBe(630);
    expect(type('10305', 'pace')).toBe("10'30");
  });

  it('normalises seconds of 60 or more on blur', () => {
    expect(type('375', 'pace')).toBe("3'75");
    expect(digitsValue('375', 'pace')).toBe(255);
    expect(formatDigits(valueDigits(255, 'pace'), 'pace')).toBe("4'15");
    expect(formatDigits(valueDigits(6000, 'pace'), 'pace')).toBe("100'00");
  });

  it('removes the last digit and accepts only a plain pasted pace', () => {
    expect(type('⌫', 'pace', '330')).toBe("0'33");
    expect(pastedDigits("4'15", 'pace')).toBe('415');
    expect(pastedDigits('4’15', 'pace')).toBe('415');
    for (const text of ["4'5", '4:15', "4'15/km", '4 min 15']) expect(pastedDigits(text, 'pace')).toBeNull();
  });

  it("holds plausible paces from 1'30 to 20'00 per km", () => {
    expect([89, 90, 1200, 1201].map(pace => plausibleTime(pace, 'pace'))).toEqual([false, true, true, false]);
  });
});
