import React, { useCallback, useEffect, useRef, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';
import FormHelperText from '@mui/material/FormHelperText';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import SearchIcon from '@mui/icons-material/Search';
import {
  adaptNewPlaceComponents,
  googleComponentsToAddress,
  formatAddress,
} from '../../../shared/address';
import {
  isAutocompleteEnabled,
  loadGoogleMapsConfig,
  loadPlacesScript,
  reportGoogleMapsUsage,
  type GoogleMapsConfig,
  type GoogleMapsSurface,
} from '../lib/googleMapsConfig';
import type { NewPlaceAddressComponent } from '../../../shared/address';

interface NewPlaceResult {
  fetchFields(opts: { fields: string[]; sessionToken?: unknown }): Promise<void>;
  addressComponents?: NewPlaceAddressComponent[];
  formattedAddress?: string;
}

interface PlacePredictionRaw {
  placeId: string;
  text?: { text: string };
  toPlace(): NewPlaceResult;
}

interface LocationSuggestion {
  placeId: string;
  description: string;
  _raw: PlacePredictionRaw;
}

export interface PlacesLocationFieldProps {
  value: string;
  onChange: (v: string) => void;
  surface: GoogleMapsSurface;
  label?: string;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  size?: 'small' | 'medium';
  fullWidth?: boolean;
}

/**
 * Single-line free-text location field with optional Google Places (New) API
 * autocomplete. When autocomplete is enabled and the Places library loads, a
 * dropdown of address suggestions is shown; selecting one fills the field with
 * the formatted address string. The user can always type freely regardless of
 * whether autocomplete is available.
 *
 * Degrades silently to a plain TextField when the feature is off, the API key
 * is absent, or the library fails to load.
 */
export function PlacesLocationField({
  value,
  onChange,
  surface,
  label = 'Location',
  disabled = false,
  required = false,
  maxLength = 300,
  size = 'small',
  fullWidth = true,
}: PlacesLocationFieldProps) {
  const [cfg, setCfg] = useState<GoogleMapsConfig | null>(null);
  const [acReady, setAcReady] = useState(false);
  const [acFailed, setAcFailed] = useState(false);
  const [options, setOptions] = useState<LocationSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const sessionTokenRef = useRef<unknown>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
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

  const fetchSuggestions = useCallback(
    (text: string) => {
      if (!cfg || !acReady) return;
      const minChars = cfg.autocomplete.minChars;
      if (text.trim().length < minChars) {
        setOptions([]);
        return;
      }
      if (!sessionTokenRef.current) newSessionToken();
      setLoadingSuggestions(true);

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
          setLoadingSuggestions(false);
          const suggestions = result?.suggestions ?? [];
          reportGoogleMapsUsage('autocomplete', surface, true);
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
          setLoadingSuggestions(false);
          const code = String((err as { message?: string })?.message ?? err ?? 'ERROR');
          reportGoogleMapsUsage('autocomplete', surface, false, code);
        });
    },
    [cfg, acReady, newSessionToken, surface],
  );

  const handleInputChange = useCallback(
    (text: string) => {
      onChange(text);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      const delay = cfg?.autocomplete.debounceMs ?? 300;
      debounceRef.current = window.setTimeout(() => fetchSuggestions(text), delay);
    },
    [cfg, fetchSuggestions, onChange],
  );

  const handleSelect = useCallback(
    (suggestion: LocationSuggestion | null) => {
      if (!suggestion?._raw) return;
      const place = suggestion._raw.toPlace();
      const sessionToken = sessionTokenRef.current;
      // A details request always ends the billing session token.
      sessionTokenRef.current = null;
      place
        .fetchFields({
          fields: ['addressComponents', 'formattedAddress'],
          ...(sessionToken ? { sessionToken } : {}),
        })
        .then(() => {
          const hasData =
            typeof place.formattedAddress === 'string' || Array.isArray(place.addressComponents);
          reportGoogleMapsUsage('details', surface, hasData);
          if (!hasData) return;
          // Prefer the pre-formatted string from the API; fall back to
          // assembling one from the address components via the shared helper.
          const formatted: string =
            typeof place.formattedAddress === 'string' && place.formattedAddress
              ? place.formattedAddress
              : formatAddress(
                  googleComponentsToAddress(adaptNewPlaceComponents(place.addressComponents)),
                );
          onChange(formatted);
          setOptions([]);
        })
        .catch((err: unknown) => {
          const code = String((err as { message?: string })?.message ?? err ?? 'ERROR');
          reportGoogleMapsUsage('details', surface, false, code);
        });
    },
    [onChange, surface],
  );

  const showNotice =
    !!cfg &&
    isAutocompleteEnabled(cfg, surface) &&
    acFailed &&
    cfg.fallback.mode === 'notice';

  if (!acReady || acFailed) {
    return (
      <>
        <TextField
          label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          slotProps={{ htmlInput: { maxLength } }}
          disabled={disabled}
          required={required}
          fullWidth={fullWidth}
          size={size}
        />
        {showNotice && (
          <FormHelperText>
            Address search is unavailable right now — please enter the location manually.
          </FormHelperText>
        )}
      </>
    );
  }

  return (
    <Autocomplete<LocationSuggestion, false, false, true>
      freeSolo
      disabled={disabled}
      filterOptions={(x) => x}
      options={options}
      loading={loadingSuggestions}
      inputValue={value}
      getOptionLabel={(o) => (typeof o === 'string' ? o : o.description)}
      onInputChange={(_e, v, reason) => {
        if (reason === 'input') handleInputChange(v);
        else if (reason === 'clear') {
          onChange('');
          setOptions([]);
        }
      }}
      onChange={(_e, v) => {
        if (v && typeof v !== 'string') handleSelect(v);
        else if (typeof v === 'string') onChange(v);
      }}
      noOptionsText={
        value.trim().length < (cfg?.autocomplete.minChars ?? 3)
          ? 'Keep typing…'
          : 'No matches'
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          size={size}
          fullWidth={fullWidth}
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              ),
              endAdornment: (
                <>
                  {loadingSuggestions ? (
                    <CircularProgress color="inherit" size={16} />
                  ) : null}
                  {params.slotProps.input.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  );
}

export default PlacesLocationField;
