/**
 * Markdown helpers for what a Review run posts. Everything a model wrote goes
 * through {@link neutralise}, and everything of unbounded length through a
 * limit, before it is put in a pull request.
 */

/**
 * Longest description or comment body a Review run writes. GitHub's own limit
 * is 65,536 characters; this leaves a margin.
 */
export const GITHUB_BODY_LIMIT = 65_000;

/**
 * Defuses hidden comments in text a model wrote. The tool's own markers are
 * HTML comments (`<!-- pr-review:... -->`); a Reviewer that read a hostile
 * pull request must not be able to forge one, for example a Fingerprint that
 * would hide another Finding from the next run.
 */
export function neutralise(text: string): string {
  return text.replace(/<!--/g, "&lt;!--");
}

/** @returns `text` in a code fence that its own backticks cannot close. */
export function fence(text: string, info = ""): string {
  const longest = Math.max(
    2,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  const marks = "`".repeat(longest + 1);
  return `${marks}${info}\n${text}\n${marks}`;
}

/** @returns `text` as an inline code span. */
export function inlineCode(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.includes("`") ? `\`\` ${flat} \`\`` : `\`${flat}\``;
}

/** @returns `text` safe for one cell of a Markdown table. */
export function cell(text: string): string {
  return neutralise(text)
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * @returns `text` cut to at most `max` characters, ending in `note`, when it
 *   is longer. A visible note, never a silent cut.
 */
export function truncate(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - note.length);
  // Do not cut a surrogate pair in half.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${note}`;
}

export const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;
