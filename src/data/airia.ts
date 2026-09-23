/**
 * The data layer, in one import for the dashboard.
 *
 * It is three jobs, and they used to be one 860-line file:
 *
 *   live.ts    fetching, the raw-row cache, the background backfill
 *   window.ts  which instants we are looking at, and the zone rules
 *   fold.ts    turning the fact table into series and breakdowns
 *
 * `App.tsx` imports from here so moving something between them is not a
 * change to the dashboard.
 */

export * from './live'
export * from './window'
export * from './fold'
