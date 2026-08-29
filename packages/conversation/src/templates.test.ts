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

describe('meal-logging templates (09 §F, breakdown step 25)', () => {
  it('renders the full log reply with macros and the daily total, and no item breakdown for a single item', () => {
    const rendered = renderTemplate('meal_logged', {
      calories: 210,
      protein: 18,
      carbs: 2,
      fat: 15,
      itemBreakdown: '',
      todayCalories: 210,
      goalCalories: 1650,
    });

    expect(rendered).toBe('Logged: 210 cal, 18g protein, 2g carbs, 15g fat.\n\nToday: 210/1650 cal so far.');
  });

  it('includes the per-item breakdown when there is more than one item', () => {
    const itemBreakdown = '\n- eggs (2): 140 cal\n- toast (1 slice): 80 cal';

    const rendered = renderTemplate('meal_logged', {
      calories: 220,
      protein: 15,
      carbs: 16,
      fat: 11,
      itemBreakdown,
      todayCalories: 220,
      goalCalories: 1650,
    });

    expect(rendered).toContain('- eggs (2): 140 cal');
    expect(rendered).toContain('- toast (1 slice): 80 cal');
  });

  it('reads as one clean sentence with no confidenceNote', () => {
    expect(renderTemplate('meal_clarifying_question', { confidenceNote: '' })).toBe(
      'Got a partial read. What was it, roughly?',
    );
  });

  it('folds a real confidenceNote in with its own " — " separator', () => {
    expect(
      renderTemplate('meal_clarifying_question', { confidenceNote: " — couldn't tell the portion size" }),
    ).toBe("Got a partial read — couldn't tell the portion size. What was it, roughly?");
  });

  it('renders distinct copy for non-food vs. unassessable', () => {
    expect(renderTemplate('meal_non_food')).toContain("doesn't look like food");
    expect(renderTemplate('meal_unassessable')).toContain('clearer photo');
  });

  it('renders a distinct holding reply per source', () => {
    expect(renderTemplate('meal_holding_reply_photo')).toContain('photo');
    expect(renderTemplate('meal_holding_reply_text')).not.toContain('photo');
  });
});

describe('correction/delete templates (09 §F, breakdown step 25)', () => {
  it('renders the correction confirmation with the corrected entry\'s own day total', () => {
    const rendered = renderTemplate('correction_confirmed', {
      calories: 210,
      protein: 18,
      carbs: 2,
      fat: 15,
      dayCalories: 510,
    });

    expect(rendered).toBe(
      'Updated — that entry is now 210 cal, 18g protein, 2g carbs, 15g fat. Total for that day is now 510 cal.',
    );
  });

  it('renders the delete confirmation with the day total', () => {
    expect(renderTemplate('delete_confirmed', { dayCalories: 0 })).toBe(
      'Deleted. Total for that day is now 0 cal.',
    );
  });

  it('renders the disambiguation question and the not-found reply with no placeholders', () => {
    expect(renderTemplate('correction_disambiguation')).toContain('which one did you mean');
    expect(renderTemplate('correction_not_found')).toContain("couldn't find anything recent");
  });
});

describe('pause/resume templates (12 §A step 1)', () => {
  it('confirms the pause as a statement, and says logging still works', () => {
    const rendered = renderTemplate('pause_confirmed');
    expect(rendered).toContain('paused');
    expect(rendered.toLowerCase()).toContain('logging still works');
  });

  it('confirms the resume with no placeholders', () => {
    expect(renderTemplate('resume_confirmed')).toBe("Nudges are back on. Send your next meal whenever you're ready.");
  });
});

describe('proactive_checkin (09 §E step 16)', () => {
  it('matches Build Spec §4.4\'s sample transcript exactly', () => {
    expect(renderTemplate('proactive_checkin')).toBe("How'd dinner go tonight?");
  });

  it('contains no streak count, guilt language, or cross-user comparison, per Build Spec §5', () => {
    const rendered = renderTemplate('proactive_checkin').toLowerCase();
    expect(rendered).not.toMatch(/streak|missed|other user|everyone else/);
  });
});
