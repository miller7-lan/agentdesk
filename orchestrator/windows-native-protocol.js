const VERSION = 1;
const providers = new Set(['codex', 'claude']);
const projectOperations = new Set(['project.acquire', 'project.status', 'project.suspend', 'project.reconcile', 'project.release']);
const shellOperations = new Set(['local_shell.run', 'local_shell.status', 'local_shell.stop', 'local_shell.list']);
const mountOperations = new Set(['project.mount', 'project.mountStatus', 'project.unmount']);
const events = new Set(['project.leaseChanged', 'project.mountChanged', 'local_shell.output', 'local_shell.stateChanged', 'project.reconcileRequired']);
const validId = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 160 &&
  /^[a-z0-9][a-z0-9_.:-]*$/i.test(value);
const validLease = (value) => typeof value === 'string' && /^[a-z0-9_-]{43}$/i.test(value);

const messages = {
  INVALID_REQUEST: '请求格式或协议版本无效。',
  AUTH_DENIED: '当前设备或会话没有这项权限。',
  PROJECT_NOT_FOUND: '找不到此会话绑定的项目。',
  LEASE_BUSY: '此项目已有写入会话。',
  LEASE_EXPIRED: '租约已失效，请重新获取当前状态。',
  LEASE_SUSPENDED: '租约已暂停，需核对后恢复。',
  MOUNT_UNAVAILABLE: '本机项目挂载尚未就绪。',
  MOUNT_DISCONNECTED: '项目挂载连接中断。',
  FILE_CONFLICT: '文件内容或版本发生变化。',
  WRITE_OUTCOME_UNKNOWN: '写入结果尚未确认，请核对本机状态。',
  COMMAND_CONFLICT: '该请求编号已用于不同命令。',
  COMMAND_STATUS_UNKNOWN: '无法确认原命令的结果，请核对运行记录。',
  BRIDGE_DISCONNECTED: '无法连接本机 Bridge。',
  RECONCILE_REQUIRED: '须核对旧会话的副作用后再继续。',
  TIMEOUT: '等待结果超时，请查询原请求。',
  UNSUPPORTED_OPERATION: '此端尚未接入该操作。',
};
const failureCodes = {
  native_chat_lease_denied: 'AUTH_DENIED',
  native_chat_read_only: 'AUTH_DENIED',
  native_chat_already_bound: 'AUTH_DENIED',
  invalid_native_chat_project: 'PROJECT_NOT_FOUND',
  native_project_writer_busy: 'LEASE_BUSY',
  native_chat_lease_expired: 'LEASE_EXPIRED',
  native_chat_lease_suspended: 'LEASE_SUSPENDED',
  native_chat_reconcile_required: 'RECONCILE_REQUIRED',
  native_project_mount_exists: 'MOUNT_UNAVAILABLE',
  project_mount_timeout: 'TIMEOUT',
  project_mount_disconnected: 'MOUNT_DISCONNECTED',
  project_mount_failed: 'MOUNT_UNAVAILABLE',
  project_file_changed: 'FILE_CONFLICT',
  project_write_outcome_unknown: 'WRITE_OUTCOME_UNKNOWN',
  windows_chat_worker_disconnected: 'BRIDGE_DISCONNECTED',
  windows_chat_worker_timeout: 'TIMEOUT',
  command_run_conflict: 'COMMAND_CONFLICT',
  command_status_unknown: 'COMMAND_STATUS_UNKNOWN',
};
const retryable = new Set(['LEASE_BUSY', 'LEASE_EXPIRED', 'LEASE_SUSPENDED', 'MOUNT_UNAVAILABLE', 'MOUNT_DISCONNECTED',
  'BRIDGE_DISCONNECTED', 'RECONCILE_REQUIRED', 'TIMEOUT']);

function problem(code) { return Object.assign(new Error(messages[code]), { protocolCode: code }); }

function errorResponse(error, requestId) {
  const key = String(error?.message || '').split(':')[0];
  const code = Object.hasOwn(messages, error?.protocolCode) ? error.protocolCode : failureCodes[key] ||
    (key.startsWith('invalid_') ? 'INVALID_REQUEST' : 'BRIDGE_DISCONNECTED');
  return { protocolVersion: VERSION, requestId, ok: false,
    error: { code, message: messages[code], retryable: retryable.has(code), requestId } };
}

function leaseView(projectId, accessMode, value) {
  return { leaseId: value.id, projectId, accessMode, state: value.state, generation: value.generation,
    createdAt: value.createdAt, ...(value.unknownFiles && { unknownFiles: true }) };
}

// The transport supplies context after authenticating and binding a device, project and official thread.
// A request can repeat those identifiers for correlation; supplying them cannot create authority.
function makeProtocol({ leases, shell, mount }) {
  return async (request, context) => {
    const requestId = validId(request?.requestId) ? request.requestId : null;
    try {
      if (request?.protocolVersion !== VERSION || !requestId || typeof request.operation !== 'string' ||
          ['projectRoot', 'mountPath', 'fullAccess'].some((key) => Object.hasOwn(request, key))) throw problem('INVALID_REQUEST');
      if (!context || !providers.has(context.provider) || !validId(context.deviceId) ||
          !validId(context.threadId) || !validId(context.projectId) || !['read', 'write'].includes(context.accessMode)) throw problem('AUTH_DENIED');
      for (const key of ['deviceId', 'provider', 'threadId', 'projectId', 'accessMode']) {
        if (request[key] !== undefined && request[key] !== context[key]) throw problem('AUTH_DENIED');
      }
      const { deviceId, provider, threadId, projectId, projectRoot, accessMode } = context;
      if (!projectRoot) throw problem('PROJECT_NOT_FOUND');
      const { operation } = request;
      let value;
      const identity = { device: deviceId, provider, threadId, projectId, root: projectRoot, fullAccess: accessMode === 'write' };
      if (operation === 'project.acquire') value = leaseView(projectId, accessMode, await leases.acquire(identity));
      else {
        if (![projectOperations, mountOperations, shellOperations].some((group) => group.has(operation))) throw problem('UNSUPPORTED_OPERATION');
        if (!validLease(request.leaseId) || !Number.isSafeInteger(request.generation) || request.generation < 1) throw problem('INVALID_REQUEST');
        const binding = { ...identity, id: request.leaseId, generation: request.generation };
        const allowed = leases.get(binding, { allowSuspended: true, current: true });
        if (allowed.fullAccess !== identity.fullAccess || allowed.directory.toLowerCase() !== context.projectRoot.toLowerCase()) throw problem('AUTH_DENIED');
        if (allowed.suspended && (operation === 'project.mount' || operation === 'local_shell.run')) throw problem('LEASE_SUSPENDED');
        if (operation === 'project.status') value = leaseView(projectId, accessMode, leases.view(allowed));
        else if (operation === 'project.suspend') value = leaseView(projectId, accessMode, leases.suspend(binding));
        else if (operation === 'project.reconcile' || operation === 'project.release') {
          const release = operation === 'project.release';
          // Only a trusted local UI may include this acknowledgement in the session context.
          const recovered = await leases.settle(binding, (lease) => shell.canResume(lease, { acknowledgeUnknown: context.unknownReviewed === true }), {
            release, acknowledgeFiles: context.unknownReviewed === true,
          });
          if (!recovered) throw problem('RECONCILE_REQUIRED');
          value = release ? { leaseId: binding.id, projectId, state: 'released', generation: binding.generation }
            : leaseView(projectId, accessMode, leases.view(allowed));
        } else if (mountOperations.has(operation)) {
          if (!mount) throw problem('MOUNT_UNAVAILABLE');
          value = await mount(operation, binding, request, context);
        } else {
          const action = operation.split('.')[1];
          value = await shell.call(binding, { ...request.args, action }, { requestId });
          if (value.state === 'unknown') throw problem('COMMAND_STATUS_UNKNOWN');
        }
      }
      return { protocolVersion: VERSION, requestId, ok: true, value };
    } catch (error) { return errorResponse(error, requestId); }
  };
}

function eventEnvelope(event, context, sequence, value) {
  if (!events.has(event) || !Number.isSafeInteger(sequence) || sequence < 1) throw problem('INVALID_REQUEST');
  const { deviceId, threadId, projectId } = context;
  return { protocolVersion: VERSION, event, deviceId, threadId, projectId, sequence, timestamp: new Date().toISOString(), value };
}

module.exports = { VERSION, makeProtocol, errorResponse, eventEnvelope };
