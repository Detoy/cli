// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Honest npm "latest stable" selection and version-lag classification.
 *
 * Mirrored verbatim in:
 * - packages/vibgrate-cli-public/src/core-open/scanners/npm-latest.ts (vendored CLI)
 * - packages/vibgrate-api/src/lib/drift-scan/npm-latest.ts (Worker / GitHub App)
 *
 * `dist-tags.latest` is what `npm install <pkg>` resolves. The highest version
 * number in the registry is not that release: packages publish sentinel
 * versions (react-native `1000.0.0` is an accidental publish, marked
 * deprecated) that sort above every real release. Taking max semver makes
 * that sentinel "latest" and invents a major-versions-behind count.
 *
 * Keep the three copies in sync. Parity is pinned by
 * `packages/vibgrate-api/src/lib/drift-scan/npm-latest.parity.test.ts`.
 */
import * as semver from 'semver';

/**
 * A major at or above this, while the rest of the stable line sits below it,
 * is a canary/placeholder (react-native 1000.0.0), not a release.
 * Calendar versions (2026.1.0) stay: their whole line lives at that height.
 */
export const PLACEHOLDER_MAJOR_THRESHOLD = 900;

/**
 * A major distance above this is a version-scheme change, not a count of
 * breaking majors (an Expo-style jump that reads as 40–57 behind). Do not
 * report it as lag.
 */
export const ABSURD_MAJOR_JUMP = 20;

export interface LatestStableSelection {
  /** Honest latest stable, or null when none can be determined. */
  latestStable: string | null;
  /** Stables safe for range resolution. Placeholder versions are removed. */
  stableVersions: string[];
  /** Published versions rejected as placeholders/sentinels. */
  placeholders: string[];
}

function isStable(version: string): boolean {
  return Boolean(semver.valid(version) && semver.prerelease(version) === null);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * True when `version` is a sentinel relative to the other stable releases.
 * A version with no peers is not a sentinel: there is no line to contradict it.
 */
export function isPlaceholderVersion(
  version: string,
  stables: readonly string[],
  deprecated?: ReadonlySet<string>,
): boolean {
  if (!isStable(version)) return false;
  const others = stables.filter((v) => v !== version && isStable(v));
  if (others.length === 0) return false;

  const major = semver.major(version);
  const lineMedian = median(others.map((v) => semver.major(v)));
  if (lineMedian != null && major >= PLACEHOLDER_MAJOR_THRESHOLD && lineMedian < PLACEHOLDER_MAJOR_THRESHOLD) {
    return true;
  }

  if (deprecated?.has(version)) {
    const real = others.filter((v) => !deprecated.has(v));
    if (real.length > 0) {
      const maxReal = Math.max(...real.map((v) => semver.major(v)));
      if (major - maxReal > ABSURD_MAJOR_JUMP) return true;
    }
  }
  return false;
}

function maxStable(versions: readonly string[]): string | null {
  if (versions.length === 0) return null;
  return [...versions].sort(semver.rcompare)[0] ?? null;
}

/** Deprecated version strings from a registry `versions` object (packument shape). */
export function collectDeprecatedVersions(versionsField: unknown): string[] {
  if (!versionsField || typeof versionsField !== 'object' || Array.isArray(versionsField)) return [];
  const out: string[] = [];
  for (const [ver, meta] of Object.entries(versionsField as Record<string, unknown>)) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const note = (meta as Record<string, unknown>).deprecated;
    if (typeof note === 'string' && note.trim()) out.push(ver);
  }
  return out;
}

/**
 * Choose the latest stable release.
 *
 * Prefer `dist-tags.latest` when it is a stable, non-placeholder version.
 * Otherwise use the highest stable that is not a placeholder. A prerelease
 * tag (npm `next`) does not become latest stable. When nothing honest
 * remains, latest is null.
 */
export function selectLatestStable(input: {
  distTagLatest: string | null;
  versions: readonly string[];
  deprecated?: readonly string[];
}): LatestStableSelection {
  const deprecated = new Set(input.deprecated ?? []);
  const seen = new Set<string>();
  const stables: string[] = [];
  for (const raw of input.versions) {
    if (!raw || seen.has(raw) || !isStable(raw)) continue;
    seen.add(raw);
    stables.push(raw);
  }

  const placeholders = new Set<string>();
  for (const version of stables) {
    if (isPlaceholderVersion(version, stables, deprecated)) placeholders.add(version);
  }

  const tag = input.distTagLatest?.trim() ? input.distTagLatest.trim() : null;
  if (tag && isStable(tag) && isPlaceholderVersion(tag, stables, deprecated)) placeholders.add(tag);

  // Flagging every stable means we cannot tell the line from the outliers.
  if (stables.length > 0 && stables.every((version) => placeholders.has(version))) placeholders.clear();

  const real: string[] = [];
  for (const version of stables) {
    if (!placeholders.has(version)) real.push(version);
  }

  let latestStable: string | null = null;
  if (tag && isStable(tag) && !placeholders.has(tag)) {
    latestStable = tag;
    if (!real.includes(tag)) real.push(tag);
  } else {
    latestStable = maxStable(real);
  }

  return { latestStable, stableVersions: real, placeholders: [...placeholders] };
}

/**
 * Fields both registry parsers store on `NpmMeta`.
 * `latest` keeps a non-placeholder dist-tag (including a prerelease tag).
 * A placeholder tag is dropped so it cannot be read as the current release.
 */
export function resolveNpmMetaVersions(input: {
  distTagLatest: string | null;
  versions: readonly string[];
  deprecated?: readonly string[];
}): { latest: string | null; stableVersions: string[]; latestStableOverall: string | null } {
  const selected = selectLatestStable(input);
  const tag = input.distTagLatest?.trim() ? input.distTagLatest.trim() : null;
  const tagRejected = tag != null && selected.placeholders.includes(tag);
  const latest = tag && !tagRejected ? tag : selected.latestStable;
  return {
    latest,
    stableVersions: selected.stableVersions,
    latestStableOverall: selected.latestStable,
  };
}

export interface NpmVersionLag {
  drift: 'current' | 'minor-behind' | 'major-behind' | 'unknown';
  majorsBehind: number | null;
  /**
   * Latest safe to show. Null when the candidate was a placeholder compared
   * with the resolved version, or when no latest was supplied.
   */
  reportedLatest: string | null;
  bucket: 'current' | 'oneBehind' | 'twoPlusBehind' | 'unknown';
}

/**
 * Compare an installed version with the selected latest.
 * Placeholder pairs and absurd major jumps are `unknown` — no lag count,
 * no severity, no finding. Minor lag stays in the `current` bucket, matching
 * the historical scanner (only a major boundary moves the bucket).
 */
export function classifyNpmVersionLag(
  resolvedVersion: string | null,
  latestStable: string | null,
): NpmVersionLag {
  const unknown = (reportedLatest: string | null): NpmVersionLag => ({
    drift: 'unknown',
    majorsBehind: null,
    reportedLatest,
    bucket: 'unknown',
  });

  const latestOk = Boolean(latestStable && semver.valid(latestStable));
  if (!resolvedVersion || !semver.valid(resolvedVersion)) {
    return unknown(latestOk ? latestStable : null);
  }
  if (!latestOk || !latestStable) return unknown(null);

  const resolvedMajor = semver.major(resolvedVersion);
  const latestMajor = semver.major(latestStable);
  const crossesPlaceholderLine =
    (latestMajor >= PLACEHOLDER_MAJOR_THRESHOLD && resolvedMajor < PLACEHOLDER_MAJOR_THRESHOLD) ||
    (resolvedMajor >= PLACEHOLDER_MAJOR_THRESHOLD && latestMajor < PLACEHOLDER_MAJOR_THRESHOLD);
  if (crossesPlaceholderLine) return unknown(null);

  const majorsBehind = latestMajor - resolvedMajor;
  if (majorsBehind < 0 || majorsBehind > ABSURD_MAJOR_JUMP) {
    // The latest itself may be real; the distance is not a count of majors.
    return unknown(latestStable);
  }
  if (majorsBehind === 0) {
    const drift = semver.eq(resolvedVersion, latestStable) ? 'current' : 'minor-behind';
    return { drift, majorsBehind: 0, reportedLatest: latestStable, bucket: 'current' };
  }
  if (majorsBehind === 1) {
    return { drift: 'major-behind', majorsBehind, reportedLatest: latestStable, bucket: 'oneBehind' };
  }
  return { drift: 'major-behind', majorsBehind, reportedLatest: latestStable, bucket: 'twoPlusBehind' };
}
