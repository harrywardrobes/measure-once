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
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ChatBubbleOutlinedIcon from '@mui/icons-material/ChatBubbleOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import SendIcon from '@mui/icons-material/Send';
import { usePrivilege } from '../hooks/usePrivilege';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Idea {
  id: number;
  body: string;
  created_at: string;
  author_name: string;
  comment_count: number;
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  author_name: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const MAX_IDEA_CHARS = 1000;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

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
            <Skeleton variant="rounded" width={100} height={24} sx={{ mt: 1.25, borderRadius: 999 }} />
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
}: {
  comment: Comment;
  ideaId: number;
  isAdmin: boolean;
  onDeleted: (id: number) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
          </Stack>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {comment.body}
          </Typography>
        </Box>
        {isAdmin && (
          <Tooltip title="Delete comment">
            <IconButton
              size="small"
              onClick={() => setConfirmOpen(true)}
              sx={{ color: 'text.disabled', '&:hover': { color: 'error.main' }, flexShrink: 0 }}
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
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
  onToast,
}: {
  idea: Idea;
  isAdmin: boolean;
  onDeleted: (id: number) => void;
  onToast: (msg: string, error?: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [posting, setPosting] = useState(false);
  const [commentCount, setCommentCount] = useState(idea.comment_count);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  const commentLabel = commentCount === 1 ? '1 comment' : `${commentCount} comments`;

  return (
    <>
      <Card variant="outlined" sx={{ mb: 1.5 }}>
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
                {isAdmin && (
                  <Box sx={{ ml: 'auto' }}>
                    <Tooltip title="Delete idea">
                      <IconButton
                        size="small"
                        onClick={() => setConfirmOpen(true)}
                        sx={{ color: 'text.disabled', '&:hover': { color: 'error.main' } }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                )}
              </Stack>
              <Typography
                variant="body1"
                sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', mb: 1.25 }}
              >
                {idea.body}
              </Typography>
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
  const { isAdmin } = usePrivilege();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);

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

      {!loading && !loadError && ideas.map((idea) => (
        <IdeaCard
          key={idea.id}
          idea={idea}
          isAdmin={isAdmin}
          onDeleted={handleDeleted}
          onToast={showToast}
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
