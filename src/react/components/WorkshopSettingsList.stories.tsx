import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { WorkshopSettingsList, type WorkshopSetting } from './WorkshopSettingsList';

const SAMPLE: WorkshopSetting[] = [
  { key: 'lead_time_doors',  label: 'Doors lead time',  value: 14, updated_at: '2026-04-12T09:30:00Z', updated_by: 'alice@example.com' },
  { key: 'lead_time_carcs',  label: 'Carcasses lead time', value: 10, updated_at: '2026-03-01T12:00:00Z', updated_by: 'bob@example.com' },
  { key: 'lead_time_stone',  label: 'Stone tops lead time', value: 21, updated_at: null, updated_by: null },
  { key: 'lead_time_appls',  label: 'Appliances lead time', value: 7,  updated_at: null, updated_by: null },
];

const meta: Meta<typeof WorkshopSettingsList> = {
  title: 'Components/WorkshopSettingsList',
  tags: ['autodocs'],
  component: WorkshopSettingsList,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="admin-page" style={{ maxWidth: 720 }}>
        <div className="card">
          <Story />
        </div>
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof WorkshopSettingsList>;

export const Default: Story = {
  render: () => {
    const [values, setValues] = useState<Record<string, string>>(
      Object.fromEntries(SAMPLE.map(r => [r.key, String(r.value)]))
    );
    const [savingKey, setSavingKey] = useState<string | null>(null);
    return (
      <WorkshopSettingsList
        rows={SAMPLE}
        values={values}
        savingKey={savingKey}
        onChange={(k, v) => setValues(prev => ({ ...prev, [k]: v }))}
        onSave={(k) => {
          setSavingKey(k);
          window.setTimeout(() => setSavingKey(null), 600);
        }}
      />
    );
  },
};

export const Loading: Story = {
  args: { rows: [], values: {}, savingKey: null, onChange: () => {}, onSave: () => {}, loading: true },
};

export const Empty: Story = {
  args: { rows: [], values: {}, savingKey: null, onChange: () => {}, onSave: () => {} },
};
