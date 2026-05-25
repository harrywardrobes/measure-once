// The Home tab has been migrated to React + MUI. See
// src/react/pages/HomePage.tsx (mount id "home-view" in
// src/react/main.tsx). This file is kept as a no-op so any lingering
// callers from legacy modules (e.g. invoices-core.js calling
// renderHomeTab() to refresh the home page after QuickBooks invoices
// reload) don't throw. The React island manages its own data fetching
// and rendering, so no further work is needed here.
function renderHomeTab() { /* no-op — see src/react/pages/HomePage.tsx */ }
function loadCalendarForHome() { /* no-op — HomePage owns its calendar fetch */ }
