import type { Run } from '../shared/types.js';

/** Only a receipt for the selected checkpoint and contract can authorize completion or cleanup. */
export function deliveryMatches(run: Run): boolean {
  return !!run.checkpoint && !!run.delivery && run.delivery.checkpoint === run.checkpoint
    && run.delivery.contractVersion === run.contract.version && run.delivery.slot === run.selectedSlot;
}

export function delivered(run: Run): boolean {
  return deliveryMatches(run) && run.delivery?.status === 'succeeded';
}
