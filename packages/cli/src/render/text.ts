/**
 * Item ids, titles and statuses come from the tracker, subjects and ref names from
 * git. A line break in one would split its Markdown line, and other control
 * characters reach whatever displays the output, so both are neutralised.
 */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\r\n\t\v\f]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}
