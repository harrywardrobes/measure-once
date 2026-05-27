export interface SearchSettings {
  disabled_actions: string[];
  hint_placeholder: string;
  action_order: string[];
}

let _cachedSettings: SearchSettings | null = null;
let _settingsFetch: Promise<SearchSettings> | null = null;

export function loadSearchSettings(): Promise<SearchSettings> {
  if (_cachedSettings !== null) return Promise.resolve(_cachedSettings);
  if (_settingsFetch !== null) return _settingsFetch;
  _settingsFetch = fetch('/api/search-settings')
    .then(r => r.ok ? r.json() : { disabled_actions: [], hint_placeholder: '', action_order: [] })
    .catch(() => ({ disabled_actions: [], hint_placeholder: '', action_order: [] }))
    .then((data: SearchSettings) => {
      _cachedSettings = data;
      _settingsFetch = null;
      return data;
    });
  return _settingsFetch;
}

export function getCachedSearchSettings(): SearchSettings | null {
  return _cachedSettings;
}
