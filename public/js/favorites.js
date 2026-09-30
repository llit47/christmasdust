export function favoriteEndpoints(server) {
  return [server.id, ...(Array.isArray(server.duplicateEndpoints) ? server.duplicateEndpoints : [])];
}

export function isFavorite(server, favoriteIds) {
  return favoriteEndpoints(server).some(id => favoriteIds.has(id));
}

export function toggleServerFavorite(server, favoriteIds) {
  const endpoints = favoriteEndpoints(server);
  if (endpoints.some(id => favoriteIds.has(id))) {
    for (const id of endpoints) favoriteIds.delete(id);
  } else favoriteIds.add(server.id);
}
