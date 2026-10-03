/*
 * Item ids, titles and statuses come from the tracker; subjects, ref and repo names
 * from git or a hand-edited artifact. C0/C1 control characters reach whatever
 * displays the output, and bidirectional-text controls can visually reorder it.
 * Other invisible characters, such as a zero-width space, are left alone.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Replaces control and bidirectional-text characters, line breaks included, with `?`. */
export function plain(text: string): string {
  return text.replace(UNSAFE, '?');
}

/** As `plain`, but folds line breaks and other whitespace controls into a space, so a Markdown line stays whole. */
export function oneLine(text: string): string {
  return plain(text.replace(/[\r\n\t\v\f]+/g, ' '));
}
