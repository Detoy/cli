import { describe, it, expect } from 'vitest';
import {
  availableRegionIds,
  dashHostForIngestHost,
  ingestHostForRegionId,
  resolveIngestHost,
} from './regions.js';

describe('cli regions', () => {
  it('lists only available regions', () => {
    expect(availableRegionIds()).toEqual(['us', 'eu']);
  });

  it('resolves available region hosts (case-insensitive)', () => {
    expect(resolveIngestHost('us')).toBe('us.ingest.vibgrate.com');
    expect(resolveIngestHost('EU')).toBe('eu.ingest.vibgrate.com');
    expect(resolveIngestHost()).toBe('us.ingest.vibgrate.com');
  });

  it('rejects unknown regions', () => {
    expect(() => resolveIngestHost('ap')).toThrow('Unknown region');
  });

  it('rejects known-but-unavailable regions with a clear message', () => {
    expect(() => resolveIngestHost('apac')).toThrow('not yet available');
  });

  it('honors an explicit ingest URL override', () => {
    expect(resolveIngestHost('eu', 'https://custom.example.com')).toBe('custom.example.com');
  });

  it('keeps only the host when a valid ingest URL carries userinfo', () => {
    const secret = 's3cret-token';
    expect(resolveIngestHost(undefined, `https://ci:${secret}@custom.example.com:8443/ignored`)).toBe(
      'custom.example.com:8443',
    );
  });

  it('does not echo userinfo or credential query parameters from a rejected ingest URL', () => {
    const secret = 's3cret-token';
    expect(() => resolveIngestHost(undefined, `https://ci:${secret}@bad host`)).toThrow(
      'Invalid ingest URL: https://bad host',
    );
    expect(() => resolveIngestHost(undefined, `https://ci:sec@ret@bad host`)).toThrow(
      'Invalid ingest URL: https://bad host',
    );
    let queryMessage = '';
    try {
      resolveIngestHost(undefined, `https://bad host/v1?token=${secret}&region=eu`);
    } catch (err) {
      queryMessage = err instanceof Error ? err.message : String(err);
    }
    expect(queryMessage).toBe('Invalid ingest URL: https://bad host/v1?region=eu');
    expect(queryMessage).not.toContain(secret);

    let plain = '';
    try {
      resolveIngestHost(undefined, 'not-a-url');
    } catch (err) {
      plain = err instanceof Error ? err.message : String(err);
    }
    expect(plain).toBe('Invalid ingest URL: not-a-url');
  });

  it('maps ingest host to the matching dashboard host', () => {
    expect(dashHostForIngestHost('eu.ingest.vibgrate.com')).toBe('dash.vibgrate.eu');
    expect(dashHostForIngestHost('us.ingest.vibgrate.com')).toBe('dash.vibgrate.com');
    expect(dashHostForIngestHost('unknown.example.com')).toBe('dash.vibgrate.com');
  });

  it('resolves an ingest host for a known region id without throwing', () => {
    expect(ingestHostForRegionId('eu')).toBe('eu.ingest.vibgrate.com');
    expect(ingestHostForRegionId('US')).toBe('us.ingest.vibgrate.com');
    // Honours a residency redirect even for a region not yet user-selectable.
    expect(ingestHostForRegionId('apac')).toBe('apac.ingest.vibgrate.com');
    expect(ingestHostForRegionId('mars')).toBeUndefined();
  });
});
