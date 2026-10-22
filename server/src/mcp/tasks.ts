/**
 * MCP Tasks (spec 2025-11-25, experimental) for long-running tools.
 *
 * @modelcontextprotocol/server 2.3.1 ships the task wire schemas but no task runtime:
 * `setRequestHandler` won't take the `tasks/*` names in its typed form, and McpServer's
 * `tools/call` handler validates every result as a CallToolResult. So CareCircle keeps
 * its own small runtime (see friction log FL-13):
 *
 * - `tools/call` with a `task` param, for a tool registered here, returns a
 *   CreateTaskResult at once and runs the work in the background.
 * - `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel` are registered with
 *   explicit schemas, which the SDK allows for the Tasks extension names.
 * - Every status change is sent as `notifications/tasks/status` to the session that
 *   created the task.
 * - When the work needs the person (status `input_required`), the question is asked as
 *   an elicitation on the client's `tasks/result` request, with related-task metadata.
 *
 * Tasks belong to the member who created them; anyone else gets "task not found".
 */
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { ProtocolError, ProtocolErrorCode, RELATED_TASK_META_KEY, type CallToolResult, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { userIdFrom, type Deps } from './context.js';

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** The Task object as it goes on the wire. */
export interface WireTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number;
  pollInterval: number;
}

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];
export const DEFAULT_TTL_MS = 10 * 60_000;
export const MAX_TTL_MS = 30 * 60_000;
export const POLL_INTERVAL_MS = 1000;

/** Thrown into the work when the task is cancelled while it waits for the person. */
export class TaskCancelled extends Error {
  constructor() {
    super('Task cancelled');
  }
}

interface PendingInput {
  ask: (ctx: ServerContext) => Promise<unknown>;
  started: boolean;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface TaskRecord {
  task: WireTask;
  ownerId: string;
  result?: CallToolResult;
  pending?: PendingInput;
  abort: AbortController;
  /** Resolves (and is replaced) on every change, so waiters wake up. */
  changed: { promise: Promise<void>; resolve: () => void };
  notify: (task: WireTask) => void;
  expiry?: ReturnType<typeof setTimeout>;
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
}

/** What a task's work sees: status updates, the person's input, cancellation. */
export interface TaskHandle {
  readonly taskId: string;
  readonly signal: AbortSignal;
  status(message: string): void;
  /**
   * Moves to input_required and waits until the client's `tasks/result` request
   * has asked the person. `ask` runs with that request's context.
   * Rejects with TaskCancelled if the task is cancelled first.
   */
  input<T>(message: string, ask: (ctx: ServerContext) => Promise<T>): Promise<T>;
}

/** All tasks on this server, shared by every session. */
export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>();

  start(ownerId: string, ttl: number | undefined, notify: (task: WireTask) => void, work: (handle: TaskHandle) => Promise<CallToolResult>): WireTask {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      task: {
        taskId: randomUUID(),
        status: 'working',
        createdAt: now,
        lastUpdatedAt: now,
        ttl: Math.min(Math.max(ttl ?? DEFAULT_TTL_MS, 1000), MAX_TTL_MS),
        pollInterval: POLL_INTERVAL_MS
      },
      ownerId,
      abort: new AbortController(),
      changed: signal(),
      notify
    };
    this.tasks.set(record.task.taskId, record);
    record.expiry = setTimeout(() => this.expire(record), record.task.ttl);
    record.expiry.unref?.();

    const handle: TaskHandle = {
      taskId: record.task.taskId,
      signal: record.abort.signal,
      status: message => this.update(record, { status: 'working', statusMessage: message }),
      input: <T>(message: string, ask: (ctx: ServerContext) => Promise<T>) =>
        new Promise<T>((resolve, reject) => {
          if (record.abort.signal.aborted) return reject(new TaskCancelled());
          record.pending = { ask, started: false, resolve: v => resolve(v as T), reject };
          this.update(record, { status: 'input_required', statusMessage: message });
        })
    };

    // Start on the next tick so the CreateTaskResult goes out before the first status notification.
    setImmediate(() => {
      work(handle).then(
        result => this.finish(record, result.isError ? 'failed' : 'completed', result),
        err => {
          if (err instanceof TaskCancelled || record.task.status === 'cancelled') return;
          console.error('[carecircle] task failed', err);
          this.finish(record, 'failed', {
            content: [{ type: 'text', text: "Something went wrong on CareCircle's side. Nothing was booked." }],
            isError: true
          });
        }
      );
    });
    return { ...record.task };
  }

  /** The caller's own task, or undefined. */
  get(taskId: string, ownerId: string): TaskRecord | undefined {
    const record = this.tasks.get(taskId);
    return record && record.ownerId === ownerId ? record : undefined;
  }

  list(ownerId: string): WireTask[] {
    return [...this.tasks.values()].filter(r => r.ownerId === ownerId).map(r => ({ ...r.task }));
  }

  cancel(record: TaskRecord): void {
    if (TERMINAL.includes(record.task.status)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task ${record.task.taskId} is already ${record.task.status}`);
    }
    record.abort.abort();
    record.pending?.reject(new TaskCancelled());
    record.pending = undefined;
    this.finish(record, 'cancelled', {
      content: [{ type: 'text', text: 'Cancelled. Nothing was booked.' }],
      isError: true
    });
  }

  /** Waits for the task to finish, asking the person for input when the work needs it. */
  async result(record: TaskRecord, ctx: ServerContext): Promise<CallToolResult> {
    while (!TERMINAL.includes(record.task.status)) {
      const pending = record.pending;
      if (pending && !pending.started) {
        pending.started = true;
        try {
          const value = await pending.ask(ctx);
          if (record.pending === pending) {
            record.pending = undefined;
            this.update(record, { status: 'working', statusMessage: 'Booking…' });
            pending.resolve(value);
          }
        } catch (err) {
          if (record.pending === pending) {
            record.pending = undefined;
            pending.reject(err);
          }
        }
        continue;
      }
      await record.changed.promise;
    }
    const result = record.result!;
    return { ...result, _meta: { ...result._meta, [RELATED_TASK_META_KEY]: { taskId: record.task.taskId } } };
  }

  private update(record: TaskRecord, patch: Partial<WireTask>): void {
    if (TERMINAL.includes(record.task.status)) return;
    Object.assign(record.task, patch, { lastUpdatedAt: new Date().toISOString() });
    if (!patch.statusMessage) delete record.task.statusMessage;
    const { resolve } = record.changed;
    record.changed = signal();
    resolve();
    try {
      record.notify({ ...record.task });
    } catch {
      // The session may be gone; tasks/get still works.
    }
  }

  private finish(record: TaskRecord, status: TaskStatus, result: CallToolResult): void {
    if (TERMINAL.includes(record.task.status)) return;
    record.result = result;
    const text = result.content?.find(c => c.type === 'text');
    this.update(record, { status, statusMessage: text && 'text' in text ? text.text : undefined });
  }

  private expire(record: TaskRecord): void {
    if (!TERMINAL.includes(record.task.status)) {
      record.abort.abort();
      record.pending?.reject(new TaskCancelled());
    }
    this.tasks.delete(record.task.taskId);
  }
}

/** Runs a tool's work as a task. Arguments are already validated. */
export type TaskTool = (args: Record<string, unknown>, ctx: ServerContext, handle: TaskHandle) => Promise<CallToolResult>;

const TaskIdParams = z.object({ taskId: z.string() }).passthrough();
const ListParams = z.object({ cursor: z.string().optional() }).passthrough();

/**
 * Installs the tasks/* handlers and routes task-augmented `tools/call` requests for
 * `taskTools` to the registry. Call after the tools are registered.
 */
export function installTasks(server: McpServer, deps: Deps, taskTools: Record<string, { parse: (args: unknown) => Record<string, unknown>; run: TaskTool }>): void {
  const registry = (deps.tasks ??= new TaskRegistry());
  const owner = (ctx: ServerContext) => userIdFrom(ctx, deps);
  const find = (taskId: string, ctx: ServerContext) => {
    const record = registry.get(taskId, owner(ctx));
    if (!record) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task ${taskId} not found`);
    return record;
  };
  const notify = (task: WireTask) => {
    // The typed notification() surface leaves out the task vocabulary (FL-13), so send it as a plain notification.
    void (server.server.notification as (n: { method: string; params: object }) => Promise<void>)({ method: 'notifications/tasks/status', params: task }).catch(() => undefined);
  };

  // McpServer owns tools/call. Wrap the stored handler: task-augmented calls to our
  // task tools short-circuit here; everything else goes through unchanged.
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (req: { params?: any }, ctx: ServerContext) => Promise<unknown>> })._requestHandlers;
  const toolsCall = handlers.get('tools/call');
  if (!toolsCall) throw new Error('installTasks: register tools first');
  handlers.set('tools/call', async (request, ctx) => {
    const params = request.params as { name?: string; arguments?: unknown; task?: { ttl?: number } } | undefined;
    const tool = params?.name ? taskTools[params.name] : undefined;
    if (!params?.task || !tool) return toolsCall(request, ctx);
    let args: Record<string, unknown>;
    try {
      args = tool.parse(params.arguments ?? {});
    } catch (err) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for tool ${params.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const task = registry.start(owner(ctx), params.task.ttl, notify, handle => tool.run(args, ctx, handle));
    return { task };
  });

  server.server.setRequestHandler('tasks/get', { params: TaskIdParams }, async (params, ctx) => ({ ...find(params.taskId, ctx as ServerContext).task }));
  server.server.setRequestHandler('tasks/result', { params: TaskIdParams }, async (params, ctx) =>
    registry.result(find(params.taskId, ctx as ServerContext), ctx as ServerContext)
  );
  server.server.setRequestHandler('tasks/cancel', { params: TaskIdParams }, async (params, ctx) => {
    const record = find(params.taskId, ctx as ServerContext);
    registry.cancel(record);
    return { ...record.task };
  });
  server.server.setRequestHandler('tasks/list', { params: ListParams }, async (_params, ctx) => ({ tasks: registry.list(owner(ctx as ServerContext)) }));
}

export const TASKS_CAPABILITY = { list: {}, cancel: {}, requests: { tools: { call: {} } } };
