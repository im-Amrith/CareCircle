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
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 30)
  };
}

export type Clock = () => Date;

export function makeClock(fixedNow?: string): Clock {
  if (!fixedNow) return () => new Date();
  const t = Date.parse(fixedNow);
  if (Number.isNaN(t)) throw new Error(`CARECIRCLE_NOW is not a valid ISO date: ${fixedNow}`);
  return () => new Date(t);
}
