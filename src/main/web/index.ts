/**
 * Public surface for the web module.
 *
 * Re-exports the search + fetch primitives so consumers can import from
 * `@/main/web` without reaching into individual files.
 */

export { search } from './search';
export type {
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResult,
} from './search';

export { fetchUrl } from './fetch';
export type { FetchMode, FetchOptions, FetchResponse } from './fetch';
