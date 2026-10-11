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

/**
 * `oneLine`, then escapes Markdown syntax, so tracker and git text such as
 * `[x](https://example.com)` renders as literal text rather than as markup.
 */
export function mdEscape(text: string): string {
  return oneLine(text).replace(/([\\`*_{}[\]()#+!|<>&~])/g, '\\$1');
}

/** A Markdown code span that holds any text, backticks and table pipes included. */
export function codeSpan(text: string): string {
  const safe = oneLine(text).replace(/\|/g, '\\|');
  const runs = safe.match(/`+/g);
  const maxRun = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  if (maxRun === 0) return `\`${safe}\``;
  const fence = '`'.repeat(maxRun + 1);
  return `${fence} ${safe} ${fence}`;
}
