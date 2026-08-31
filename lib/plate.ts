/**
 * Plate helpers — parsing and presentation only.
 *
 * These decide nothing. There is deliberately no copy of the plate format
 * regex here: that rule lives in the `claims_plate_check` constraint, and a
 * second copy in TypeScript would be a second rule, free to drift from the
 * one the database actually enforces.
 *
 * All this does is find the number a plate is claiming, so there is something
 * to insert. The database then judges the plate itself.
 */

export function normalisePlate(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '')
}

/**
 * The plate's own last three digits, which is the number it claims.
 *
 * Null only when those three characters are not digits at all — in that case
 * there is genuinely no row to insert, so the request cannot reach the
 * database. Everything else, including a badly shaped plate like `ABC0002`,
 * returns a number and gets refused by the check constraint, in the
 * constraint's own words.
 */
export function trailingNumber(plate: string): number | null {
  const last3 = plate.slice(-3)
  if (!/^[0-9]{3}$/.test(last3)) return null
  return Number.parseInt(last3, 10)
}

export function formatTarget(n: number): string {
  return n.toString().padStart(3, '0')
}
