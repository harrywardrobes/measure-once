// ── Survey page — data-loading shim for the React SurveyBoardPage component ───
// Rendering is handled by src/react/pages/SurveyBoardPage.tsx.
// This file only wires up the data-loading hooks so core.js bootstraps and
// refreshes the correct data for the survey board.

registerOpenLeadsLoader(loadAllContacts);

registerCustomerListRenderer(function surveyBoardNotifyReact() {
  document.dispatchEvent(new CustomEvent('survey-board-data-ready'));
});

document.addEventListener('localdata-updated', async () => {
  await Promise.all([loadAllContacts(), loadWorkflowStages()]);
  state.filteredContacts = [...state.contacts];
  document.dispatchEvent(new CustomEvent('survey-board-data-ready'));
});
