import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Skeleton,
  Snackbar,
  Alert,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ChatBubbleOutlinedIcon from '@mui/icons-material/ChatBubbleOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import SendIcon from '@mui/icons-material/Send';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import { usePrivilege } from '../hooks/usePrivilege';
import { usePageTitle } from '../hooks/usePageTitle';
import { relativeTime } from '../utils/formatters';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Idea {
  id: number;
  body: string;
  created_at: string;
  edited_at: string | null;
  author_name: string;
  comment_count: number;
  vote_count: number;
  user_voted: boolean;
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  edited_at: string | null;
  author_name: string;
}

type SortMode = 'newest' | 'popular';

// ── Helpers ────────────────────────────────────────────────────────────────────

const MAX_IDEA_CHARS = 1000;

function initials(name: string): string {
  return (name || '')
    .trim()
    .split(/\s+/)
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

async function apiFetch<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  if (r.status === 401) { location.href = '/login'; throw new Error('Unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}

// ── Skeleton feed ──────────────────────────────────────────────────────────────

function IdeaSkeleton() {
  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent sx={{ pb: '12px !important' }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Skeleton variant="circular" width={36} height={36} sx={{ flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ mb: 0.75 }}>
              <Skeleton variant="text" width={110} height={16} />
              <Skeleton variant="text" width={70} height={16} />
            </Stack>
            <Skeleton variant="text" width="90%" height={14} />
            <Skeleton variant="text" width="75%" height={14} sx={{ mt: 0.5 }} />
            <Skeleton variant="text" width="55%" height={14} sx={{ mt: 0.5 }} />
            <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
              <Skeleton variant="rounded" width={64} height={24} sx={{ borderRadius: 999 }} />
              <Skeleton variant="rounded" width={100} height={24} sx={{ borderRadius: 999 }} />
            </Stack>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ── Comment row ────────────────────────────────────────────────────────────────

function CommentRow({
  comment,
  ideaId,
  isAdmin,
  onDeleted,
  onUpdated,
}: {
  comment: Comment;
  ideaId: number;
  isAdmin: boolean;
  onDeleted: (id: number) => void;
  onUpdated: (updated: Comment) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await apiFetch('DELETE', `/api/ideas/${ideaId}/comments/${comment.id}`);
      onDeleted(comment.id);
    } catch {
      // silent — individual comment delete failures don't need a snackbar
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }, [ideaId, comment.id, onDeleted]);

  const handleEditStart = useCallback(() => {
    setEditText(comment.body);
    setEditing(true);
  }, [comment.body]);

  const handleEditCancel = useCallback(() => {
    setEditing(false);
    setEditText('');
  }, []);

  const handleEditSave = useCallback(async () => {
    const body = editText.trim();
    if (!body || body === comment.body) { handleEditCancel(); return; }
    setSaving(true);
    try {
      const updated = await apiFetch<{ id: number; body: string; edited_at: string }>(
        'PATCH', `/api/ideas/${ideaId}/comments/${comment.id}`, { body }
      );
      onUpdated({ ...comment, body: updated.body, edited_at: updated.edited_at });
      setEditing(false);
      setEditText('');
    } catch {
      // silent — leave edit mode open so user can retry or cancel
    } finally {
      setSaving(false);
    }
  }, [editText, comment, ideaId, onUpdated, handleEditCancel]);

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1,
          py: 0.75,
          borderBottom: '1px solid',
          borderColor: 'divider',
          '&:last-child': { borderBottom: 'none' },
        }}
      >
        <Avatar
          sx={{ width: 24, height: 24, fontSize: 10, flexShrink: 0, bgcolor: 'secondary.main', mt: 0.25 }}
        >
          {initials(comment.author_name)}
        </Avatar>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.25 }}>
            <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.primary' }}>
              {comment.author_name}
            </Typography>
            <Typography variant="caption" color="text.disabled">
              {relativeTime(comment.created_at)}
            </Typography>
            {comment.edited_at && (
              <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
                (edited)
              </Typography>
            )}
          </Stack>
          {editing ? (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mt: 0.25 }}>
              <TextField
                size="small"
                value={editText}
                onChange={(e) => setEditText(e.target.value.slice(0, 500))}
                disabled={saving}
                autoFocus
                fullWidth
                multiline
                slotProps={{ htmlInput: { maxLength: 500 } }}
              />
              <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                <Button size="small" onClick={handleEditCancel} disabled={saving}>Cancel</Button>
                <Button size="small" variant="contained" onClick={handleEditSave} disabled={saving || !editText.trim()}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </Stack>
            </Box>
          ) : (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {comment.body}
            </Typography>
          )}
        </Box>
        {isAdmin && !editing && (
          <Stack direction="row" spacing={0} sx={{ flexShrink: 0 }}>
            <Tooltip title="Edit comment">
              <IconButton
                size="small"
                onClick={handleEditStart}
                sx={{ color: 'text.disabled', '&:hover': { color: 'primary.main' } }}
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete comment">
              <IconButton
                size="small"
                onClick={() => setConfirmOpen(true)}
                sx={{ color: 'text.disabled', '&:hover': { color: 'error.main' } }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        )}
      </Box>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete comment?</DialogTitle>
        <DialogContent>
          <DialogContentText>This comment will be permanently removed.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={deleting}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained" disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// ── Idea card ──────────────────────────────────────────────────────────────────

function IdeaCard({
  idea,
  isAdmin,
  onDeleted,
  onUpdated,
  onToast,
  onVoteChanged,
}: {
  idea: Idea;
  isAdmin: boolean;
  onDeleted: (id: number) => void;
  onUpdated: (updated: Idea) => void;
  onToast: (msg: string, error?: boolean) => void;
  onVoteChanged: (id: number, vote_count: number, user_voted: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [posting, setPosting] = useState(false);
  const [commentCount, setCommentCount] = useState(idea.comment_count);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [voting, setVoting] = useState(false);
  const didFetch = useRef(false);

  const handleToggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !didFetch.current) {
      didFetch.current = true;
      setLoadingComments(true);
      try {
        const data = await apiFetch<Comment[]>('GET', `/api/ideas/${idea.id}/comments`);
        setComments(data);
      } catch {
        setComments([]);
        onToast('Could not load comments.', true);
      } finally {
        setLoadingComments(false);
      }
    }
  }, [expanded, idea.id, onToast]);

  const handleReply = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const body = replyText.trim();
    if (!body) return;
    setPosting(true);
    try {
      const comment = await apiFetch<Comment>('POST', `/api/ideas/${idea.id}/comments`, { body });
      setComments((prev) => [...(prev || []), comment]);
      setCommentCount((c) => c + 1);
      setReplyText('');
    } catch (err: unknown) {
      onToast((err as Error).message || 'Could not post comment.', true);
    } finally {
      setPosting(false);
    }
  }, [idea.id, replyText, onToast]);

  const handleCommentDeleted = useCallback((id: number) => {
    setComments((prev) => (prev || []).filter((c) => c.id !== id));
    setCommentCount((c) => Math.max(0, c - 1));
  }, []);

  const handleCommentUpdated = useCallback((updated: Comment) => {
    setComments((prev) => (prev || []).map((c) => c.id === updated.id ? updated : c));
  }, []);

  const handleDeleteIdea = useCallback(async () => {
    setDeleting(true);
    try {
      await apiFetch('DELETE', `/api/ideas/${idea.id}`);
      onDeleted(idea.id);
    } catch (err: unknown) {
      onToast((err as Error).message || 'Could not delete idea.', true);
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }, [idea.id, onDeleted, onToast]);

  const handleEditStart = useCallback(() => {
    setEditText(idea.body);
    setEditing(true);
  }, [idea.body]);

  const handleEditCancel = useCallback(() => {
    setEditing(false);
    setEditText('');
  }, []);

  const handleEditSave = useCallback(async () => {
    const body = editText.trim();
    if (!body || body === idea.body) { handleEditCancel(); return; }
    setSaving(true);
    try {
      const updated = await apiFetch<{ id: number; body: string; edited_at: string }>(
        'PATCH', `/api/ideas/${idea.id}`, { body }
      );
      onUpdated({ ...idea, body: updated.body, edited_at: updated.edited_at });
      setEditing(false);
      setEditText('');
      onToast('Idea updated.');
    } catch (err: unknown) {
      onToast((err as Error).message || 'Could not update idea.', true);
    } finally {
      setSaving(false);
    }
  }, [editText, idea, onUpdated, onToast, handleEditCancel]);

  const handleVote = useCallback(async () => {
    if (voting) return;
    setVoting(true);
    try {
      const result = await apiFetch<{ vote_count: number; user_voted: boolean }>(
        'POST',
        `/api/ideas/${idea.id}/vote`,
      );
      onVoteChanged(idea.id, result.vote_count, result.user_voted);
    } catch (err: unknown) {
      onToast((err as Error).message || 'Could not update vote.', true);
    } finally {
      setVoting(false);
    }
  }, [idea.id, voting, onVoteChanged, onToast]);

  const commentLabel = commentCount === 1 ? '1 comment' : `${commentCount} comments`;
  const voteLabel = idea.vote_count === 1 ? '1' : String(idea.vote_count);
  const remaining = MAX_IDEA_CHARS - editText.length;

  return (
    <>
      <Card data-testid="idea-card" variant="outlined" sx={{ mb: 1.5 }}>
        <CardContent sx={{ pb: '12px !important' }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
            <Avatar
              sx={{
                width: 36,
                height: 36,
                fontSize: 13,
                fontWeight: 700,
                flexShrink: 0,
                bgcolor: 'primary.main',
              }}
            >
              {initials(idea.author_name)}
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
                <Typography variant="subtitle2" sx={{ color: 'text.primary' }}>
                  {idea.author_name}
                </Typography>
                <Typography variant="caption" color="text.disabled">
                  {relativeTime(idea.created_at)}
                </Typography>
                {idea.edited_at && (
                  <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
                    (edited)
                  </Typography>
                )}
                {isAdmin && !editing && (
                  <Box sx={{ ml: 'auto' }}>
                    <Stack direction="row" spacing={0}>
                      <Tooltip title="Edit idea">
                        <IconButton
                          size="small"
                          onClick={handleEditStart}
                          sx={{ color: 'text.disabled', '&:hover': { color: 'primary.main' } }}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete idea">
                        <IconButton
                          size="small"
                          onClick={() => setConfirmOpen(true)}
                          data-testid="delete-idea-btn"
                          sx={{ color: 'text.disabled', '&:hover': { color: 'error.main' } }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Box>
                )}
              </Stack>

              {editing ? (
                <Box sx={{ mb: 1 }}>
                  <TextField
                    multiline
                    minRows={3}
                    maxRows={10}
                    fullWidth
                    value={editText}
                    onChange={(e) => setEditText(e.target.value.slice(0, MAX_IDEA_CHARS))}
                    disabled={saving}
                    autoFocus
                    size="small"
                    slotProps={{ htmlInput: { maxLength: MAX_IDEA_CHARS } }}
                  />
                  <Stack direction="row" spacing={1} sx={{ mt: 0.75, alignItems: 'center' }}>
                    <Typography
                      variant="caption"
                      color={remaining < 50 ? 'warning.main' : 'text.disabled'}
                      sx={{ flex: 1 }}
                    >
                      {remaining} characters remaining
                    </Typography>
                    <Button size="small" onClick={handleEditCancel} disabled={saving}>Cancel</Button>
                    <Button
                      size="small"
                      variant="contained"
                      onClick={handleEditSave}
                      disabled={saving || !editText.trim()}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </Button>
                  </Stack>
                </Box>
              ) : (
                <Typography
                  variant="body1"
                  sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', mb: 1.25 }}
                >
                  {idea.body}
                </Typography>
              )}

              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Tooltip title={idea.user_voted ? 'Remove upvote' : 'Upvote this idea'}>
                  <Chip
                    icon={
                      idea.user_voted
                        ? <ThumbUpIcon sx={{ fontSize: '14px !important' }} />
                        : <ThumbUpOutlinedIcon sx={{ fontSize: '14px !important' }} />
                    }
                    label={voteLabel}
                    size="small"
                    onClick={handleVote}
                    variant={idea.user_voted ? 'filled' : 'outlined'}
                    color={idea.user_voted ? 'primary' : 'default'}
                    disabled={voting}
                    sx={{ cursor: 'pointer', fontSize: '0.72rem', minWidth: 52 }}
                    aria-label={idea.user_voted ? 'Remove upvote' : 'Upvote'}
                    aria-pressed={idea.user_voted}
                  />
                </Tooltip>
                <Chip
                  icon={<ChatBubbleOutlinedIcon sx={{ fontSize: '14px !important' }} />}
                  label={commentLabel}
                  size="small"
                  onClick={handleToggle}
                  variant={expanded ? 'filled' : 'outlined'}
                  color={expanded ? 'primary' : 'default'}
                  sx={{ cursor: 'pointer', fontSize: '0.72rem' }}
                  aria-expanded={expanded}
                />
              </Stack>

              <Collapse in={expanded} unmountOnExit={false}>
                <Box
                  sx={{
                    mt: 1.5,
                    borderTop: '1px solid',
                    borderColor: 'divider',
                    pt: 1,
                  }}
                >
                  {loadingComments ? (
                    <Stack spacing={0.75}>
                      {[1, 2].map((i) => (
                        <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                          <Skeleton variant="circular" width={24} height={24} />
                          <Box sx={{ flex: 1 }}>
                            <Skeleton variant="text" width="60%" height={14} />
                            <Skeleton variant="text" width="80%" height={12} />
                          </Box>
                        </Stack>
                      ))}
                    </Stack>
                  ) : comments && comments.length === 0 ? (
                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1 }}>
                      No comments yet.
                    </Typography>
                  ) : (
                    <Box sx={{ mb: 1 }}>
                      {(comments || []).map((c) => (
                        <CommentRow
                          key={c.id}
                          comment={c}
                          ideaId={idea.id}
                          isAdmin={isAdmin}
                          onDeleted={handleCommentDeleted}
                          onUpdated={handleCommentUpdated}
                        />
                      ))}
                    </Box>
                  )}

                  <Box
                    component="form"
                    onSubmit={handleReply}
                    sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mt: 0.5 }}
                  >
                    <TextField
                      size="small"
                      placeholder="Add a comment…"
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      disabled={posting}
                      autoComplete="off"
                      sx={{ flex: 1 }}
                      slotProps={{ htmlInput: { maxLength: 500 } }}
                    />
                    <Tooltip title="Post comment">
                      <span>
                        <IconButton
                          type="submit"
                          size="small"
                          color="primary"
                          disabled={posting || !replyText.trim()}
                        >
                          <SendIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                </Box>
              </Collapse>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete idea?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This idea and all its comments will be permanently removed.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={deleting}>Cancel</Button>
          <Button onClick={handleDeleteIdea} color="error" variant="contained" disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// ── New Idea dialog ────────────────────────────────────────────────────────────

function NewIdeaDialog({
  open,
  onClose,
  onPosted,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  onPosted: (idea: Idea) => void;
  onToast: (msg: string, error?: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const handleClose = useCallback(() => {
    if (posting) return;
    setText('');
    onClose();
  }, [posting, onClose]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setPosting(true);
    try {
      const idea = await apiFetch<Idea>('POST', '/api/ideas', { body });
      onPosted(idea);
      setText('');
      onClose();
      onToast('Idea posted!');
    } catch (err: unknown) {
      onToast((err as Error).message || 'Could not post idea.', true);
    } finally {
      setPosting(false);
    }
  }, [text, onPosted, onClose, onToast]);

  const remaining = MAX_IDEA_CHARS - text.length;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Share an idea</DialogTitle>
      <Box component="form" onSubmit={handleSubmit}>
        <DialogContent sx={{ pt: 1 }}>
          <TextField
            multiline
            minRows={4}
            maxRows={10}
            fullWidth
            placeholder="Share a suggestion or piece of feedback with your team…"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_IDEA_CHARS))}
            disabled={posting}
            autoFocus
            slotProps={{ htmlInput: { maxLength: MAX_IDEA_CHARS } }}
          />
          <Typography
            variant="caption"
            color={remaining < 50 ? 'warning.main' : 'text.disabled'}
            sx={{ display: 'block', textAlign: 'right', mt: 0.5 }}
          >
            {remaining} characters remaining
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={posting}>Cancel</Button>
          <Button
            type="submit"
            variant="contained"
            disabled={posting || !text.trim()}
            startIcon={<AddIcon />}
          >
            {posting ? 'Posting…' : 'Post idea'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

// ── IdeasPage ──────────────────────────────────────────────────────────────────

export function IdeasPage() {
  usePageTitle('Ideas · Measure Once');
  const { isAdmin } = usePrivilege();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('newest');

  const showToast = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiFetch<Idea[]>('GET', '/api/ideas');
      setIdeas(data);
    } catch (err: unknown) {
      setLoadError((err as Error).message || 'Could not load ideas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handlePosted = useCallback((idea: Idea) => {
    setIdeas((prev) => [idea, ...prev]);
  }, []);

  const handleDeleted = useCallback((id: number) => {
    setIdeas((prev) => prev.filter((i) => i.id !== id));
    showToast('Idea deleted.');
  }, [showToast]);

  const handleUpdated = useCallback((updated: Idea) => {
    setIdeas((prev) => prev.map((i) => i.id === updated.id ? updated : i));
  }, []);

  const handleVoteChanged = useCallback((id: number, vote_count: number, user_voted: boolean) => {
    setIdeas((prev) => prev.map((i) => i.id === id ? { ...i, vote_count, user_voted } : i));
  }, []);

  const sortedIdeas = sortMode === 'popular'
    ? [...ideas].sort((a, b) => b.vote_count - a.vote_count || new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    : ideas;


  return (
    <Box sx={{ maxWidth: 680, mx: 'auto', px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 3 } }}>
      <Stack direction="row" sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ mb: 0.25 }}>
            Ideas &amp; Feedback
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Share suggestions and discuss ideas with your team.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setDialogOpen(true)}
          sx={{ flexShrink: 0, ml: 2 }}
        >
          New Idea
        </Button>
      </Stack>

      {!loading && !loadError && ideas.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <ToggleButtonGroup
            value={sortMode}
            exclusive
            onChange={(_e, val) => { if (val) setSortMode(val); }}
            size="small"
            aria-label="Sort ideas"
          >
            <ToggleButton value="newest" aria-label="Sort by newest">
              Newest
            </ToggleButton>
            <ToggleButton value="popular" aria-label="Sort by most popular">
              Most popular
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}

      {loading && (
        <Box>
          {[1, 2, 3].map((i) => <IdeaSkeleton key={i} />)}
        </Box>
      )}

      {!loading && loadError && (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <Typography color="error" sx={{ mb: 1.5 }}>
            {loadError}
          </Typography>
          <Button variant="outlined" onClick={load}>
            Retry
          </Button>
        </Box>
      )}

      {!loading && !loadError && ideas.length === 0 && (
        <Box sx={{ textAlign: 'center', py: 8, color: 'text.disabled' }}>
          <LightbulbOutlinedIcon sx={{ fontSize: 48, mb: 1.5 }} />
          <Typography variant="body1">No ideas yet — be the first to share one!</Typography>
        </Box>
      )}

      {!loading && !loadError && sortedIdeas.map((idea) => (
        <IdeaCard
          key={idea.id}
          idea={idea}
          isAdmin={isAdmin}
          onDeleted={handleDeleted}
          onUpdated={handleUpdated}
          onToast={showToast}
          onVoteChanged={handleVoteChanged}
        />
      ))}

      <NewIdeaDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onPosted={handlePosted}
        onToast={showToast}
      />

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={toast?.error ? 'error' : 'success'}
          onClose={() => setToast(null)}
          sx={{ width: '100%' }}
        >
          {toast?.msg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
