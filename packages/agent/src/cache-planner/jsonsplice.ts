// TS port of public/proxy/providers/jsonsplice (Go), operating on strings.
// Splice-in-place is the byte-safety mechanism: every byte outside an edited
// span survives verbatim, so provider-native hints can be inserted without
// re-serializing (and thereby perturbing) the caller's request body. Bodies
// are JSON, so UTF-16 code-unit offsets and Go's byte offsets identify the
// same positions for the ASCII structural characters this scanner tracks.

export interface Span {
  start: number;
  end: number;
}

export interface FieldInsertion {
  name: string;
  value: string;
}

const SPACE = new Set([" ", "\n", "\r", "\t"]);
const VALUE_TERMINATORS = new Set([",", "}", "]", " ", "\n", "\r", "\t"]);

function jsonValid(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function root(body: string): Span | undefined {
  if (!jsonValid(body)) return undefined;
  const start = space(body, 0);
  const end = valueEnd(body, start);
  if (end === undefined || start >= body.length || body[start] !== "{" ||
      space(body, end) !== body.length) {
    return undefined;
  }
  return { start, end };
}

export function field(body: string, object: Span, name: string): Span | undefined {
  if (object.start < 0 || object.end > body.length || object.start >= object.end ||
      body[object.start] !== "{" || body[object.end - 1] !== "}") {
    return undefined;
  }
  let i = space(body, object.start + 1);
  while (i < object.end && body[i] !== "}") {
    const keyEnd = stringEnd(body, i);
    if (keyEnd === undefined) return undefined;
    let key: string;
    try {
      key = JSON.parse(body.slice(i, keyEnd)) as string;
    } catch {
      return undefined;
    }
    i = space(body, keyEnd);
    if (i >= object.end || body[i] !== ":") return undefined;
    const start = space(body, i + 1);
    const end = valueEnd(body, start);
    if (end === undefined) return undefined;
    if (key === name) return { start, end };
    i = space(body, end);
    if (i < object.end && body[i] === ",") i = space(body, i + 1);
  }
  return undefined;
}

export function elements(body: string, array: Span): Span[] | undefined {
  if (array.start < 0 || array.end > body.length || array.start >= array.end ||
      body[array.start] !== "[" || body[array.end - 1] !== "]") {
    return undefined;
  }
  const out: Span[] = [];
  let i = space(body, array.start + 1);
  while (i < array.end && body[i] !== "]") {
    const end = valueEnd(body, i);
    if (end === undefined) return undefined;
    out.push({ start: i, end });
    i = space(body, end);
    if (i < array.end && body[i] === ",") i = space(body, i + 1);
  }
  return out;
}

export function stringValue(body: string, span: Span): string | undefined {
  if (span.start < 0 || span.end > body.length || span.start >= span.end ||
      body[span.start] !== '"') {
    return undefined;
  }
  try {
    const out: unknown = JSON.parse(body.slice(span.start, span.end));
    return typeof out === "string" ? out : undefined;
  } catch {
    return undefined;
  }
}

export function stringField(body: string, object: Span, name: string): string | undefined {
  const span = field(body, object, name);
  return span === undefined ? undefined : stringValue(body, span);
}

/** Replaces one JSON value; every byte outside the span survives verbatim. */
export function replaceRaw(body: string, span: Span, replacement: string): string | undefined {
  if (span.start < 0 || span.end > body.length || span.start >= span.end) return undefined;
  if (!jsonValid(replacement)) return undefined;
  return body.slice(0, span.start) + replacement + body.slice(span.end);
}

/**
 * Inserts fields immediately before an object's closing brace. Existing bytes,
 * whitespace, key order, and escapes remain untouched. Callers must reject
 * existing decoded keys before calling this function.
 */
export function appendObjectFields(
  body: string,
  object: Span,
  ...fields: FieldInsertion[]
): string | undefined {
  if (object.start < 0 || object.end > body.length || object.start >= object.end ||
      body[object.start] !== "{" || body[object.end - 1] !== "}") {
    return undefined;
  }
  if (fields.length === 0) return body;
  let insertAt = object.end - 1;
  while (insertAt > object.start + 1 && SPACE.has(body[insertAt - 1]!)) insertAt--;
  const hasFields = insertAt > object.start + 1;
  let addition = hasFields ? "," : "";
  for (let i = 0; i < fields.length; i++) {
    const item = fields[i]!;
    if (item.name === "" || !jsonValid(item.value)) return undefined;
    if (i > 0) addition += ",";
    addition += `${JSON.stringify(item.name)}:${item.value}`;
  }
  return body.slice(0, insertAt) + addition + body.slice(insertAt);
}

function valueEnd(body: string, start: number): number | undefined {
  const i = space(body, start);
  if (i >= body.length) return undefined;
  if (body[i] === '"') return stringEnd(body, i);
  if (body[i] === "{" || body[i] === "[") {
    let depth = 0;
    for (let j = i; j < body.length; j++) {
      const char = body[j]!;
      if (char === '"') {
        const end = stringEnd(body, j);
        if (end === undefined) return undefined;
        j = end - 1;
      } else if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return undefined;
  }
  let j = i;
  while (j < body.length && !VALUE_TERMINATORS.has(body[j]!)) j++;
  return j > i ? j : undefined;
}

function stringEnd(body: string, start: number): number | undefined {
  if (start >= body.length || body[start] !== '"') return undefined;
  for (let i = start + 1; i < body.length; i++) {
    if (body[i] === "\\") i++;
    else if (body[i] === '"') return i + 1;
  }
  return undefined;
}

function space(body: string, i: number): number {
  while (i < body.length && SPACE.has(body[i]!)) i++;
  return i;
}
