import React, { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { GET, POST, PATCH, DELETE } from '../../utils/api';
import type {
  VisitQuestionScope,
  VisitQuestionType,
} from '../../components/QuestionnaireRenderer';

/** Admin shape — includes inactive questions + active flag. */
interface AdminQuestion {
  id: number;
  scope: VisitQuestionScope;
  applies_to: string[];
  label: string;
  type: VisitQuestionType;
  options: string[];
  required: boolean;
  active: boolean;
  sort_order: number;
}

const SCOPES: { value: VisitQuestionScope; label: string }[] = [
  { value: 'visit', label: 'Whole visit' },
  { value: 'room', label: 'Per room' },
];

const TYPES: { value: VisitQuestionType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'yesno', label: 'Yes / No' },
  { value: 'choice', label: 'Choice' },
  { value: 'number', label: 'Number' },
];

interface EditState {
  open: boolean;
  question: AdminQuestion | null;
}

const BLANK: Omit<AdminQuestion, 'id'> = {
  scope: 'visit',
  applies_to: ['design'],
  label: '',
  type: 'text',
  options: [],
  required: false,
  active: true,
  sort_order: 0,
};

function QuestionEditorDialog({
  state,
  onClose,
  onSaved,
}: {
  state: EditState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = state.question;
  const [scope, setScope] = useState<VisitQuestionScope>('visit');
  const [appliesTo, setAppliesTo] = useState('design');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<VisitQuestionType>('text');
  const [optionsText, setOptionsText] = useState('');
  const [required, setRequired] = useState(false);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!state.open) return;
    const q = editing;
    setScope(q?.scope ?? BLANK.scope);
    setAppliesTo((q?.applies_to ?? BLANK.applies_to).join(', '));
    setLabel(q?.label ?? '');
    setType(q?.type ?? BLANK.type);
    setOptionsText((q?.options ?? []).join('\n'));
    setRequired(q?.required ?? false);
    setActive(q?.active ?? true);
    setErr('');
  }, [state.open, editing]);

  const save = useCallback(async () => {
    const trimmed = label.trim();
    if (!trimmed) { setErr('Question text is required.'); return; }
    const opts = type === 'choice'
      ? optionsText.split('\n').map((s) => s.trim()).filter(Boolean)
      : [];
    if (type === 'choice' && opts.length === 0) {
      setErr('Choice questions need at least one option.');
      return;
    }
    const body = {
      scope,
      applies_to: appliesTo.split(',').map((s) => s.trim()).filter(Boolean),
      label: trimmed,
      type,
      options: opts,
      required,
      active,
    };
    setSaving(true);
    setErr('');
    try {
      if (editing) {
        await PATCH(`/api/admin/visit-questions/${editing.id}`, body);
      } else {
        await POST('/api/admin/visit-questions', body);
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [label, type, optionsText, scope, appliesTo, required, active, editing, onSaved, onClose]);

  return (
    <Dialog open={state.open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? 'Edit question' : 'Add question'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Question text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            fullWidth
            autoFocus
            multiline
            minRows={1}
          />
          <FormControl fullWidth size="small">
            <InputLabel>Applies to</InputLabel>
            <Select label="Applies to" value={scope} onChange={(e) => setScope(e.target.value as VisitQuestionScope)}>
              {SCOPES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl fullWidth size="small">
            <InputLabel>Answer type</InputLabel>
            <Select label="Answer type" value={type} onChange={(e) => setType(e.target.value as VisitQuestionType)}>
              {TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
            </Select>
          </FormControl>
          {type === 'choice' && (
            <TextField
              label="Options (one per line)"
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              fullWidth
              multiline
              minRows={3}
              helperText="Each line becomes a selectable option."
            />
          )}
          <TextField
            label="Visit types (comma-separated)"
            value={appliesTo}
            onChange={(e) => setAppliesTo(e.target.value)}
            fullWidth
            size="small"
            helperText="e.g. design, survey"
          />
          <FormControlLabel
            control={<Checkbox checked={required} onChange={(e) => setRequired(e.target.checked)} />}
            label="Required"
          />
          <FormControlLabel
            control={<Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />}
            label="Active (shown in wizard)"
          />
          {err && <Alert severity="error">{err}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

function QuestionRow({
  q,
  isFirst,
  isLast,
  onEdit,
  onDelete,
  onMove,
}: {
  q: AdminQuestion;
  isFirst: boolean;
  isLast: boolean;
  onEdit: (q: AdminQuestion) => void;
  onDelete: (q: AdminQuestion) => void;
  onMove: (q: AdminQuestion, dir: -1 | 1) => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        py: 1,
        px: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        opacity: q.active ? 1 : 0.55,
      }}
    >
      <Stack direction="column" spacing={0}>
        <IconButton size="small" disabled={isFirst} onClick={() => onMove(q, -1)} aria-label="Move up">
          <ArrowUpwardIcon fontSize="inherit" />
        </IconButton>
        <IconButton size="small" disabled={isLast} onClick={() => onMove(q, 1)} aria-label="Move down">
          <ArrowDownwardIcon fontSize="inherit" />
        </IconButton>
      </Stack>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body1" sx={{ fontWeight: 500 }}>{q.label}</Typography>
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
          <Chip size="small" label={TYPES.find((t) => t.value === q.type)?.label ?? q.type} />
          {q.required && <Chip size="small" color="warning" label="Required" />}
          {!q.active && <Chip size="small" variant="outlined" label="Inactive" />}
          {q.applies_to.map((a) => <Chip key={a} size="small" variant="outlined" label={a} />)}
        </Stack>
      </Box>
      <IconButton size="small" onClick={() => onEdit(q)} aria-label="Edit"><EditIcon fontSize="inherit" /></IconButton>
      <IconButton size="small" onClick={() => onDelete(q)} aria-label="Delete"><DeleteIcon fontSize="inherit" /></IconButton>
    </Box>
  );
}

export function QuestionnaireBuilder() {
  const [questions, setQuestions] = useState<AdminQuestion[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [edit, setEdit] = useState<EditState>({ open: false, question: null });

  const fetchAll = useCallback(async () => {
    try {
      const rows = await GET<AdminQuestion[]>('/api/admin/visit-questions');
      setQuestions(Array.isArray(rows) ? rows : []);
      setLoadErr('');
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Failed to load questions.');
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const deleteQuestion = useCallback(async (q: AdminQuestion) => {
    if (!window.confirm(`Delete question "${q.label}"? This also removes its captured answers.`)) return;
    try {
      await DELETE(`/api/admin/visit-questions/${q.id}`);
      fetchAll();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Delete failed.');
    }
  }, [fetchAll]);

  const moveQuestion = useCallback(async (scopeList: AdminQuestion[], q: AdminQuestion, dir: -1 | 1) => {
    const idx = scopeList.findIndex((x) => x.id === q.id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= scopeList.length) return;
    const reordered = [...scopeList];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    const order = reordered.map((item, i) => ({ id: item.id, sort_order: (i + 1) * 10 }));
    // Optimistic update.
    const byId = new Map(order.map((o) => [o.id, o.sort_order]));
    setQuestions((prev) =>
      prev.map((p) => (byId.has(p.id) ? { ...p, sort_order: byId.get(p.id)! } : p)),
    );
    try {
      await PATCH('/api/admin/visit-questions/reorder', { order });
      fetchAll();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Reorder failed.');
      fetchAll();
    }
  }, [fetchAll]);

  const renderScope = (scope: VisitQuestionScope, title: string, description: string) => {
    const list = questions
      .filter((q) => q.scope === scope)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    return (
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 1 }}>
            <Box>
              <Typography variant="h6">{title}</Typography>
              <Typography variant="body2" color="text.secondary">{description}</Typography>
            </Box>
            <Button
              variant="contained"
              sx={{ flexShrink: 0 }}
              onClick={() => setEdit({ open: true, question: { ...BLANK, id: 0, scope } as AdminQuestion })}
            >
              + Add question
            </Button>
          </Box>
          {list.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              No questions yet.
            </Typography>
          ) : (
            list.map((q, i) => (
              <QuestionRow
                key={q.id}
                q={q}
                isFirst={i === 0}
                isLast={i === list.length - 1}
                onEdit={(qq) => setEdit({ open: true, question: qq })}
                onDelete={deleteQuestion}
                onMove={(qq, dir) => moveQuestion(list, qq, dir)}
              />
            ))
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <>
      <Stack spacing={2}>
        {loadErr && <Alert severity="error">{loadErr}</Alert>}
        {renderScope('visit', 'Whole-visit questions', 'Asked once per visit, in the wizard summary step.')}
        {renderScope('room', 'Per-room questions', 'Asked for each room added in the wizard.')}
      </Stack>
      <QuestionEditorDialog
        state={edit}
        onClose={() => setEdit({ open: false, question: null })}
        onSaved={fetchAll}
      />
    </>
  );
}

export default QuestionnaireBuilder;
