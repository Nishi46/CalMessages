export interface MealCandidateItem {
  name: string;
  portion: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

// `rejectionReason` is only set when `isFood` is false — it distinguishes the
// two terminal-but-unloggable states Build Spec §4.2 replies to differently:
// 'non_food' ("say so plainly and drop it") vs. 'unassessable' (ask for a
// retake). 04 §5.3 treats both as terminal without saying how a caller tells
// them apart, so this is the discriminant Sprint 4's router needs.
export interface MealCandidate {
  items: MealCandidateItem[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  confidence: 'high' | 'medium' | 'low';
  confidenceNote?: string;
  isFood: boolean;
  rejectionReason?: 'non_food' | 'unassessable';
}
