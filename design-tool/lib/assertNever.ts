// Compile-time exhaustiveness backstop (slice 46). Used as the default arm
// of switches over closed unions (item types, scoring methods): when the
// union grows and a switch misses the new member, `tsc` fails HERE instead
// of the value silently falling into a catch-all. At runtime (version skew,
// forged rows, `as` casts) it throws with the offending value.
export function assertNever(value: never, label: string): never {
  throw new Error(`${label}: unhandled variant ${JSON.stringify(value)}`);
}
