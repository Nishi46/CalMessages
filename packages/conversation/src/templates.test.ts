import { describe, expect, it } from 'vitest';
import { renderTemplate } from './templates.js';

describe('renderTemplate (07 §C, breakdown step 10)', () => {
  it('returns a template with no placeholders unchanged', () => {
    expect(renderTemplate('onboarding_q3')).toBe(
      'Last one — did a coach or clinic refer you? If not, just say no.',
    );
  });

  it('interpolates the goal confirmation numbers', () => {
    expect(
      renderTemplate('onboarding_goal_confirmation', { dailyCalories: 1650, dailyProtein: 120 }),
    ).toBe(
      'I\'ll set you at 1650 cal and 120g protein a day — easy to change anytime, just text "change my goal." Send me a photo of your next meal whenever you\'re ready.',
    );
  });

  it('leaves a placeholder untouched instead of throwing when a var is missing', () => {
    expect(renderTemplate('onboarding_goal_confirmation', { dailyCalories: 1650 })).toContain(
      '{dailyProtein}',
    );
  });
});
