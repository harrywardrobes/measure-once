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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../hooks/usePrivilege', () => ({
  usePrivilege: vi.fn(),
}));

vi.mock('../../context/ConnectionToastContext', () => ({
  useConnectionToast: vi.fn(),
}));

vi.mock('../../utils/broadcastUrgencyChanged', () => ({
  broadcastUrgencyChanged: vi.fn(),
}));

vi.mock('../../utils/broadcastTaskChanged', () => ({
  broadcastTaskChanged: vi.fn(),
}));

import { TasksSection } from './TasksSection';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useConnectionToast } from '../../context/ConnectionToastContext';
import type { CalendarTask } from './types';

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

    // Open the add-task form and submit
    await user.click(screen.getByText('+ Add task'));
    await user.type(screen.getByPlaceholderText('Task description...'), 'A new task');
    await user.click(screen.getByText('Save task'));

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
    await user.type(screen.getByPlaceholderText('Task description...'), 'Another task');
    await user.click(screen.getByText('Save task'));

    await waitFor(() => {
      expect(screen.getByTestId('task-badge')).toHaveTextContent('2 open tasks');
    });
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
