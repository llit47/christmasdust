import { GameDig } from 'gamedig';
export function gameQuery(config, query = GameDig.query.bind(GameDig)) {
  return server => query({ type: 'counterstrike16', host: server.ip, port: server.port,
    givenPortOnly: true, maxAttempts: 1, socketTimeout: Math.max(250, config.queryTimeout - 250),
    attemptTimeout: config.queryTimeout, requestPlayers: false, requestRules: false });
}
