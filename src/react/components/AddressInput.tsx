import React, { useCallback, useEffect, useRef, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import FormHelperText from '@mui/material/FormHelperText';
import InputAdornment from '@mui/material/InputAdornment';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import SearchIcon from '@mui/icons-material/Search';
import {
  HOME_COUNTRY_CODE,
  adaptNewPlaceComponents,
  emptyAddress,
  googleComponentsToAddress,
  isAddressEmpty,
  type NewPlaceAddressComponent,
  type StructuredAddress,
} from '../../../shared/address';
import {
  loadGoogleMapsConfig,
  loadPlacesScript,
  isAutocompleteEnabled,
  reportGoogleMapsUsage,
  type GoogleMapsConfig,
  type GoogleMapsSurface,
} from '../lib/googleMapsConfig';

/**
 * Per-country labels for the locality / administrative-area / postal fields.
 * Falls back to the generic set for any country not explicitly listed so the
 * form always shows sensible wording.
 */
interface AddressLabels {
  locality: string;
  administrativeArea: string;
  postalCode: string;
}

const LABELS_BY_COUNTRY: Record<string, AddressLabels> = {
  GB: { locality: 'Town / City', administrativeArea: 'County', postalCode: 'Postcode' },
  US: { locality: 'City', administrativeArea: 'State', postalCode: 'ZIP code' },
};

const DEFAULT_LABELS: AddressLabels = {
  locality: 'City',
  administrativeArea: 'State / Province / Region',
  postalCode: 'Postal code',
};

function labelsFor(countryCode: string): AddressLabels {
  return LABELS_BY_COUNTRY[(countryCode || '').toUpperCase()] || DEFAULT_LABELS;
}

interface NewPlaceResult {
  fetchFields(opts: { fields: string[]; sessionToken?: unknown }): Promise<void>;
  addressComponents?: NewPlaceAddressComponent[];
}

interface PlacePredictionRaw {
  placeId: string;
  text?: { text: string };
  toPlace(): NewPlaceResult;
}

interface PlacePrediction {
  placeId: string;
  description: string;
  _raw: PlacePredictionRaw;
}

export interface AddressInputProps {
  /** The controlled structured-address value. */
  value: StructuredAddress;
  /** Called with the next value on every edit. */
  onChange: (next: StructuredAddress) => void;
  /** When true, the first address line, locality and postcode show as required. */
  required?: boolean;
  /** Disable every field (e.g. while submitting). */
  disabled?: boolean;
  /** Optional id prefix so multiple inputs on a page keep unique labels. */
  idPrefix?: string;
  /**
   * Which surface this input lives on. When provided and Google Places
   * autocomplete is enabled (master switch + this surface), a search box is
   * shown above the fields. Omit to disable autocomplete entirely.
   */
  surface?: GoogleMapsSurface;
  /**
   * When true, the component starts in a postcode-first search mode: only a
   * postcode / address search field is shown, and the full address fields
   * appear after the user selects a suggestion or clicks "Enter address
   * manually". Requires `surface` to be set; degrades silently to the normal
   * manual-entry layout when autocomplete is unavailable.
   */
  postcodeFirst?: boolean;
}

/**
 * Structured address entry with always-visible Address line 1 and Address
 * line 2 fields, plus locality, administrative area and postal code.
 * Country is always GB (United Kingdom). Field labels use UK terminology
 * (Town / City, County, Postcode). Fully controlled — the parent owns the value.
 *
 * When a `surface` is supplied and Google Places autocomplete is enabled at
 * runtime, a search box is rendered above the manual fields. Selecting a
 * prediction fills every field. The component degrades silently to manual
 * entry when the feature is off, the API key is missing, or the Places library
 * fails to load.
 *
 * When `postcodeFirst` is also set, the component starts in a postcode-search
 * mode: only the search input is shown. The full address fields appear after
 * the customer selects a suggestion or clicks "Enter address manually".
 */
export function AddressInput({
  value,
  onChange,
  required = false,
  disabled = false,
  idPrefix = 'address',
  surface,
  postcodeFirst = false,
}: AddressInputProps) {
  // Normalise the incoming value so there are always exactly two address lines.
  const rawLines = value?.addressLines ?? [];
  const line0 = rawLines[0] ?? '';
  const line1 = rawLines[1] ?? '';
  const addr: StructuredAddress = {
    addressLines: [line0, line1],
    locality: value?.locality ?? '',
    administrativeArea: value?.administrativeArea ?? '',
    postalCode: value?.postalCode ?? '',
    countryCode: value?.countryCode || HOME_COUNTRY_CODE,
  };
  const labels = labelsFor(addr.countryCode);

  const emit = useCallback(
    (patch: Partial<StructuredAddress>) => {
      onChange({ ...addr, ...patch });
    },
    [addr, onChange],
  );

  const updateLine = useCallback(
    (index: number, text: string) => {
      const lines = [...addr.addressLines];
      lines[index] = text;
      emit({ addressLines: lines });
    },
    [addr.addressLines, emit],
  );

  // ── postcode-first mode: manual-entry toggle ───────────────────────────────
  // Start in manual mode when the address already has content (e.g. restored
  // from a draft), so the user immediately sees their saved values.
  const [manualMode, setManualMode] = useState<boolean>(() =>
    postcodeFirst ? !isAddressEmpty(value) : true,
  );

  // ── Google Places autocomplete (optional) ──────────────────────────────────
  const [cfg, setCfg] = useState<GoogleMapsConfig | null>(null);
  const [acReady, setAcReady] = useState(false);
  const [acFailed, setAcFailed] = useState(false);
  const [options, setOptions] = useState<PlacePrediction[]>([]);
  const [inputText, setInputText] = useState('');
  const [loadingPredictions, setLoadingPredictions] = useState(false);

  const sessionTokenRef = useRef<unknown>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!surface) return;
    let cancelled = false;
    loadGoogleMapsConfig().then((c) => {
      if (cancelled) return;
      setCfg(c);
      if (!isAutocompleteEnabled(c, surface) || !c.apiKey) return;
      loadPlacesScript(c.apiKey, c.autocomplete.language)
        .then(() => {
          if (cancelled) return;
          const g = (window as any).google;
          if (!g?.maps?.places?.AutocompleteSuggestion) {
            setAcFailed(true);
            return;
          }
          setAcReady(true);
        })
        .catch(() => {
          if (!cancelled) setAcFailed(true);
        });
    });
    return () => {
      cancelled = true;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [surface]);

  const newSessionToken = useCallback(() => {
    const g = (window as any).google;
    if (g?.maps?.places?.AutocompleteSessionToken && cfg?.autocomplete.sessionTokens) {
      sessionTokenRef.current = new g.maps.places.AutocompleteSessionToken();
    } else {
      sessionTokenRef.current = null;
    }
    return sessionTokenRef.current;
  }, [cfg]);

  const fetchPredictions = useCallback(
    (text: string) => {
      if (!cfg || !acReady) return;
      const minChars = cfg.autocomplete.minChars;
      if (text.trim().length < minChars) {
        setOptions([]);
        return;
      }
      if (!sessionTokenRef.current) newSessionToken();
      setLoadingPredictions(true);

      const g = (window as any).google;
      const countries = cfg.autocomplete.countries
        .map((c: string) => c.toLowerCase())
        .slice(0, 5);
      const request: Record<string, unknown> = {
        input: text,
        language: cfg.autocomplete.language,
      };
      if (countries.length) request.includedRegionCodes = countries;
      if (sessionTokenRef.current) request.sessionToken = sessionTokenRef.current;

      (
        g.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(
          request,
        ) as Promise<{ suggestions: Array<{ placePrediction?: PlacePredictionRaw }> }>
      )
        .then((result) => {
          setLoadingPredictions(false);
          const suggestions = result?.suggestions ?? [];
          if (surface) reportGoogleMapsUsage('autocomplete', surface, true);
          setOptions(
            suggestions
              .filter((s): s is { placePrediction: PlacePredictionRaw } => !!s?.placePrediction)
              .map((s) => ({
                placeId: s.placePrediction.placeId,
                description: s.placePrediction.text?.text ?? s.placePrediction.placeId,
                _raw: s.placePrediction,
              })),
          );
        })
        .catch((err: unknown) => {
          setLoadingPredictions(false);
          const code = String((err as { message?: string })?.message ?? err ?? 'ERROR');
          if (surface) reportGoogleMapsUsage('autocomplete', surface, false, code);
        });
    },
    [cfg, acReady, newSessionToken, surface],
  );

  const handleInputChange = useCallback(
    (text: string) => {
      setInputText(text);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      const delay = cfg?.autocomplete.debounceMs ?? 300;
      debounceRef.current = window.setTimeout(() => fetchPredictions(text), delay);
    },
    [cfg, fetchPredictions],
  );

  const handleSelect = useCallback(
    (prediction: PlacePrediction | null) => {
      if (!prediction) return;
      const rawPrediction = prediction._raw;
      if (!rawPrediction) return;
      const place = rawPrediction.toPlace();
      const sessionToken = sessionTokenRef.current;
      // A details request always ends the billing session token.
      sessionTokenRef.current = null;
      place
        .fetchFields({
          fields: ['addressComponents'],
          ...(sessionToken ? { sessionToken } : {}),
        })
        .then(() => {
          const ok = Array.isArray(place.addressComponents);
          if (surface) reportGoogleMapsUsage('details', surface, ok);
          if (!ok) return;
          const next = googleComponentsToAddress(adaptNewPlaceComponents(place.addressComponents));
          onChange(next);
          setInputText('');
          setOptions([]);
          // In postcode-first mode, reveal the address fields after selection
          // so the customer can review and edit what was filled in.
          if (postcodeFirst) setManualMode(true);
        })
        .catch((err: unknown) => {
          const code = String((err as { message?: string })?.message ?? err ?? 'ERROR');
          if (surface) reportGoogleMapsUsage('details', surface, false, code);
        });
    },
    [onChange, surface, postcodeFirst],
  );

  // showAutocomplete: the Places library loaded successfully for this surface.
  const showAutocomplete = !!surface && acReady && !acFailed;

  // showNotice: the feature is enabled but the library failed — show a notice.
  const showNotice =
    !!surface &&
    !!cfg &&
    isAutocompleteEnabled(cfg, surface) &&
    acFailed &&
    cfg.fallback.mode === 'notice';

  // In postcode-first mode: show the search field when autocomplete is
  // available and the user has not yet entered manual mode.
  const showPostcodeSearch = postcodeFirst && showAutocomplete && !manualMode;

  // Show the full address fields when:
  //   • not in postcode-first mode (staff surfaces always show fields), or
  //   • postcode-first but user has clicked "Enter manually" / selected, or
  //   • postcode-first but autocomplete is unavailable (graceful degradation).
  const showFields = !postcodeFirst || manualMode || !showAutocomplete;

  const minChars = cfg?.autocomplete.minChars ?? 3;

  return (
    <Box>
      {/* ── Postcode-first: search input ──────────────────────────────────── */}
      {showPostcodeSearch && (
        <Box>
          <Autocomplete<PlacePrediction, false, false, true>
            freeSolo
            disabled={disabled}
            filterOptions={(x) => x}
            options={options}
            loading={loadingPredictions}
            inputValue={inputText}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.description)}
            onInputChange={(_e, v, reason) => {
              if (reason === 'input') handleInputChange(v);
              else if (reason === 'clear') {
                setInputText('');
                setOptions([]);
              }
            }}
            onChange={(_e, v) => {
              if (v && typeof v !== 'string') handleSelect(v);
            }}
            noOptionsText={
              inputText.trim().length < minChars ? 'Keep typing…' : 'No matches'
            }
            renderInput={(params) => {
              const inputProps =
                (params as unknown as { InputProps: Record<string, unknown> }).InputProps || {};
              return (
                <TextField
                  {...params}
                  label="Enter your postcode or address"
                  placeholder="e.g. SW1A 1AA"
                  size="small"
                  fullWidth
                  sx={{ mb: 1 }}
                  slotProps={{
                    input: {
                      ...inputProps,
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" color="action" />
                        </InputAdornment>
                      ),
                      endAdornment: (
                        <>
                          {loadingPredictions ? (
                            <CircularProgress color="inherit" size={16} />
                          ) : null}
                          {inputProps.endAdornment as React.ReactNode}
                        </>
                      ),
                    },
                  }}
                />
              );
            }}
          />
          <Link
            component="button"
            type="button"
            variant="caption"
            onClick={() => setManualMode(true)}
            sx={{ display: 'block', mb: 1.5, cursor: 'pointer', textAlign: 'left' }}
          >
            Enter address manually
          </Link>
        </Box>
      )}

      {/* ── Standard search box (staff surfaces, non-postcodeFirst) ───────── */}
      {showAutocomplete && !postcodeFirst && (
        <Autocomplete<PlacePrediction, false, false, true>
          freeSolo
          disabled={disabled}
          filterOptions={(x) => x}
          options={options}
          loading={loadingPredictions}
          inputValue={inputText}
          getOptionLabel={(o) => (typeof o === 'string' ? o : o.description)}
          onInputChange={(_e, v, reason) => {
            if (reason === 'input') handleInputChange(v);
            else if (reason === 'clear') {
              setInputText('');
              setOptions([]);
            }
          }}
          onChange={(_e, v) => {
            if (v && typeof v !== 'string') handleSelect(v);
          }}
          noOptionsText={
            inputText.trim().length < minChars ? 'Keep typing…' : 'No matches'
          }
          renderInput={(params) => {
            const inputProps =
              (params as unknown as { InputProps: Record<string, unknown> }).InputProps || {};
            return (
              <TextField
                {...params}
                label="Search for an address"
                placeholder="Start typing an address…"
                size="small"
                fullWidth
                sx={{ mb: 1.5 }}
                slotProps={{
                  input: {
                    ...inputProps,
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" color="action" />
                      </InputAdornment>
                    ),
                    endAdornment: (
                      <>
                        {loadingPredictions ? (
                          <CircularProgress color="inherit" size={16} />
                        ) : null}
                        {inputProps.endAdornment as React.ReactNode}
                      </>
                    ),
                  },
                }}
              />
            );
          }}
        />
      )}

      {showNotice && (
        <FormHelperText sx={{ mb: 1 }}>
          Address search is unavailable right now — please enter the address manually.
        </FormHelperText>
      )}

      {/* ── Manual address fields ──────────────────────────────────────────── */}
      {showFields && (
        <>
          <TextField
            id={`${idPrefix}-line0`}
            label="Address line 1"
            size="small"
            fullWidth
            required={required}
            disabled={disabled}
            placeholder="e.g. 12 Baker Street"
            slotProps={{ htmlInput: { maxLength: 200 } }}
            value={addr.addressLines[0]}
            onChange={(e) => updateLine(0, e.target.value)}
            sx={{ mb: 1 }}
          />

          <TextField
            id={`${idPrefix}-line1`}
            label="Address line 2"
            size="small"
            fullWidth
            disabled={disabled}
            slotProps={{ htmlInput: { maxLength: 200 } }}
            value={addr.addressLines[1]}
            onChange={(e) => updateLine(1, e.target.value)}
            sx={{ mb: 1 }}
          />

          <TextField
            id={`${idPrefix}-locality`}
            label={labels.locality}
            size="small"
            fullWidth
            required={required}
            disabled={disabled}
            slotProps={{ htmlInput: { maxLength: 120 } }}
            value={addr.locality}
            onChange={(e) => emit({ locality: e.target.value })}
            sx={{ mb: 1 }}
          />

          <TextField
            id={`${idPrefix}-admin`}
            label={labels.administrativeArea}
            size="small"
            fullWidth
            disabled={disabled}
            slotProps={{ htmlInput: { maxLength: 120 } }}
            value={addr.administrativeArea}
            onChange={(e) => emit({ administrativeArea: e.target.value })}
            sx={{ mb: 1 }}
          />

          <TextField
            id={`${idPrefix}-postal`}
            label={labels.postalCode}
            size="small"
            fullWidth
            required={required}
            disabled={disabled}
            slotProps={{ htmlInput: { maxLength: 32 } }}
            value={addr.postalCode}
            onChange={(e) => emit({ postalCode: e.target.value })}
          />
        </>
      )}
    </Box>
  );
}

export { emptyAddress };
export default AddressInput;
