---
name: Places API (New) migration
description: How to use the new Google Places API (New) in this codebase — loader pattern, shape differences, REST endpoints.
---

## Rule
Use `google.maps.importLibrary('places')` — never `?libraries=places` in the script URL.

**Why:** Google stopped enabling the legacy Places API on new keys after March 2025. Modern keys only support the new API. The old `?libraries=places` bootstrap exposes `AutocompleteService` and `PlacesService` which return `REQUEST_DENIED` on these keys.

## How to apply

### Client loader (`loadPlacesScript`)
- Script URL: `?key=KEY&v=weekly&loading=async&language=LANG` (no `libraries=places`)
- After `script.onload`, call `google.maps.importLibrary('places')` which returns a Promise
- Resolves with the places library; check for `google.maps.places.AutocompleteSuggestion`

### Autocomplete (replaces `AutocompleteService.getPlacePredictions`)
```js
const { suggestions } = await google.maps.places.AutocompleteSuggestion
  .fetchAutocompleteSuggestions({ input, includedRegionCodes, language, sessionToken });
// suggestion.placePrediction.placeId
// suggestion.placePrediction.text.text  (full label)
// suggestion.placePrediction.toPlace()  (create Place for fetchFields)
```

### Place details (replaces `PlacesService.getDetails`)
```js
const place = placePrediction.toPlace();
await place.fetchFields({ fields: ['addressComponents', 'formattedAddress'], sessionToken });
// place.addressComponents: Array of { longText, shortText, types }  ← new shape
// place.formattedAddress: string
```

### Address component shape adapter
`adaptNewPlaceComponents(place.addressComponents)` in `shared/address.ts` (.cjs) converts
`{ longText, shortText, types }` → `{ long_name, short_name, types }` so
`googleComponentsToAddress()` works unchanged.

### Server-side REST (connection test in google-maps.js)
- Autocomplete: `POST https://places.googleapis.com/v1/places:autocomplete`
  with `X-Goog-Api-Key: KEY` header and JSON body `{ input, includedRegionCodes }`
- Details: `GET https://places.googleapis.com/v1/places/{placeId}?fields=addressComponents`
  with `X-Goog-Api-Key: KEY` header
- No `status` field in successful responses (unlike legacy); errors use HTTP codes + `error.message`

### Country restriction
Old: `componentRestrictions: { country: ['gb'] }` → New: `includedRegionCodes: ['gb']`

### Session tokens
`new google.maps.places.AutocompleteSessionToken()` still works in the new API.
Pass as `sessionToken` in both `fetchAutocompleteSuggestions` and `fetchFields` calls.
Clear after `fetchFields` (ends the billing session).
