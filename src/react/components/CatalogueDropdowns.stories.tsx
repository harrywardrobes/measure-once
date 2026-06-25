import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import {
  CatalogueDropdowns,
  type CatalogueOption,
  type CatalogueSuggestion,
} from '../components/CatalogueDropdowns';

const DOOR_STYLES: CatalogueOption[] = [
  { id: 1, name: 'Shaker' },
  { id: 2, name: 'Slab' },
  { id: 3, name: 'Beaded' },
];

const HANDLES: CatalogueOption[] = [
  { id: 10, name: 'Bar handle — brushed brass' },
  { id: 11, name: 'Cup handle — matte black' },
  { id: 12, name: 'Knob — chrome' },
];

const FINISHES: CatalogueOption[] = [
  { id: 20, name: 'Matte white' },
  { id: 21, name: 'Sage green' },
  { id: 22, name: 'Graphite' },
];

const meta: Meta<typeof CatalogueDropdowns> = {
  title: 'Visits/CatalogueDropdowns',
  component: CatalogueDropdowns,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof CatalogueDropdowns>;

/** Plain dropdowns with no pairing suggestions (Design Visit behaviour). */
export const Basic: Story = {
  render: () => {
    const [handleId, setHandleId] = useState('');
    const [finishId, setFinishId] = useState('');
    return (
      <Box sx={{ maxWidth: 360 }}>
        <CatalogueDropdowns
          dropdowns={[
            {
              label: 'Handle selection',
              value: handleId,
              options: HANDLES,
              onChange: setHandleId,
              noneLabel: '— select handle —',
            },
            {
              label: 'Finish',
              value: finishId,
              options: FINISHES,
              onChange: setFinishId,
              noneLabel: '— select finish —',
            },
          ]}
        />
      </Box>
    );
  },
};

/**
 * Choosing a door surfaces suggested handle/finish pairings (Survey Visit).
 * Pick a door style to see the suggestions update; click Apply to accept one.
 */
export const WithPairingSuggestions: Story = {
  render: () => {
    const [doorId, setDoorId] = useState('1');
    const [handleId, setHandleId] = useState('');
    const [finishId, setFinishId] = useState('');

    // Demo pairing table: door id → suggested handle/finish.
    const PAIRINGS: Record<string, { handle: CatalogueSuggestion; finish: CatalogueSuggestion }> = {
      '1': {
        handle: { id: '10', name: 'Bar handle — brushed brass' },
        finish: { id: '21', name: 'Sage green' },
      },
      '2': {
        handle: { id: '12', name: 'Knob — chrome' },
        finish: { id: '22', name: 'Graphite' },
      },
      '3': {
        handle: { id: '11', name: 'Cup handle — matte black' },
        finish: { id: '20', name: 'Matte white' },
      },
    };
    const pairing = PAIRINGS[doorId];

    return (
      <Box sx={{ maxWidth: 360 }}>
        <Typography variant="caption" sx={{ display: 'block', mb: 1, color: 'text.secondary' }}>
          Pick a door style — suggestions update below.
        </Typography>
        <CatalogueDropdowns
          dropdowns={[
            {
              label: 'Door style',
              value: doorId,
              options: DOOR_STYLES,
              onChange: (v) => setDoorId(v),
              noneLabel: '— select door —',
            },
            {
              label: 'Handle selection',
              value: handleId,
              options: HANDLES,
              onChange: setHandleId,
              noneLabel: '— select handle —',
              suggestion: pairing?.handle ?? null,
            },
            {
              label: 'Finish',
              value: finishId,
              options: FINISHES,
              onChange: setFinishId,
              noneLabel: '— select finish —',
              suggestion: pairing?.finish ?? null,
            },
          ]}
        />
      </Box>
    );
  },
};
