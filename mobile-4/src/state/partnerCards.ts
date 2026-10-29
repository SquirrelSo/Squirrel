/**
 * Cards the board and request lists have shown, by card_id. Exercise has no route for a single card,
 * so the buddy screen reads the card it was opened with from here (and, opened cold, finds it again
 * in the lists). card_id is per viewer and only ever sent back to Exercise.
 */
import type { BoardCard, PartnerCard } from '@/api/partnerHunt';

const cards = new Map<string, PartnerCard | BoardCard>();
export const rememberCards = (list: (PartnerCard | BoardCard)[]) => list.forEach((c) => cards.set(c.card_id, c));
export const cardFor = (cardId: string) => cards.get(cardId) ?? null;
export const forgetCard = (cardId: string) => cards.delete(cardId);
