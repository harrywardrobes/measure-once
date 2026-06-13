import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import {
  loadGoogleMapsConfig,
  isMapPreviewEnabled,
  reportGoogleMapsUsage,
  staticMapUrl,
  type GoogleMapsConfig,
  type GoogleMapsSurface,
} from '../lib/googleMapsConfig';

export interface AddressMapPreviewProps {
  /** The formatted address string to centre the map on. */
  address?: string | null;
  /** Which surface this preview lives on — gates visibility per admin config. */
  surface: GoogleMapsSurface;
  /** Rendered width in pixels (default 600, capped by container). */
  width?: number;
  /** Rendered height in pixels (default 200). */
  height?: number;
  /** When true, clicking the preview opens the location in Google Maps. */
  linkToMaps?: boolean;
}

/**
 * Static Google Map thumbnail for a saved address. Renders nothing when the
 * address is empty, the map-preview feature is disabled (globally or for this
 * surface), the API key is missing, or the static image fails to load — so it
 * degrades silently everywhere it is dropped in.
 */
export function AddressMapPreview({
  address,
  surface,
  width = 600,
  height = 200,
  linkToMaps = true,
}: AddressMapPreviewProps) {
  const [cfg, setCfg] = useState<GoogleMapsConfig | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadGoogleMapsConfig().then((c) => {
      if (!cancelled) setCfg(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setErrored(false);
  }, [address]);

  const trimmed = (address || '').trim();
  if (!trimmed || !cfg || !isMapPreviewEnabled(cfg, surface) || errored) return null;

  const src = staticMapUrl(cfg, trimmed, { width, height });
  if (!src) return null;

  const img = (
    <Box
      component="img"
      src={src}
      alt={`Map of ${trimmed}`}
      loading="lazy"
      onError={() => {
        setErrored(true);
        reportGoogleMapsUsage('staticmap', surface, false, 'IMG_ERROR');
      }}
      onLoad={() => reportGoogleMapsUsage('staticmap', surface, true)}
      sx={{
        width: '100%',
        height: 'auto',
        display: 'block',
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
      }}
    />
  );

  if (!linkToMaps) return <Box sx={{ mt: 1 }}>{img}</Box>;

  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
  return (
    <Box sx={{ mt: 1 }}>
      <Link href={mapsHref} target="_blank" rel="noopener noreferrer" underline="none">
        {img}
      </Link>
    </Box>
  );
}

export default AddressMapPreview;
