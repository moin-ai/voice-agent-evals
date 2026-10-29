/**
 * Canonical 8-4-4-4-12 uuid form, not just "36 characters of hex digits and
 * hyphens" — that looser class also accepts 36 hex digits with no hyphens at
 * all, which is not a valid Postgres uuid literal. An id shaped like that
 * used to reach a query, fail at the cast layer, and 500 instead of the clean
 * 404 every other malformed id gets — worst on a public, unauthenticated
 * route, where that 500 is served to anyone on the internet.
 *
 * One check, shared by every route that takes an id or token from the
 * caller: busy blocks, the public calendar feed, and job actions.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
