import { describe, it, expect } from 'vitest';
import {
  formatAddress,
  hubspotToAddress,
  addressToHubspot,
  countryCodeToName,
  countryNameToCode,
  isAddressEmpty,
  adaptNewPlaceComponents,
  googleComponentsToAddress,
  type StructuredAddress,
  type NewPlaceAddressComponent,
} from '../address';

describe('formatAddress', () => {
  it('renders Western order: lines → locality → area → postal → country', () => {
    const addr: StructuredAddress = {
      addressLines: ['1 Main St', 'Flat 2'],
      locality: 'Springfield',
      administrativeArea: 'Illinois',
      postalCode: '62704',
      countryCode: 'US',
    };
    expect(formatAddress(addr)).toBe('1 Main St, Flat 2, Springfield, Illinois, 62704, United States');
  });

  it('omits the country name for the GB home market', () => {
    const addr: StructuredAddress = {
      addressLines: ['10 Downing Street'],
      locality: 'London',
      administrativeArea: 'Greater London',
      postalCode: 'SW1A 2AA',
      countryCode: 'GB',
    };
    expect(formatAddress(addr)).toBe('10 Downing Street, London, Greater London, SW1A 2AA');
  });

  it('honours a custom home country', () => {
    const addr: StructuredAddress = {
      addressLines: ['1 Main St'],
      locality: 'Springfield',
      postalCode: '62704',
      countryCode: 'US',
    };
    expect(formatAddress(addr, { homeCountry: 'US' })).toBe('1 Main St, Springfield, 62704');
  });

  it('renders Eastern order largest-unit-first for CN/JP/etc.', () => {
    const addr: StructuredAddress = {
      addressLines: ['Building A', 'Room 101'],
      locality: 'Shanghai',
      administrativeArea: 'Shanghai',
      postalCode: '200000',
      countryCode: 'CN',
    };
    expect(formatAddress(addr)).toBe('China, 200000, Shanghai, Shanghai, Building A, Room 101');
  });

  it('drops empty parts', () => {
    const addr: StructuredAddress = {
      addressLines: ['', '5 Elm Road'],
      locality: '',
      postalCode: 'AB1 2CD',
      countryCode: 'GB',
    };
    expect(formatAddress(addr)).toBe('5 Elm Road, AB1 2CD');
  });

  it('omits unknown country codes rather than printing a raw code', () => {
    const addr: StructuredAddress = {
      addressLines: ['Somewhere'],
      countryCode: 'ZZ',
    };
    expect(formatAddress(addr)).toBe('Somewhere');
  });

  it('returns an empty string for null/empty input', () => {
    expect(formatAddress(null)).toBe('');
    expect(formatAddress(undefined)).toBe('');
  });
});

describe('country lookups', () => {
  it('maps code → name and name → code', () => {
    expect(countryCodeToName('GB')).toBe('United Kingdom');
    expect(countryCodeToName('us')).toBe('United States');
    expect(countryNameToCode('United Kingdom')).toBe('GB');
    expect(countryNameToCode('united states')).toBe('US');
  });

  it('accepts an existing 2-letter code in countryNameToCode', () => {
    expect(countryNameToCode('GB')).toBe('GB');
  });

  it('returns undefined for unknown values', () => {
    expect(countryCodeToName('ZZ')).toBeUndefined();
    expect(countryNameToCode('Atlantis')).toBeUndefined();
  });
});

describe('hubspot round-trip', () => {
  it('hubspotToAddress splits newline address lines and resolves country name', () => {
    const addr = hubspotToAddress({
      address: '1 Main St\nFlat 2',
      city: 'London',
      state: 'Greater London',
      zip: 'SW1A 2AA',
      country: 'United Kingdom',
    });
    expect(addr).toEqual({
      addressLines: ['1 Main St', 'Flat 2'],
      locality: 'London',
      administrativeArea: 'Greater London',
      postalCode: 'SW1A 2AA',
      countryCode: 'GB',
    });
  });

  it('defaults to GB when country is absent or unknown', () => {
    expect(hubspotToAddress({ address: 'x' }).countryCode).toBe('GB');
    expect(hubspotToAddress({ country: 'Atlantis' }).countryCode).toBe('GB');
  });

  it('addressToHubspot newline-joins lines and expands the country code', () => {
    const props = addressToHubspot({
      addressLines: ['1 Main St', 'Flat 2'],
      locality: 'London',
      administrativeArea: 'Greater London',
      postalCode: 'SW1A 2AA',
      countryCode: 'GB',
    });
    expect(props).toEqual({
      address: '1 Main St\nFlat 2',
      city: 'London',
      state: 'Greater London',
      zip: 'SW1A 2AA',
      country: 'United Kingdom',
    });
  });

  it('round-trips HubSpot → structured → HubSpot losslessly', () => {
    const original = {
      address: '221B Baker Street\nApartment 1',
      city: 'London',
      state: 'Greater London',
      zip: 'NW1 6XE',
      country: 'United Kingdom',
    };
    expect(addressToHubspot(hubspotToAddress(original))).toEqual(original);
  });
});

describe('isAddressEmpty', () => {
  it('detects empty / blank addresses', () => {
    expect(isAddressEmpty(null)).toBe(true);
    expect(isAddressEmpty({ addressLines: [''], countryCode: 'GB' })).toBe(true);
    expect(isAddressEmpty({ addressLines: [], locality: '  ', countryCode: 'GB' })).toBe(true);
  });

  it('detects non-empty addresses', () => {
    expect(isAddressEmpty({ addressLines: ['x'], countryCode: 'GB' })).toBe(false);
    expect(isAddressEmpty({ addressLines: [], postalCode: 'AB1', countryCode: 'GB' })).toBe(false);
  });
});

describe('adaptNewPlaceComponents', () => {
  it('converts longText/shortText to long_name/short_name', () => {
    const input: NewPlaceAddressComponent[] = [
      { longText: 'Baker Street', shortText: 'Baker St', types: ['route'] },
      { longText: 'London', shortText: 'London', types: ['postal_town'] },
      { longText: 'United Kingdom', shortText: 'GB', types: ['country', 'political'] },
    ];
    const result = adaptNewPlaceComponents(input);
    expect(result).toEqual([
      { long_name: 'Baker Street', short_name: 'Baker St', types: ['route'] },
      { long_name: 'London', short_name: 'London', types: ['postal_town'] },
      { long_name: 'United Kingdom', short_name: 'GB', types: ['country', 'political'] },
    ]);
  });

  it('returns an empty array for null or undefined input', () => {
    expect(adaptNewPlaceComponents(null)).toEqual([]);
    expect(adaptNewPlaceComponents(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty components list', () => {
    expect(adaptNewPlaceComponents([])).toEqual([]);
  });

  it('falls back to empty strings when longText or shortText is missing', () => {
    const input = [
      { longText: '', shortText: '', types: ['street_number'] },
    ] as NewPlaceAddressComponent[];
    const [component] = adaptNewPlaceComponents(input);
    expect(component.long_name).toBe('');
    expect(component.short_name).toBe('');
  });

  it('preserves types arrays unchanged', () => {
    const types = ['administrative_area_level_1', 'political'];
    const [component] = adaptNewPlaceComponents([
      { longText: 'England', shortText: 'England', types },
    ]);
    expect(component.types).toEqual(types);
  });

  describe('round-trip with googleComponentsToAddress', () => {
    it('produces the same StructuredAddress as the legacy shape would', () => {
      const newComponents: NewPlaceAddressComponent[] = [
        { longText: '221B', shortText: '221B', types: ['street_number'] },
        { longText: 'Baker Street', shortText: 'Baker St', types: ['route'] },
        { longText: 'London', shortText: 'London', types: ['postal_town'] },
        { longText: 'Greater London', shortText: 'Greater London', types: ['administrative_area_level_2', 'political'] },
        { longText: 'NW1 6XE', shortText: 'NW1 6XE', types: ['postal_code'] },
        { longText: 'United Kingdom', shortText: 'GB', types: ['country', 'political'] },
      ];
      const addr = googleComponentsToAddress(adaptNewPlaceComponents(newComponents));
      expect(addr.addressLines).toEqual(['221B Baker Street']);
      expect(addr.locality).toBe('London');
      expect(addr.administrativeArea).toBe('Greater London');
      expect(addr.postalCode).toBe('NW1 6XE');
      expect(addr.countryCode).toBe('GB');
    });
  });
});
