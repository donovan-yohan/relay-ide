import type { Request, Response } from 'express';

import { SUPERVISOR_READ_REQUIRED_CAPABILITIES } from '../shared/supervisor-actions.js';
import type { SessionSummary } from './types.js';
import {
  capabilitiesDecisionFromRequest,
  capabilityError,
  errorStatus as sessionControlErrorStatus,
} from './session-control-api.js';
import { listSupervisorSessions } from './supervisor-actions.js';

export interface SupervisorSessionsBoundary {
  list(): SessionSummary[];
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
