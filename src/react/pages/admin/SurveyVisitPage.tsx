import React, { useCallback, useEffect, useState } from 'react';
import { useConnectionCheck } from '../../context/ConnectionToastContext';
import {
  Box, Button, Card, CardContent, Stack, Typography,
} from '@mui/material';
import { usePageTitle } from '../../hooks/usePageTitle';
import { TabBar } from '../../components/TabBar';
import { QuestionnaireBuilder } from './QuestionnaireBuilder';
import { ADMIN_SURVEY_VISIT_SUBTAB_KEY } from '../../constants/localStorageKeys';
import {
  DvHandle, DvFurniture, DvDoorStyle,
  CatalogueTable, DvItemEditorDialog, useCatalogueData,
} from './visitCatalogueShared';

type SurveyVisitSubtab = 'catalogue' | 'questionnaire';
const SURVEY_VISIT_SUBTABS: { key: SurveyVisitSubtab; label: string }[] = [
  { key: 'catalogue',    label: 'Catalogue' },
  { key: 'questionnaire', label: 'Questionnaire' },
];

export function SurveyVisitPage() {
  usePageTitle('Survey Visit · Measure Once');
  useConnectionCheck();

  const [subtab, setSubtab] = useState<SurveyVisitSubtab>(() => {
    try {
      const saved = localStorage.getItem(ADMIN_SURVEY_VISIT_SUBTAB_KEY) as SurveyVisitSubtab | null;
      if (saved && SURVEY_VISIT_SUBTABS.some((t) => t.key === saved)) return saved;
    } catch { /* ignore */ }
    return 'catalogue';
  });

  const handleSubtab = useCallback((key: string) => {
    setSubtab(key as SurveyVisitSubtab);
    try { localStorage.setItem(ADMIN_SURVEY_VISIT_SUBTAB_KEY, key); } catch { /* ignore */ }
  }, []);

  const {
    handles, furniture, doorStyles,
    dialogState, fetchAll,
    openEditor, closeDialog,
    moveItem, reorderItems, deleteItem,
  } = useCatalogueData();

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleCols:    Array<{ field: keyof DvHandle;    label: string }> = [{ field: 'name', label: 'Name' }, { field: 'style', label: 'Style' }];
  const furnitureCols: Array<{ field: keyof DvFurniture; label: string }> = [{ field: 'name', label: 'Name' }, { field: 'description', label: 'Description' }];
  const doorStyleCols: Array<{ field: keyof DvDoorStyle; label: string }> = [{ field: 'name', label: 'Name' }, { field: 'image_url', label: 'Image URL' }];

  return (
    <>
      <TabBar
        tabs={SURVEY_VISIT_SUBTABS.map((t) => ({ key: t.key, label: t.label }))}
        activeKey={subtab}
        onSelect={handleSubtab}
      />

      {subtab === 'catalogue' && (
        <Stack spacing={2} sx={{ mt: 2 }}>
          <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
            <CardContent sx={{ py: '12px !important' }}>
              <Typography variant="body2" color="text.secondary">
                Survey visits share their catalogue with design visits — any changes made
                here are reflected across both visit types.
              </Typography>
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
                <Box>
                  <Typography variant="h6">Handles</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Handle options available for the surveyor to select per visit.
                  </Typography>
                </Box>
                <Button variant="contained" onClick={() => openEditor('handle')} sx={{ flexShrink: 0 }}>
                  + Add handle
                </Button>
              </Box>
              <CatalogueTable
                type="handle"
                items={handles}
                columns={handleCols}
                showImage
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
                <Box>
                  <Typography variant="h6">Furniture Ranges</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Furniture ranges the surveyor can assign to a visit.
                  </Typography>
                </Box>
                <Button variant="contained" onClick={() => openEditor('furniture')} sx={{ flexShrink: 0 }}>
                  + Add range
                </Button>
              </Box>
              <CatalogueTable
                type="furniture"
                items={furniture}
                columns={furnitureCols}
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
                <Box>
                  <Typography variant="h6">Door Styles</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Door style options available per room during the survey.
                  </Typography>
                </Box>
                <Button variant="contained" onClick={() => openEditor('door-style')} sx={{ flexShrink: 0 }}>
                  + Add style
                </Button>
              </Box>
              <CatalogueTable
                type="door-style"
                items={doorStyles}
                columns={doorStyleCols}
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </CardContent>
          </Card>
        </Stack>
      )}

      {subtab === 'questionnaire' && (
        <Box sx={{ mt: 2 }}>
          <QuestionnaireBuilder />
        </Box>
      )}

      <DvItemEditorDialog
        open={dialogState.open}
        type={dialogState.type}
        existingId={dialogState.existingId}
        onClose={closeDialog}
        onSaved={fetchAll}
      />
    </>
  );
}

export default SurveyVisitPage;
