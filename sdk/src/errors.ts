import { GATEHOOK_ERROR_MESSAGES } from './generated/errorMessages.ts';

/**
 * Message for a Gatehook program error code. Unlike the generated
 * `getGatehookErrorMessage`, works in production bundles.
 */
export function getComplianceErrorMessage(code: number): string {
  return GATEHOOK_ERROR_MESSAGES[code] ?? `Unknown Gatehook error ${code}`;
}

export { GATEHOOK_ERROR_MESSAGES };
