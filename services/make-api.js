const NOT_AVAILABLE = new Error('Make.com integration is temporarily unavailable: services/make-api.js was lost and needs to be restored.');

function unavailable() {
  return Promise.reject(NOT_AVAILABLE);
}

module.exports = {
  listScenarios: unavailable,
  getScenario: unavailable,
  getBlueprint: unavailable,
  createScenario: unavailable,
  updateBlueprint: unavailable,
  setActive: unavailable,
  runScenario: unavailable,
  deleteScenario: unavailable,
  listFolders: unavailable,
  listTeams: unavailable,
};
