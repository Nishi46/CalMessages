// Keyword match for the account-deletion trigger (12 §B step 5, Build Spec
// §4.7) — deliberately a different, narrower phrase set than
// correctionPattern.ts's isDeleteText ("delete that"/"undo", which target a
// single meal-log entry). "delete that" must never be mistaken for a
// request to erase the whole account, so there's no shared prefix between
// the two pattern lists.
const DELETE_ACCOUNT_PATTERNS: RegExp[] = [
  /\bdelete my (data|account|info(rmation)?)\b/i,
  /\bdelete all my data\b/i,
  /\b(erase|remove) my (data|account|info(rmation)?)\b/i,
];

export function isDeleteAccountText(text: string): boolean {
  return DELETE_ACCOUNT_PATTERNS.some((pattern) => pattern.test(text));
}
