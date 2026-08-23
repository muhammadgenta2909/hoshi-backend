import { illustrationCategoryFromCard } from './cc-card-facts';

describe('illustrationCategoryFromCard', () => {
  const cat = (itemName: string, set = '') =>
    illustrationCategoryFromCard({ itemName, set });

  it('maps a "Special Illustration Rare" name to "Special Illustration"', () => {
    expect(cat('Charizard ex Special Illustration Rare')).toBe(
      'Special Illustration',
    );
  });

  it('returns "" for a plain card name with no illustration type', () => {
    expect(cat('Charizard')).toBe('');
  });

  it('maps a "... Promo" name to "PROMO CARD"', () => {
    expect(cat('Pikachu Promo')).toBe('PROMO CARD');
  });

  it('prefers the more specific "Character Illustration" over generic matches', () => {
    // Contains "illustration" but the specific multi-word type must win.
    expect(cat('Pikachu Character Illustration Rare')).toBe(
      'Character Illustration',
    );
  });

  it('matches the uppercase "SIR" abbreviation but not the word "sir"', () => {
    expect(cat('Mew ex SIR')).toBe('Special Illustration');
    expect(cat('The Great Sir Aaron')).toBe('');
  });

  it('does not match the ambiguous "SR" abbreviation', () => {
    expect(cat('Gardevoir ex SR')).toBe('');
  });

  it('falls back to scanning the set field', () => {
    expect(cat('Umbreon', 'Rainbow Rare Collection')).toBe('Rainbow');
  });
});
