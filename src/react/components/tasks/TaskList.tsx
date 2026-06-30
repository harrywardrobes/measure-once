import React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { relativeTime } from '../../utils/formatters';
import { useToastContext } from '../../contexts/ToastContext';

// A single, surface-agnostic feed item. Both Google-Calendar-backed tasks and
// plain calendar events (visits) normalise to this shape, so the same renderer
// drives the home screen, the customer detail page and the Contact Customer
// modal. Each surface keeps its own data fetching and builds these items.
export interface TaskListItem {
  id: string;
  kind: 'task' | 'event';
  title: string;
  /** Scheduled time used to order the OPEN list (task deadline / event start). */
  when: string | null;
  /**
   * Ordering key for the DONE / PAST list (task completion time, falling back
   * to its deadline; event start). Defaults to `when` when omitted.
   */
  pastWhen?: string | null;
  /** Tasks only — drives the tick control and the open/done split. */
  status?: 'open' | 'completed';
  contactId?: string;
  contactName?: string;
  assigneeName?: string;
  /** Events only — e.g. "Design visit". Rendered as a chip. */
  eventTypeLabel?: string;
}

export interface CategorizedItems {
  open: TaskListItem[];
  past: TaskListItem[];
}

const pastKey = (i: TaskListItem): number => {
  const t = i.pastWhen ?? i.when;
  return t ? new Date(t).getTime() : 0;
};
const whenKey = (i: TaskListItem): number =>
  i.when ? new Date(i.when).getTime() : Number.MAX_SAFE_INTEGER;

/**
 * Split a flat item list into the OPEN feed (soonest-first) and the DONE / PAST
 * feed (most-recently-completed/occurred first). A task is "done" once its
 * status is completed; an event is "past" once its start time has passed.
 * Shared so every surface categorises identically.
 */
export function categorizeTaskItems(items: TaskListItem[], nowMs: number): CategorizedItems {
  const open: TaskListItem[] = [];
  const past: TaskListItem[] = [];
  for (const i of items) {
    const isPast =
      i.kind === 'task'
        ? i.status === 'completed'
        : !!i.when && new Date(i.when).getTime() < nowMs;
    (isPast ? past : open).push(i);
  }
  open.sort((a, b) => whenKey(a) - whenKey(b));
  past.sort((a, b) => pastKey(b) - pastKey(a));
  return { open, past };
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtWhen(iso: string): string {
  const dt = new Date(iso);
  const datePart = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (!iso.includes('T')) return datePart; // all-day event ('YYYY-MM-DD')
  return `${datePart}, ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

interface RowProps {
  item: TaskListItem;
  done: boolean;
  showContact: boolean;
  todayMs: number;
  onToggle?: (item: TaskListItem, nextDone: boolean) => void;
  onItemClick?: (item: TaskListItem) => void;
  renderItemActions?: (item: TaskListItem) => React.ReactNode;
  renderItemBody?: (item: TaskListItem) => React.ReactNode;
}

function TaskRow({
  item, done, showContact, todayMs, onToggle, onItemClick, renderItemActions, renderItemBody,
}: RowProps) {
  const isTask = item.kind === 'task';
  const clickable = !!onItemClick && !!item.contactId;
  const overdue = !done && isTask && !!item.when && new Date(item.when).getTime() < todayMs;

  const customBody = renderItemBody?.(item);

  const meta: React.ReactNode = (() => {
    if (done) {
      const t = item.pastWhen ?? item.when;
      const verb = isTask ? 'Completed' : '';
      return t ? `${verb}${verb ? ' ' : ''}${relativeTime(t)}` : null;
    }
    if (isTask) {
      return item.when ? `${overdue ? '⚠ Overdue · ' : ''}${fmtDate(item.when)}` : null;
    }
    return item.when ? fmtWhen(item.when) : null;
  })();

  return (
    <Card
      variant="outlined"
      data-testid={`task-row-${item.kind}`}
      onClick={clickable ? () => onItemClick!(item) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onItemClick!(item); }
      } : undefined}
      sx={{
        mb: 1,
        opacity: done ? 0.7 : 1,
        cursor: clickable ? 'pointer' : 'default',
        ...(clickable ? { '&:hover': { borderColor: 'primary.main' } } : {}),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, p: 1.5 }}>
        {isTask ? (
          <Box
            component="button"
            data-testid="task-toggle"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onToggle?.(item, !done); }}
            disabled={!onToggle}
            title={done ? 'Mark incomplete' : 'Mark complete'}
            sx={{
              width: 20, height: 20, mt: '1px', flexShrink: 0, p: 0,
              borderRadius: '50%',
              border: done ? 'none' : '2px solid var(--stone-deep)',
              background: done ? 'success.dark' : 'none',
              color: done ? 'common.white' : 'inherit',
              cursor: onToggle ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'inherit', WebkitTapHighlightColor: 'transparent',
              transition: 'border-color 0.15s, background 0.15s',
              '&:hover': onToggle ? { borderColor: done ? undefined : 'var(--orchid)' } : undefined,
            }}
          >
            {done && <CheckIcon sx={{ fontSize: 12 }} />}
          </Box>
        ) : (
          <Box
            aria-hidden
            sx={{
              width: 8, height: 8, mt: '6px', flexShrink: 0, borderRadius: '50%',
              border: '2px solid', borderColor: 'text.disabled',
            }}
          />
        )}

        <Box sx={{ flex: 1, minWidth: 0 }}>
          {customBody ?? (
            <>
              <Typography
                variant="body2"
                noWrap
                sx={{ fontWeight: 600, textDecoration: done ? 'line-through' : 'none', color: done ? 'text.secondary' : 'text.primary' }}
              >
                {item.title}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25, flexWrap: 'wrap' }}>
                {meta ? (
                  <Typography variant="caption" sx={{ color: overdue ? 'error.main' : 'text.secondary' }}>
                    {meta}
                  </Typography>
                ) : null}
                {showContact && item.contactName ? (
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
                    · {item.contactName}
                  </Typography>
                ) : null}
                {item.eventTypeLabel ? (
                  <Chip label={item.eventTypeLabel} size="small" variant="outlined" sx={{ height: 20 }} />
                ) : null}
              </Stack>
              {item.assigneeName ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  Assigned to {item.assigneeName}
                </Typography>
              ) : null}
            </>
          )}
        </Box>

        {renderItemActions ? (
          <Box
            sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 0.5 }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {renderItemActions(item)}
          </Box>
        ) : null}
      </Box>
    </Card>
  );
}

export interface TaskListProps {
  /** Open feed, in the order you want it shown (caller sorts/paginates). */
  openItems: TaskListItem[];
  /** Completed tasks + past events; TaskList sorts these newest-first. */
  pastItems: TaskListItem[];
  /** Persist a task's done state. Receives the item and its next done value. */
  onToggleDone?: (item: TaskListItem, nextDone: boolean) => void;
  /** Navigate when a row is clicked (used on the all-contacts home feed). */
  onItemClick?: (item: TaskListItem) => void;
  /** Show the contact name on each row (home feed spans many contacts). */
  showContact?: boolean;
  /** Trailing per-row controls (e.g. edit/delete on the detail page). */
  renderItemActions?: (item: TaskListItem) => React.ReactNode;
  /** Override a row's title/meta block (e.g. inline editors on the detail page). */
  renderItemBody?: (item: TaskListItem) => React.ReactNode;
  /** Message when the open feed is empty. */
  emptyText?: string;
  /** Heading for the open feed. Omit to render the open list with no heading. */
  pastHeading?: string;
}

/**
 * Shared task/event feed: an open list plus a collapsible "Done / Past" section
 * (minimised by default) that lists every completed task and past event,
 * newest-first by completion/occurrence date. Ticking a task fires an undo
 * toast so an accidental complete is one click away from being reversed.
 */
export function TaskList({
  openItems,
  pastItems,
  onToggleDone,
  onItemClick,
  showContact = false,
  renderItemActions,
  renderItemBody,
  emptyText = 'No tasks yet.',
  pastHeading = 'Done / Past',
}: TaskListProps) {
  const { showToastWithAction } = useToastContext();
  const [pastOpen, setPastOpen] = React.useState(false);
  const todayMs = React.useMemo(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  }, []);

  const handleToggle = React.useCallback((item: TaskListItem, nextDone: boolean) => {
    onToggleDone?.(item, nextDone);
    // Only the complete direction gets an undo prompt — reopening is already the
    // reverse action and needs no second confirmation.
    if (nextDone) {
      showToastWithAction(
        'Task completed',
        { label: 'Undo', onClick: () => onToggleDone?.(item, false) },
        { duration: 5000 },
      );
    }
  }, [onToggleDone, showToastWithAction]);

  const sortedPast = React.useMemo(
    () => [...pastItems].sort((a, b) => pastKey(b) - pastKey(a)),
    [pastItems],
  );

  return (
    <Box>
      {openItems.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          {emptyText}
        </Typography>
      ) : (
        openItems.map((item) => (
          <TaskRow
            key={item.id}
            item={item}
            done={false}
            showContact={showContact}
            todayMs={todayMs}
            onToggle={onToggleDone ? handleToggle : undefined}
            onItemClick={onItemClick}
            renderItemActions={renderItemActions}
            renderItemBody={renderItemBody}
          />
        ))
      )}

      {sortedPast.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Box
            component="button"
            data-testid="task-past-toggle"
            onClick={() => setPastOpen((o) => !o)}
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.5, width: '100%',
              background: 'none', border: 'none', p: '4px 2px', cursor: 'pointer',
              color: 'text.secondary', fontFamily: 'inherit', textAlign: 'left',
              '&:hover': { color: 'text.primary' },
            }}
          >
            <ExpandMoreIcon
              sx={{ fontSize: 18, transition: 'transform 0.15s', transform: pastOpen ? 'rotate(180deg)' : 'none' }}
            />
            <Typography variant="overline" sx={{ letterSpacing: 0.6, lineHeight: 1 }}>
              {pastHeading} ({sortedPast.length})
            </Typography>
          </Box>
          <Collapse in={pastOpen} unmountOnExit>
            <Box sx={{ mt: 1, maxHeight: 360, overflowY: 'auto' }}>
              {sortedPast.map((item) => (
                <TaskRow
                  key={item.id}
                  item={item}
                  done
                  showContact={showContact}
                  todayMs={todayMs}
                  onToggle={item.kind === 'task' && onToggleDone ? handleToggle : undefined}
                  onItemClick={onItemClick}
                  renderItemActions={renderItemActions}
                  renderItemBody={renderItemBody}
                />
              ))}
            </Box>
          </Collapse>
        </Box>
      )}
    </Box>
  );
}
