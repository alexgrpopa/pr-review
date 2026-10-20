/**
 * The Finding a Reviewer reports, and the validation of what a Reviewer
 * returns. The tool validates; a Reviewer never decides whether a Finding can
 * be anchored to a changed line (a later step does). Output that does not
 * validate marks the Reviewer failed.
 */

export const SEVERITIES = Object.freeze([
  "critical",
  "major",
  "minor",
  "nit",
] as const);

export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  /** Name of the Reviewer that reported it. Set by the tool, not the model. */
  reviewer: string;
  severity: Severity;
  /** How sure the Reviewer is, from 0 to 1. */
  confidence: number;
  /** File the Finding concerns, relative to the repository root. */
  path?: string;
  /** First line it concerns (1-based). Only with `path`. */
  line?: number;
  /** Last line it concerns, when it spans several. Only with `line`. */
  endLine?: number;
  title: string;
  /** Markdown: the problem and why it matters. */
  body: string;
  /** Exact replacement text for the lines. Only for a single-hunk fix. */
  suggestion?: string;
  /** Self-contained instruction for a coding agent. */
  fixPrompt: string;
}

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * The JSON Schema given to `claude -p --json-schema` for a Reviewer. It has
 * no `reviewer` property: the tool stamps the Reviewer's name on each Finding.
 */
export const REVIEWER_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: [...SEVERITIES] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          title: { type: "string" },
          body: { type: "string" },
          suggestion: { type: "string" },
          fixPrompt: { type: "string" },
        },
        required: ["severity", "confidence", "title", "body", "fixPrompt"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLineNumber(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

/**
 * Checks one Finding. Unknown properties are dropped from the returned value.
 */
export function validateFinding(value: unknown): ValidationResult<Finding> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["a Finding must be an object"] };
  }
  const errors: string[] = [];

  const requiredText = (name: "reviewer" | "title" | "body" | "fixPrompt") => {
    const field = value[name];
    if (typeof field !== "string" || field.trim() === "") {
      errors.push(`${name} must be a non-empty string`);
    }
  };
  requiredText("reviewer");
  requiredText("title");
  requiredText("body");
  requiredText("fixPrompt");

  if (!SEVERITIES.includes(value.severity as Severity)) {
    errors.push(`severity must be one of ${SEVERITIES.join(", ")}`);
  }
  const { confidence } = value;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    errors.push("confidence must be a number from 0 to 1");
  }

  const { path, line, endLine, suggestion } = value;
  if (path !== undefined && (typeof path !== "string" || path.trim() === "")) {
    errors.push("path must be a non-empty string");
  }
  if (line !== undefined && !isLineNumber(line)) {
    errors.push("line must be an integer of 1 or more");
  }
  if (endLine !== undefined) {
    if (!isLineNumber(endLine)) {
      errors.push("endLine must be an integer of 1 or more");
    } else if (isLineNumber(line) && endLine < line) {
      errors.push("endLine must not be before line");
    }
  }
  if (line !== undefined && path === undefined) {
    errors.push("line needs a path");
  }
  if (endLine !== undefined && line === undefined) {
    errors.push("endLine needs a line");
  }
  if (suggestion !== undefined) {
    if (typeof suggestion !== "string") {
      errors.push("suggestion must be a string");
    } else if (line === undefined) {
      errors.push("suggestion needs a line");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const finding: Finding = {
    reviewer: value.reviewer as string,
    severity: value.severity as Severity,
    confidence: confidence as number,
    title: value.title as string,
    body: value.body as string,
    fixPrompt: value.fixPrompt as string,
  };
  if (path !== undefined) finding.path = path as string;
  if (line !== undefined) finding.line = line as number;
  if (endLine !== undefined) finding.endLine = endLine as number;
  if (suggestion !== undefined) finding.suggestion = suggestion as string;
  return { ok: true, value: finding };
}

/**
 * Checks what a Reviewer returned (`{ findings: [...] }`) and stamps
 * `reviewer` on every Finding, whatever the model wrote there.
 */
export function validateReviewerOutput(
  reviewer: string,
  output: unknown,
): ValidationResult<Finding[]> {
  if (!isRecord(output) || !Array.isArray(output.findings)) {
    return {
      ok: false,
      errors: ["output must be an object with a findings array"],
    };
  }
  const findings: Finding[] = [];
  const errors: string[] = [];
  output.findings.forEach((item: unknown, index) => {
    const result = validateFinding(
      isRecord(item) ? { ...item, reviewer } : item,
    );
    if (result.ok) findings.push(result.value);
    else errors.push(...result.errors.map((e) => `findings[${index}]: ${e}`));
  });
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: findings };
}
