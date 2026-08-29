import { describe, expect, it } from 'vitest';
import { isPauseText, isResumeText } from './pausePattern.js';

describe('isPauseText (12 §A, breakdown step 1)', () => {
  it.each(['pause', 'please pause', 'can you pause my nudges', 'stop nudges'])('matches %s', (text) => {
    expect(isPauseText(text)).toBe(true);
  });

  it('does not match a bare "stop" — that is the carrier-level STOP keyword (12 §C)', () => {
    expect(isPauseText('stop')).toBe(false);
    expect(isPauseText('STOP')).toBe(false);
  });

  it.each(['grilled salmon and rice', 'two eggs and toast', 'undo that'])(
    'does not match a plain meal description or correction like %s',
    (text) => {
      expect(isPauseText(text)).toBe(false);
    },
  );
});

describe('isResumeText (12 §A, breakdown step 1)', () => {
  it.each(['resume', 'please resume', "let's resume nudges"])('matches %s', (text) => {
    expect(isResumeText(text)).toBe(true);
  });

  it.each(['grilled salmon and rice', 'pause', 'start'])('does not match %s', (text) => {
    expect(isResumeText(text)).toBe(false);
  });
});
