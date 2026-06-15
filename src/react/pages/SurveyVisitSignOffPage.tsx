import React from 'react';
import {
  DesignVisitSignOffPage,
  SURVEY_SIGNOFF_CONFIG,
  type EmbeddedPreview,
} from './DesignVisitSignOffPage';

/**
 * Public, customer-facing survey-visit sign-off page. It reuses
 * DesignVisitSignOffPage wholesale, swapping in the survey API base path and
 * copy via SURVEY_SIGNOFF_CONFIG — the two pages are otherwise identical.
 */
export function SurveyVisitSignOffPage({ embedded }: { embedded?: EmbeddedPreview } = {}) {
  return <DesignVisitSignOffPage embedded={embedded} config={SURVEY_SIGNOFF_CONFIG} />;
}

export default SurveyVisitSignOffPage;
