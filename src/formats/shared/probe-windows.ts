/**
 * The first and the largest head and tail windows of a probe of a large input; a short window is
 * read again four times as large, and an input under two first windows is read whole. The readers
 * take them when they probe; only tests change them, to describe inputs of a few megabytes from
 * their ends as these describe inputs of hundreds.
 */
export const PROBE_WINDOWS = { first: 2 * 1024 * 1024, last: 32 * 1024 * 1024 };
