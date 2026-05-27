import type { Request, Response } from 'express';

import {
  SUPERVISOR_READ_REQUIRED_CAPABILITIES,
  supervisorActionRequiredCapabilities,
  type SupervisorActionError,
  type SupervisorActionType,
} from '../shared/supervisor-actions.js';
import type { SessionSummary } from './types.js';
import {
  actorFromRequestBody,
  capabilitiesDecisionFromRequest,
  capabilityError,
  errorStatus as sessionControlErrorStatus,
  type ControlCapabilityDecision,
} from './session-control-api.js';
import {
  executeSupervisorAction,
  listSupervisorSessions,
  type SupervisorActionSessionBoundary,
} from './supervisor-actions.js';

export interface SupervisorSessionsBoundary {
  list(): SessionSummary[];
}

function supervisorActionError(
  reasonCode: SupervisorActionError['reasonCode'],
  message: string,
  details?: Record<string, unknown>
): SupervisorActionError {
  return {
    code: 'INVALID_ARGUMENT',
    reasonCode,
    message,
    retryable: false,
    ...(details ? { details } : {}),
  };
}

function supervisorActionErrorStatus(error: SupervisorActionError): number {
  switch (error.code) {
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'INVALID_ARGUMENT':
      return 400;
    default:
      return 409;
  }
}

function actionFromParam(
  actionParam: string | undefined
): SupervisorActionType | undefined {
  return actionParam === 'sendText' || actionParam === 'submit'
    ? actionParam
    : undefined;
}

function requestBody(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function validateSupervisorActionTargets(
  body: Record<string, unknown>
):
  | { ok: true; targetIds: string[] }
  | { ok: false; error: SupervisorActionError } {
  const id = body['id'];
  const targetIds = body['targetIds'];
  const hasIdField = id !== undefined;
  const hasTargetIdsField = targetIds !== undefined;

  if (hasIdField && hasTargetIdsField) {
    return {
      ok: false,
      error: supervisorActionError(
        'TARGET_SELECTOR_INVALID',
        'exactly one of id or targetIds is required',
        { field: 'id' }
      ),
    };
  }

  if (!hasIdField && !hasTargetIdsField) {
    return {
      ok: false,
      error: supervisorActionError(
        'TARGET_SELECTOR_REQUIRED',
        'exactly one of id or targetIds is required',
        { field: 'id' }
      ),
    };
  }

  if (hasIdField) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return {
        ok: false,
        error: supervisorActionError(
          'TARGET_SELECTOR_INVALID',
          'id must be a non-empty session id',
          { field: 'id' }
        ),
      };
    }
    return { ok: true, targetIds: [id.trim()] };
  }

  if (!Array.isArray(targetIds)) {
    return {
      ok: false,
      error: supervisorActionError(
        'TARGET_SELECTOR_INVALID',
        'targetIds must be a non-empty list of session ids',
        { field: 'targetIds' }
      ),
    };
  }

  if (
    targetIds.length === 0 ||
    !targetIds.every(
      (entry) => typeof entry === 'string' && entry.trim().length > 0
    )
  ) {
    return {
      ok: false,
      error: supervisorActionError(
        'TARGET_SELECTOR_INVALID',
        'targetIds must be a non-empty list of session ids',
        { field: 'targetIds' }
      ),
    };
  }

  return { ok: true, targetIds: targetIds.map((entry) => entry.trim()) };
}

function missingCapabilityEvidenceDecision(
  capability: ControlCapabilityDecision['capability']
): ControlCapabilityDecision {
  return {
    decision: 'deny',
    capability,
    placeholder: true,
    reasonCode: 'CAPABILITY_REQUIRED',
    message: 'missing required supervisor action capability evidence',
  };
}

function supervisorActionCapabilitiesDecision(
  req: Request,
  action: SupervisorActionType
): ControlCapabilityDecision {
  const capabilities = supervisorActionRequiredCapabilities(action);
  const header = req.header('x-relay-capabilities') ?? undefined;
  if (header === undefined || header.trim().length === 0) {
    const highRiskCapability =
      action === 'submit'
        ? 'tab:intervention:submit'
        : 'tab:intervention:send-text';
    return missingCapabilityEvidenceDecision(highRiskCapability);
  }
  return capabilitiesDecisionFromRequest(req, capabilities);
}

export function handleSupervisorSessionsRequest(
  req: Request,
  res: Response,
  sessions: SupervisorSessionsBoundary
): void {
  const decision = capabilitiesDecisionFromRequest(
    req,
    SUPERVISOR_READ_REQUIRED_CAPABILITIES
  );
  if (decision.decision !== 'allow') {
    const error = capabilityError(decision);
    res.status(sessionControlErrorStatus(error)).json({ error });
    return;
  }
  res.json(listSupervisorSessions(sessions.list()));
}

export function handleSupervisorActionRequest(
  req: Request,
  res: Response,
  sessions: SupervisorActionSessionBoundary
): void {
  const action = actionFromParam(req.params['action']);
  if (!action) {
    const error = supervisorActionError(
      'TARGET_SELECTOR_INVALID',
      'supervisor action must be sendText or submit',
      { field: 'action' }
    );
    res.status(supervisorActionErrorStatus(error)).json({ error });
    return;
  }

  const body = requestBody(req);
  const targets = validateSupervisorActionTargets(body);
  if (targets.ok === false) {
    const error = targets.error;
    res.status(supervisorActionErrorStatus(error)).json({ error });
    return;
  }

  const decision = supervisorActionCapabilitiesDecision(req, action);
  if (decision.decision !== 'allow') {
    const error = capabilityError(decision);
    res.status(sessionControlErrorStatus(error)).json({ error });
    return;
  }

  const actor = actorFromRequestBody(body['actor']);
  const result = executeSupervisorAction({
    boundary: sessions,
    action,
    targetIds: targets.targetIds,
    text: body['text'],
    ...(actor === undefined ? {} : { actor }),
  });
  res.json(result);
}
