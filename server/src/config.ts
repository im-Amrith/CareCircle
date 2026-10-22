import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Only dev auth exists so far; Cognito JWT validation is added for the AWS deployment. */
export type AuthMode = 'dev';

export interface Config {
  host: string;
  port: number;
  /** Hostnames allowed in the Host header when binding to a non-localhost address */
  allowedHosts?: string[];
  /** Origin hostnames allowed for browser clients (e.g. the simulator) */
  allowedOrigins?: string[];
  seedPath: string;
  /**
   * dev: `Authorization: Bearer dev:<userId>` selects the user; no header = defaultUser.
   * Cognito JWT validation replaces this for AWS deployments.
   */
  authMode: AuthMode;
  defaultUser: string;
  /** Freeze the clock for demos and tests (ISO instant) */
  fixedNow?: string;
  sessionIdleMinutes: number;
  /** Public base URL for checkout links, e.g. https://carecircle.example.com. Defaults to the request's origin. */
  publicUrl?: string;
  /** Amazon SNS topic for the evening summary (family members subscribe by email or SMS). Unset = in-app inbox only. */
  snsTopicArn?: string;
  awsRegion?: string;
  /** Family-local HH:MM to send the evening summary; DIGEST_TIME=off disables the scheduler. */
  digestTime?: string;
  /** The orchestrator's care team endpoint (Strands Graph) for appointment planning. Unset = plan locally. */
  plannerUrl?: string;
}

function list(v: string | undefined): string[] | undefined {
  const items = v?.split(',').map(s => s.trim()).filter(Boolean);
  return items && items.length ? items : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8000),
    allowedHosts: list(env.ALLOWED_HOSTS),
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    seedPath: env.CARECIRCLE_SEED ?? resolve(here, '../../seed/rose.json'),
    authMode: 'dev',
    defaultUser: env.CARECIRCLE_DEFAULT_USER ?? 'sam',
    fixedNow: env.CARECIRCLE_NOW || undefined,
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 30),
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    snsTopicArn: env.SNS_TOPIC_ARN || undefined,
    awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
    plannerUrl: env.CARECIRCLE_PLANNER_URL || undefined,
    digestTime: env.DIGEST_TIME === 'off' ? undefined : /^\d{2}:\d{2}$/.test(env.DIGEST_TIME ?? '') ? env.DIGEST_TIME : '20:30'
  };
}

/** A frozen demo clock can be moved forward ("skip ahead 30 minutes"); a real one can't. */
export type Clock = (() => Date) & { advance?: (ms: number) => Date };

export function makeClock(fixedNow?: string): Clock {
  if (!fixedNow) return () => new Date();
  let t = Date.parse(fixedNow);
  if (Number.isNaN(t)) throw new Error(`CARECIRCLE_NOW is not a valid ISO date: ${fixedNow}`);
  const clock: Clock = () => new Date(t);
  clock.advance = ms => {
    t += Math.max(0, ms);
    return new Date(t);
  };
  return clock;
}
