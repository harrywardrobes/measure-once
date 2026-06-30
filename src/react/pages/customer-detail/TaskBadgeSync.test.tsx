/**
 * Verifies that the task badge in the customer header stays in sync when tasks
 * are added or completed via TasksSection.
 *
 * The badge is derived live from `tasks` state in CustomerDetailPage:
 *   openTaskCount={tasks.filter(t => t.task_status !== 'completed').length}
 * and is passed down to CustomerDetailHeader as a prop.  Every mutation in
 * TasksSection calls onTasksChange (= setTasks), so the count should update
 * immediately.  These tests verify that contract end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState, useEffect } from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../hooks/usePrivilege', () => ({
  usePrivilege: vi.fn(),
}));

vi.mock('../../contexts/ConnectionToastContext', () => ({
  useConnectionToast: vi.fn(),
  // Used by the shared TaskModal that "+ Add task" now opens.
  useServiceStatuses: () => new Map(),
  openConnectModal: vi.fn(),
}));

// The shared TaskModal (opened by "+ Add task") pulls these contexts.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', first_name: 'Test', last_name: 'User' } }),
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => vi.fn(),
  // The shared TaskList (now rendered by TasksSection) reads the toast context
  // to offer an Undo after a task is ticked complete.
  useToastContext: () => ({ showToast: vi.fn(), showToastWithAction: vi.fn() }),
}));

vi.mock('../../utils/broadcastUrgencyChanged', () => ({
  broadcastUrgencyChanged: vi.fn(),
}));

vi.mock('../../utils/broadcastTaskChanged', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/broadcastTaskChanged')>();
  return { ...actual, broadcastTaskChanged: vi.fn() };
});

import { TasksSection } from './TasksSection';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useConnectionToast } from '../../contexts/ConnectionToastContext';
import type { CalendarTask } from './types';
import {
  subscribeTaskChanged,
  TASK_CHANGED_WINDOW_EVENT,
  type TaskChangedMessage,
} from '../../utils/broadcastTaskChanged';

const mockUsePrivilege    = usePrivilege    as ReturnType<typeof vi.fn>;
const mockUseConnToast    = useConnectionToast as ReturnType<typeof vi.fn>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTACT_ID = 'contact-test-42';

function makeTask(id: string, status: 'open' | 'completed' = 'open'): CalendarTask {
  return {
    id,
    task_name: `Task ${id}`,
    task_customer: { contactId: CONTACT_ID, contactName: 'Test Customer' },
    task_assigned_user: { userId: '', name: '' },
    task_deadline: new Date(Date.now() + 86400000).toISOString(),
    task_status: status,
  };
}

// ── Wrapper ───────────────────────────────────────────────────────────────────
// Mimics what CustomerDetailPage does: owns `tasks` state and derives
// openTaskCount, passing it down to whoever needs it.

function Wrapper({ initialTasks }: { initialTasks: CalendarTask[] }) {
  const [tasks, setTasks] = useState<CalendarTask[]>(initialTasks);
  const openTaskCount = tasks.filter(t => t.task_status !== 'completed').length;

  return (
    <div>
      {/* Simulates the badge in CustomerDetailHeader */}
      {openTaskCount > 0 && (
        <span data-testid="task-badge">
          {openTaskCount === 1 ? '1 open task' : `${openTaskCount} open tasks`}
        </span>
      )}

      <TasksSection
        contactId={CONTACT_ID}
        contactName="Test Contact"
        tasks={tasks}
        onTasksChange={setTasks}
      />
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubPrivilege(isViewer = false) {
  mockUsePrivilege.mockReturnValue({
    privilegeLevel: isViewer ? 'viewer' : 'manager',
    isAdmin: false,
    isManager: !isViewer,
    isViewer,
  });
}

function stubConnectionToast() {
  mockUseConnToast.mockReturnValue({ notifyApiError: vi.fn() });
}

let origFetch: typeof window.fetch;

beforeEach(() => {
  origFetch = window.fetch;
  stubPrivilege();
  stubConnectionToast();
});

afterEach(() => {
  window.fetch = origFetch;
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Task badge sync — completing a task', () => {
  it('decrements the badge count immediately when a task is toggled done', async () => {
    const user = userEvent.setup();

    window.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.match(/\/api\/tasks\//) && method === 'PATCH') {
        return new Response('{}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    render(<Wrapper initialTasks={[makeTask('t1'), makeTask('t2')]} />);

    expect(screen.getByTestId('task-badge')).toHaveTextContent('2 open tasks');

    // Click the checkbox / done button for the first task
    const doneButtons = screen.getAllByTitle(/Mark (complete|incomplete)/i);
    await user.click(doneButtons[0]);

    await waitFor(() => {
      expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');
    });
  });

  it('removes the badge entirely when the last open task is completed', async () => {
    const user = userEvent.setup();

    window.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.match(/\/api\/tasks\//) && method === 'PATCH') {
        return new Response('{}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    render(<Wrapper initialTasks={[makeTask('t1')]} />);

    expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');

    const [doneBtn] = screen.getAllByTitle(/Mark (complete|incomplete)/i);
    await user.click(doneBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('task-badge')).toBeNull();
    });
  });

  it('reverts the badge if the PATCH request fails', async () => {
    const user = userEvent.setup();

    window.fetch = vi.fn(async () => {
      return new Response('Server error', { status: 500 });
    }) as typeof fetch;

    render(<Wrapper initialTasks={[makeTask('t1')]} />);

    expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');

    const [doneBtn] = screen.getAllByTitle(/Mark (complete|incomplete)/i);
    await user.click(doneBtn);

    // Optimistic update hides badge momentarily, then reverts on error
    await waitFor(() => {
      expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');
    });
  });
});

describe('Task badge sync — adding a task', () => {
  it('shows the badge after a new task is added when none existed before', async () => {
    const user = userEvent.setup();
    const newTask = makeTask('new-1');

    window.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/tasks' && method === 'POST') {
        return new Response(JSON.stringify(newTask), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    render(<Wrapper initialTasks={[]} />);

    // No badge when no tasks
    expect(screen.queryByTestId('task-badge')).toBeNull();

    // Open the shared TaskModal and submit a new task.
    await user.click(screen.getByText('+ Add task'));
    await user.type(await screen.findByLabelText(/task name/i), 'A new task');
    await user.click(await screen.findByTestId('task-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');
    });
  });

  it('increments the badge count after a new task is added', async () => {
    const user = userEvent.setup();
    const newTask = makeTask('new-2');

    window.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/tasks' && method === 'POST') {
        return new Response(JSON.stringify(newTask), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    render(<Wrapper initialTasks={[makeTask('existing-1')]} />);

    expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');

    await user.click(screen.getByText('+ Add task'));
    await user.type(await screen.findByLabelText(/task name/i), 'Another task');
    await user.click(await screen.findByTestId('task-modal-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('task-badge')).toHaveTextContent('2 open tasks');
    });
  });
});

// ── Cross-tab wrapper ─────────────────────────────────────────────────────────
// Mimics what CustomerDetailPage does: owns tasks state + subscribes to
// task-changed broadcasts to refetch from the server.

function WrapperWithCrossTabSync({
  contactId,
  initialTasks,
}: {
  contactId: string;
  initialTasks: CalendarTask[];
}) {
  const [tasks, setTasks] = useState<CalendarTask[]>(initialTasks);
  const openTaskCount = tasks.filter(t => t.task_status !== 'completed').length;

  useEffect(() => {
    return subscribeTaskChanged(({ contactId: changedId }) => {
      if (changedId !== contactId) return;
      window
        .fetch(`/api/tasks?contactId=${contactId}`)
        .then(r => r.json() as Promise<{ results?: CalendarTask[] }>)
        .then(data => { setTasks(data.results || []); })
        .catch(() => { /* non-fatal */ });
    });
  }, [contactId]);

  return (
    <div>
      {openTaskCount > 0 && (
        <span data-testid="task-badge">
          {openTaskCount === 1 ? '1 open task' : `${openTaskCount} open tasks`}
        </span>
      )}
    </div>
  );
}

function fireCrossTabEvent(contactId: string) {
  const msg: TaskChangedMessage = { contactId, ts: Date.now() };
  window.dispatchEvent(new CustomEvent(TASK_CHANGED_WINDOW_EVENT, { detail: msg }));
}

// ── Cross-tab tests ───────────────────────────────────────────────────────────

describe('Task badge sync — cross-tab broadcast', () => {
  it('refetches tasks and updates the badge when broadcastTaskChanged fires for this contact', async () => {
    const refreshedTask = makeTask('t-refreshed');

    window.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/tasks')) {
        return new Response(
          JSON.stringify({ results: [refreshedTask] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    render(
      <WrapperWithCrossTabSync contactId={CONTACT_ID} initialTasks={[]} />,
    );

    expect(screen.queryByTestId('task-badge')).toBeNull();

    act(() => { fireCrossTabEvent(CONTACT_ID); });

    await waitFor(() => {
      expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');
    });
  });

  it('ignores broadcasts for a different contact', async () => {
    window.fetch = vi.fn() as typeof fetch;

    render(
      <WrapperWithCrossTabSync contactId={CONTACT_ID} initialTasks={[makeTask('t1')]} />,
    );

    expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');

    act(() => { fireCrossTabEvent('some-other-contact'); });

    // fetch must not have been called
    expect(window.fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('task-badge')).toHaveTextContent('1 open task');
  });

  it('keeps the existing badge if the refetch fails', async () => {
    window.fetch = vi.fn(async () =>
      new Response('Server error', { status: 500 }),
    ) as typeof fetch;

    render(
      <WrapperWithCrossTabSync
        contactId={CONTACT_ID}
        initialTasks={[makeTask('t1'), makeTask('t2')]}
      />,
    );

    expect(screen.getByTestId('task-badge')).toHaveTextContent('2 open tasks');

    act(() => { fireCrossTabEvent(CONTACT_ID); });

    // After a failed fetch the badge must remain unchanged
    await waitFor(() => {
      expect(screen.getByTestId('task-badge')).toHaveTextContent('2 open tasks');
    });
    // The fetch was attempted
    expect(window.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Task badge sync — badge not shown for already-completed tasks', () => {
  it('does not show a badge when all initial tasks are already completed', () => {
    render(
      <Wrapper
        initialTasks={[makeTask('c1', 'completed'), makeTask('c2', 'completed')]}
      />,
    );
    expect(screen.queryByTestId('task-badge')).toBeNull();
  });

  it('shows the correct count when some initial tasks are already completed', () => {
    render(
      <Wrapper
        initialTasks={[
          makeTask('o1', 'open'),
          makeTask('c1', 'completed'),
          makeTask('o2', 'open'),
        ]}
      />,
    );
    expect(screen.getByTestId('task-badge')).toHaveTextContent('2 open tasks');
  });
});
