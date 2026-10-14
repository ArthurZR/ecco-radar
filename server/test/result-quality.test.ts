import { describe, expect, it } from 'vitest';
import { assessResult, termsMatched, INSTITUTIONAL_CREATOR } from '../src/modules/exploration/quality.js';
import type { DiscoveredItem } from '../src/modules/references/types.js';

const item = (over: Partial<DiscoveredItem>): DiscoveredItem => ({
  sourceId: 'synthetic', sourceItemId: 'x', originalUrl: 'https://example.org/x', mediaType: 'image',
  previewUrl: 'https://example.org/x.jpg', tags: [], entities: [], researchSources: [], ...over,
});

describe('result quality gate (SYNTHETIC metadata)', () => {
  it('keeps a picture whose metadata names the topic', () => {
    expect(assessResult(item({ title: 'Translucent Y2K web interface mockup', tags: ['web design'] }), 'Y2K web interfaces')).toEqual({ keep: true });
  });
  it('sets aside congressional hearings that only mention the topic', () => {
    const v = assessResult(item({ title: 'Oversight of the year 2000 problem: the Y2K status of the Department of Health', description: 'web' }), 'Y2K web interfaces');
    expect(v).toEqual({ keep: false, reason: 'administrative' });
  });
  it('sets aside results with too few of the search words', () => {
    expect(assessResult(item({ title: "O'Sullivan's Heels, New York" }), 'Y2K web interfaces')).toEqual({ keep: false, reason: 'off_topic' });
    expect(assessResult(item({ title: 'A web of threads' }), 'Y2K web interfaces')).toEqual({ keep: false, reason: 'off_topic' });
  });
  it('sets aside video and items without an image', () => {
    expect(assessResult(item({ title: 'Y2K web interfaces', mediaType: 'video' }), 'Y2K web interfaces')).toEqual({ keep: false, reason: 'not_visual' });
    expect(assessResult(item({ title: 'Y2K web interfaces', previewUrl: undefined }), 'Y2K web interfaces')).toEqual({ keep: false, reason: 'no_preview' });
  });
  it('matches plural and singular forms', () => {
    expect(termsMatched(item({ title: 'interface' }), 'interfaces')).toBe(1);
  });
  it('recognises institutional creators so exploration does not follow them', () => {
    expect(INSTITUTIONAL_CREATOR.test('House Science, Space, and Technology Committee')).toBe(true);
    expect(INSTITUTIONAL_CREATOR.test('Irving Penn')).toBe(false);
  });
});
