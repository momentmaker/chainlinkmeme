import { describe, expect, it } from 'vitest';
import { cardNumber, dayLabel, displayTitle } from './stage';
import type { MemeEntry } from './manifest';

const meme = (over: Partial<MemeEntry>): MemeEntry => ({
  slug: 's', filename: 's.jpg', ext: 'jpg', title: '', tags: [], description: '', credit: '', source_url: '',
  submitted_by: '', date_added: '', nsfw: false, animated: false, width: 1, height: 1, ...over,
});

describe('stage helpers', () => {
  it('numbers the card from 1, padded like a collectible', () => {
    expect([cardNumber(0), cardNumber(1747), cardNumber(12344)]).toEqual(['No. 0001', 'No. 1748', 'No. 12345']);
  });

  it('labels the UTC day in lower case', () => {
    expect(dayLabel(new Date('2026-10-27T23:59:00Z'))).toBe('tue 27 oct');
    expect(dayLabel(new Date('2026-11-01T00:00:00Z'))).toBe('sun 1 nov');
  });

  it('never shows a hash filename as the title', () => {
    expect(displayTitle(meme({ title: 'More Burgers!' }))).toBe('More Burgers!');
    expect(displayTitle(meme({ title: '0036c94ab8b36fdcac3c94fe63a8609b', tags: ['sergey'] }))).toBe('#sergey');
    expect(displayTitle(meme({}))).toBe('meme of the day');
  });
});
