export type NotificationType =
  | 'territory_captured'
  | 'territory_lost'
  | 'territory_expired'
  /** The user reached a new XP level (ADR-033). Payload: { level, xp, dedupe_key }. */
  | 'xp.level_up';

export interface NotificationEvent {
  id: string;
  user_id: string;
  type: NotificationType;
  source_module: 'run_module';
  occurred_at: string;
  payload: Record<string, unknown>;
}
