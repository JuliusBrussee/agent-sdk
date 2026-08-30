import { types as utilTypes } from "node:util";

/**
 * Snapshot one exact plain data object without ever reading caller properties
 * after validation. Accessors, symbols, custom prototypes, and extra fields are
 * rejected. Returned object has a null prototype.
 */
export function snapshotDataRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  invalid: () => never,
): Readonly<Record<string, unknown>> {
  const { descriptors, keys } = plainDataDescriptors(value, allowed.length, invalid);
  if (keys.some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key))) {
    invalid();
  }
  return snapshotDescriptors(descriptors, keys, invalid);
}

/** Snapshot a plain string-keyed data dictionary with caller-defined size. */
export function snapshotDataDictionary(
  value: unknown,
  maximumKeys: number,
  invalid: () => never,
): Readonly<Record<string, unknown>> {
  if (!Number.isSafeInteger(maximumKeys) || maximumKeys < 0) invalid();
  const { descriptors, keys } = plainDataDescriptors(value, maximumKeys, invalid);
  return snapshotDescriptors(descriptors, keys, invalid);
}

function snapshotDescriptors(
  descriptors: DescriptorMap,
  keys: readonly string[],
  invalid: () => never,
): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      invalid();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function plainDataDescriptors(
  value: unknown,
  maximumKeys: number,
  invalid: () => never,
): { descriptors: DescriptorMap; keys: readonly string[] } {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
      Array.isArray(value)) invalid();
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    // Own-key enumeration is unavoidable for an in-memory object. Bound it
    // immediately, before allocating or inspecting one descriptor per key.
    keys = Reflect.ownKeys(value);
  } catch {
    invalid();
  }
  if ((prototype! !== Object.prototype && prototype! !== null) ||
      keys!.length > maximumKeys || keys!.some((key) => typeof key !== "string")) {
    invalid();
  }
  const stringKeys = keys! as readonly string[];
  return {
    descriptors: captureDescriptors(value, stringKeys, invalid),
    keys: stringKeys,
  };
}

type DescriptorMap = Readonly<Record<PropertyKey, PropertyDescriptor>>;

function captureDescriptors(
  value: object,
  keys: readonly string[],
  invalid: () => never,
): DescriptorMap {
  const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.create(null) as
    Record<PropertyKey, PropertyDescriptor>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      invalid();
    }
    if (descriptor === undefined) invalid();
    descriptors[key] = descriptor;
  }
  return descriptors;
}

/** Snapshot a dense, ordinary data array without invoking instance methods. */
export function snapshotDenseArray(
  value: unknown,
  maximumLength: number,
  invalid: () => never,
): readonly unknown[] {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 0) invalid();
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
      !Array.isArray(value)) invalid();
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    // Read fixed `length` first. Oversized dense arrays fail before their
    // potentially huge descriptor set is materialized.
    lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  } catch {
    invalid();
  }
  if (prototype! !== Array.prototype && prototype! !== null) invalid();
  if (lengthDescriptor === undefined || lengthDescriptor.enumerable ||
      !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 || lengthDescriptor.value > maximumLength) {
    invalid();
  }
  const length = lengthDescriptor.value as number;
  let keys: readonly PropertyKey[];
  try {
    // Enumeration itself cannot be pre-bounded for an arbitrary in-memory
    // object. Descriptor work is bounded immediately after this one step.
    keys = Reflect.ownKeys(value);
  } catch {
    invalid();
  }
  if (keys!.length !== length + 1 || keys!.some((key) => typeof key !== "string" ||
      (key !== "length" && !isCanonicalIndex(key, length)))) {
    invalid();
  }
  const descriptors = captureDescriptors(
    value,
    (keys! as readonly string[]).filter((key) => key !== "length"),
    invalid,
  );
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      invalid();
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function isCanonicalIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
