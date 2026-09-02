/**
 * Legacy compatibility module.
 *
 * Authentication is now delegated to 분석기.py. This file intentionally has
 * no Kakao client imports and performs no authentication monkey-patching.
 */
export function analyzerAuthMode(): 'PYTHON_ANALYZER' {
  return 'PYTHON_ANALYZER';
}
