import { describe, expect, it } from 'vitest';
import { digitsValue, formatDigits, maskDigits, valueDigits, type TimeMask } from './timeMask';

/** Types each key into the formatted text, as the field does, and returns the text shown. */
function type(keys: string, mask: TimeMask, start = ''): string {
  let digits = maskDigits(start, mask);
  for (const key of keys) digits = maskDigits(key === '⌫' ? formatDigits(digits, mask).slice(0, -1) : formatDigits(digits, mask) + key, mask);
  return formatDigits(digits, mask);
}

describe('timer-style duration', () => {
  it('fills digits from the right and reads seconds', () => {
    for (const [keys, text, seconds] of [['2000', '20:00', 1200], ['100', '1:00', 60], ['90', '0:90', 90], ['13000', '1:30:00', 5400], ['5', '0:05', 5]] as const) {
      expect(type(keys, 'duration')).toBe(text);
      expect(digitsValue(maskDigits(text, 'duration'), 'duration')).toBe(seconds);
    }
  });

  it('normalises seconds of 60 or more once the stored value is shown again', () => {
    expect(formatDigits(valueDigits(90, 'duration'), 'duration')).toBe('1:30');
    expect(formatDigits(valueDigits(5400, 'duration'), 'duration')).toBe('1:30:00');
    expect(formatDigits(valueDigits(45, 'duration'), 'duration')).toBe('0:45');
  });

  it('removes the last digit on backspace and keeps digits only when pasted', () => {
    expect(type('⌫', 'duration', '20:00')).toBe('2:00');
    expect(type('⌫⌫⌫', 'duration', '1:00')).toBe('');
    expect(type('5', 'duration', '20:00')).toBe('2:00:05');
    expect(maskDigits('20:00', 'duration')).toBe('2000');
    expect(maskDigits(' 1 h 30:00 ', 'duration')).toBe('13000');
  });

  it('ignores leading zeros and digits past the limit, and leaves empty or zero unset', () => {
    expect(type('0020', 'duration')).toBe('0:20');
    expect(type('1234567', 'duration')).toBe('12:34:56');
    expect(digitsValue('', 'duration')).toBeNull();
    expect(digitsValue(maskDigits('0:00', 'duration'), 'duration')).toBeNull();
    expect(valueDigits(null, 'duration')).toBe('');
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
  });

  it('removes the last digit and keeps digits only when pasted', () => {
    expect(type('⌫', 'pace', "3'30")).toBe("0'33");
    expect(maskDigits("4'15/km", 'pace')).toBe('415');
  });
});
