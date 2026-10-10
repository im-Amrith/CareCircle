import { loadConfig, makeClock } from './config.js';
import { buildSeededStore, readSeedFile } from './store/seed.js';
import { createHttpApp } from './http/app.js';
import { SERVER_NAME, SERVER_VERSION } from './mcp/server.js';

const config = loadConfig();
const clock = makeClock(config.fixedNow);
const store = buildSeededStore(readSeedFile(config.seedPath), clock());
const { app, close } = createHttpApp(config, { store, clock, defaultUser: config.defaultUser });

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`${SERVER_NAME} ${SERVER_VERSION} listening on http://${config.host}:${config.port}/mcp`);
  console.log(`Auth: dev mode. Default user "${config.defaultUser}"; send "Authorization: Bearer dev:rose|sam|maya" to switch.`);
  if (config.fixedNow) console.log(`Clock frozen at ${config.fixedNow}`);
});

const shutdown = async () => {
  await close();
  httpServer.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
