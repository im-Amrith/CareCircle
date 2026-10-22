import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { SpeakerConfidence } from '../store/types.js';

const CONFIDENCES: SpeakerConfidence[] = ['high', 'low', 'unknown'];

/**
 * Dev authentication: `Authorization: Bearer dev:<userId>` picks the family member
 * (rose, sam, maya). No header means the default user, so MCP Inspector works out
 * of the box. Cognito JWT validation (AgentCore inbound auth) replaces this when
 * deployed; tools only ever read `authInfo.extra.userId`, so nothing else changes.
 *
 * A shared device also says how sure it is about who is speaking (simulated here):
 *   X-Speaker-Confidence: high | low | unknown   (missing means high)
 *   X-Speaker-Candidates: sam,maya               (with low: who the match was unsure between)
 * The server, not the model, decides what each confidence may do (mcp/identity.ts).
 */
export function devAuth(config: Config) {
  return (req: Request & { auth?: AuthInfo }, res: Response, next: NextFunction) => {
    const header = req.header('authorization');
    let userId = config.defaultUser;
    if (header) {
      const match = /^Bearer\s+dev:([a-z0-9_-]{1,64})$/i.exec(header.trim());
      if (!match) {
        res
          .status(401)
          .set('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Use Bearer dev:<userId> in dev mode"')
          .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid token' }, id: null });
        return;
      }
      userId = match[1].toLowerCase();
    }
    const confidence = (req.header('x-speaker-confidence') ?? 'high').trim().toLowerCase() as SpeakerConfidence;
    if (!CONFIDENCES.includes(confidence)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'X-Speaker-Confidence must be high, low or unknown' }, id: null });
      return;
    }
    const candidates = (req.header('x-speaker-candidates') ?? '')
      .split(',')
      .map(c => c.trim().toLowerCase())
      .filter(c => /^[a-z0-9_-]{1,64}$/.test(c))
      .slice(0, 5);
    const speaker = { confidence, candidates };
    req.auth = { token: header ?? 'anonymous-dev', clientId: 'carecircle-dev', scopes: ['care'], extra: { userId, speaker } };
    next();
  };
}

export function userOf(req: Request & { auth?: AuthInfo }): string | undefined {
  const extra = req.auth?.extra as { userId?: unknown } | undefined;
  return typeof extra?.userId === 'string' ? extra.userId : undefined;
}
